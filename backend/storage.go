package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Path layout: blobs/<sha256-hex> for content-addressed originals;
// previews/<sha256-hex> for derived previews keyed by the original's hash;
// "photos/<id>" entries from before content-addressing remain readable
// through openByPath until migrateLegacyBlobs rewrites them.
const (
	blobDir    = "blobs"
	previewDir = "previews"
)

var blobHashRegexp = regexp.MustCompile(`^[0-9a-f]{64}$`)
var errPayloadTooLarge = errors.New("payload too large")

// blobStore abstracts blob storage so the backend can run against either a
// local disk root (dev, and prod absent STORAGE_BUCKET) or a GCS bucket.
// Paths returned by writeBlob are stored verbatim in photos.blob_path, so
// view-mode clients can resolve them against any base URL.
type blobStore interface {
	// writeBlob streams up to maxBytes through SHA-256 and stores the bytes
	// at blobs/<hash>. Identical bytes converge on the same path. Returns
	// errPayloadTooLarge if more than maxBytes are read.
	writeBlob(r io.Reader, maxBytes int64) (path string, n int64, err error)
	// writePreview stores preview bytes at previews/<hash>, where hash is
	// the SHA-256 of the *source* blob (not of the preview bytes).
	writePreview(hash string, r io.Reader) error
	// openByHash opens the content-addressed original at blobs/<hash>.
	openByHash(hash string) (blobReader, error)
	// openPreviewByHash opens previews/<hash>, or returns os.ErrNotExist if
	// the preview has not been generated yet.
	openPreviewByHash(hash string) (blobReader, error)
	// openByPath opens a blob by its stored relative path. Accepts the
	// content-addressed "blobs/<hash>" and the legacy "photos/<id>" forms;
	// anything else is rejected as not-exist (path-traversal defense).
	openByPath(blobPath string) (blobReader, error)
	// rewriteLegacyPath reads the bytes at a "photos/<id>" location,
	// hashes them, and moves the object to "blobs/<hash>". Returns the new
	// relative path. Used once at startup by migrateLegacyBlobs.
	rewriteLegacyPath(oldPath string) (newPath string, err error)
}

// blobReader is the surface http handlers need from an open blob: a seekable
// byte stream for http.ServeContent, plus a last-modified timestamp for the
// response header. Each impl captures mtime at open time so callers see one
// method instead of an extra Stat() roundtrip.
type blobReader interface {
	io.ReadSeekCloser
	ModTime() time.Time
}

// newBlobStore returns the configured blob backend. STORAGE_BUCKET set →
// GCS (root is ignored); unset → local disk under root.
func newBlobStore(ctx context.Context, root, bucket string) (blobStore, error) {
	if bucket != "" {
		return newGCSBlobStore(ctx, bucket)
	}
	return newDiskBlobStore(root)
}

// --- disk implementation ---

type diskBlobStore struct {
	root string
}

func newDiskBlobStore(root string) (*diskBlobStore, error) {
	for _, sub := range []string{blobDir, previewDir, "tmp"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return nil, fmt.Errorf("mkdir storage/%s: %w", sub, err)
		}
	}
	return &diskBlobStore{root: root}, nil
}

func (b *diskBlobStore) writeBlob(r io.Reader, maxBytes int64) (string, int64, error) {
	tmp, err := os.CreateTemp(filepath.Join(b.root, "tmp"), "upload-*")
	if err != nil {
		return "", 0, fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }

	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hasher), io.LimitReader(r, maxBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		cleanup()
		return "", 0, err
	}
	if n > maxBytes {
		cleanup()
		return "", 0, errPayloadTooLarge
	}
	rel, err := b.placeAt(blobDir, tmpPath, hex.EncodeToString(hasher.Sum(nil)))
	if err != nil {
		cleanup()
		return "", 0, err
	}
	return rel, n, nil
}

func (b *diskBlobStore) writePreview(hash string, r io.Reader) error {
	tmp, err := os.CreateTemp(filepath.Join(b.root, "tmp"), "preview-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_, copyErr := io.Copy(tmp, r)
	closeErr := tmp.Close()
	err = copyErr
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if _, err := b.placeAt(previewDir, tmpPath, hash); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// placeAt moves src to <subdir>/<hash>, or removes src if the destination
// already exists. Both blob uploads (identical bytes) and preview encodes
// (deterministic output given the same source) resolve races benignly:
// whichever rename lands first wins.
func (b *diskBlobStore) placeAt(subdir, src, hash string) (string, error) {
	rel := filepath.Join(subdir, hash)
	dest := filepath.Join(b.root, rel)
	if _, err := os.Stat(dest); err == nil {
		_ = os.Remove(src)
		return rel, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.Rename(src, dest); err != nil {
		return "", err
	}
	return rel, nil
}

func (b *diskBlobStore) openByHash(hash string) (blobReader, error) {
	return b.openAt(blobDir, hash)
}

func (b *diskBlobStore) openPreviewByHash(hash string) (blobReader, error) {
	return b.openAt(previewDir, hash)
}

func (b *diskBlobStore) openAt(subdir, hash string) (blobReader, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return openDiskBlob(filepath.Join(b.root, subdir, hash))
}

func (b *diskBlobStore) openByPath(blobPath string) (blobReader, error) {
	clean := filepath.Clean(blobPath)
	base := filepath.Base(clean)
	if clean != blobDir+"/"+base && clean != "photos/"+base {
		return nil, os.ErrNotExist
	}
	return openDiskBlob(filepath.Join(b.root, clean))
}

func (b *diskBlobStore) rewriteLegacyPath(oldPath string) (string, error) {
	if !strings.HasPrefix(oldPath, "photos/") {
		return "", fmt.Errorf("unexpected legacy path %q", oldPath)
	}
	src := filepath.Join(b.root, oldPath)
	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(hasher, f)
	closeErr := f.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	return b.placeAt(blobDir, src, hex.EncodeToString(hasher.Sum(nil)))
}

// diskBlobReader wraps *os.File and remembers the mtime captured at Open
// time, so blobReader consumers don't need a second Stat call.
type diskBlobReader struct {
	*os.File
	mtime time.Time
}

func (d *diskBlobReader) ModTime() time.Time { return d.mtime }

func openDiskBlob(path string) (*diskBlobReader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return &diskBlobReader{File: f, mtime: info.ModTime()}, nil
}
