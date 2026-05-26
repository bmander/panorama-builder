package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
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
	// ogDir holds generated social-card crops, keyed by a sha256 of the
	// request params + source blob hash (not the source hash itself, so it
	// can't collide with a real blob/preview). See og_preview.go.
	ogDir = "og"
)

var blobHashRegexp = regexp.MustCompile(`^[0-9a-f]{64}$`)
var errPayloadTooLarge = errors.New("payload too large")

// blobStore abstracts blob storage so the backend can run against either a
// local disk root (dev, and prod absent STORAGE_BUCKET) or a GCS bucket.
// Paths returned by writeBlob are stored verbatim in photos.blob_path, so
// view-mode clients can resolve them against any base URL.
//
// Every method takes a context.Context so the GCS impl can cancel
// in-flight uploads/downloads when the originating HTTP request is torn
// down. The disk impl ignores ctx (filesystem ops are not natively
// ctx-aware) but accepts it for interface uniformity.
type blobStore interface {
	// writeBlob streams up to maxBytes through SHA-256 and stores the bytes
	// at blobs/<hash>. Identical bytes converge on the same path. Returns
	// errPayloadTooLarge if more than maxBytes are read.
	writeBlob(ctx context.Context, r io.Reader, maxBytes int64) (path string, n int64, err error)
	// writePreview stores preview bytes at previews/<hash>, where hash is
	// the SHA-256 of the *source* blob (not of the preview bytes).
	writePreview(ctx context.Context, hash string, r io.Reader) error
	// openByHash opens the content-addressed original at blobs/<hash>.
	openByHash(ctx context.Context, hash string) (blobReader, error)
	// openPreviewByHash opens previews/<hash>, or returns os.ErrNotExist if
	// the preview has not been generated yet.
	openPreviewByHash(ctx context.Context, hash string) (blobReader, error)
	// writeOg stores a generated social-card JPEG at og/<key>, where key is
	// the sha256 hex of the request params + source blob hash.
	writeOg(ctx context.Context, key string, r io.Reader) error
	// openOgByHash opens og/<key>, or returns os.ErrNotExist if the card has
	// not been generated yet.
	openOgByHash(ctx context.Context, key string) (blobReader, error)
	// openByPath opens a blob by its stored relative path. Accepts the
	// content-addressed "blobs/<hash>" and the legacy "photos/<id>" forms;
	// anything else is rejected as not-exist (path-traversal defense).
	openByPath(ctx context.Context, blobPath string) (blobReader, error)
	// rewriteLegacyPath reads bytes at a "photos/<id>" location, hashes
	// them, and writes them to "blobs/<hash>". Returns the new path.
	// Used by migrateLegacyBlobs at startup. NOTE: the legacy object is
	// intentionally NOT deleted — deleting it before photos.blob_path is
	// updated would orphan the row on a crash between the two operations.
	// The migration accepts the residual storage cost in exchange for
	// crash-safety (CLAUDE.md trust-model invariant).
	rewriteLegacyPath(ctx context.Context, oldPath string) (newPath string, err error)
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
	for _, sub := range []string{blobDir, previewDir, ogDir, "tmp"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return nil, fmt.Errorf("mkdir storage/%s: %w", sub, err)
		}
	}
	return &diskBlobStore{root: root}, nil
}

func (b *diskBlobStore) writeBlob(_ context.Context, r io.Reader, maxBytes int64) (string, int64, error) {
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

func (b *diskBlobStore) writePreview(_ context.Context, hash string, r io.Reader) error {
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

func (b *diskBlobStore) writeOg(_ context.Context, key string, r io.Reader) error {
	tmp, err := os.CreateTemp(filepath.Join(b.root, "tmp"), "og-*")
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
	if _, err := b.placeAt(ogDir, tmpPath, key); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func (b *diskBlobStore) openOgByHash(_ context.Context, key string) (blobReader, error) {
	return b.openAt(ogDir, key)
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

func (b *diskBlobStore) openByHash(_ context.Context, hash string) (blobReader, error) {
	return b.openAt(blobDir, hash)
}

func (b *diskBlobStore) openPreviewByHash(_ context.Context, hash string) (blobReader, error) {
	return b.openAt(previewDir, hash)
}

func (b *diskBlobStore) openAt(subdir, hash string) (blobReader, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return openDiskBlob(filepath.Join(b.root, subdir, hash))
}

func (b *diskBlobStore) openByPath(_ context.Context, blobPath string) (blobReader, error) {
	clean := filepath.Clean(blobPath)
	base := filepath.Base(clean)
	if clean != blobDir+"/"+base && clean != "photos/"+base {
		return nil, os.ErrNotExist
	}
	return openDiskBlob(filepath.Join(b.root, clean))
}

// rewriteLegacyPath hashes the bytes at the legacy "photos/<id>" location
// and writes them to "blobs/<hash>" via a staging copy. The source file
// is intentionally NOT deleted — migrateLegacyBlobs must be able to retry
// safely if the post-rewrite DB UPDATE fails, and deleting the source
// before the UPDATE commits would orphan the photo row on a crash.
func (b *diskBlobStore) rewriteLegacyPath(ctx context.Context, oldPath string) (string, error) {
	if !strings.HasPrefix(oldPath, "photos/") {
		return "", fmt.Errorf("unexpected legacy path %q", oldPath)
	}
	src := filepath.Join(b.root, oldPath)
	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer f.Close()
	// Stream the legacy bytes through writeBlob — same hash + temp-file +
	// rename machinery as a fresh upload, but pointed at an existing file
	// on disk. Leaves the source file in place.
	path, _, err := b.writeBlob(ctx, f, math.MaxInt64-1)
	return path, err
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
