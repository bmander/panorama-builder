package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Disk-backed photo blob storage. Blobs are content-addressed: each upload is
// streamed through SHA-256 and stored at STORAGE_DIR/blobs/<hex-hash>. The
// relative path "blobs/<hash>" is stored in photos.blob_path so the read
// path is a straightforward STORAGE_DIR-relative open.
//
// Content addressing is load-bearing for the trust model (see CLAUDE.md):
// a blob's bytes are immutable once written. Re-uploading new bytes for a
// photo produces a *new* hash; the previous bytes stay on disk and remain
// reachable from any prior commit's view of that photo. A revert therefore
// always finds the original bytes intact.
//
// Legacy rows written before this scheme used path "photos/<id>" (id-keyed,
// mutated in place). The startup migration in blob_migration.go rewrites
// them to the content-addressed form; openByPath accepts either form for the
// brief window before that migration runs.

type blobStore struct {
	root string
}

var blobHashRegexp = regexp.MustCompile(`^[0-9a-f]{64}$`)

func newBlobStore(root string) (*blobStore, error) {
	for _, sub := range []string{"blobs", "tmp", "photos"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return nil, fmt.Errorf("mkdir storage/%s: %w", sub, err)
		}
	}
	return &blobStore{root: root}, nil
}

// writeBlob streams up to maxBytes from r through SHA-256 into a temp file,
// then atomically moves the file to STORAGE_DIR/blobs/<hash>. If a blob with
// the same hash already exists, the temp file is dropped (idempotent — two
// uploads of identical bytes converge on the same file). Returns the
// relative path stored in photos.blob_path ("blobs/<hash>") and the byte
// count.
func (b *blobStore) writeBlob(r io.Reader, maxBytes int64) (string, int64, error) {
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

	sum := hex.EncodeToString(hasher.Sum(nil))
	rel := filepath.Join("blobs", sum)
	dest := filepath.Join(b.root, rel)

	switch _, statErr := os.Stat(dest); {
	case statErr == nil:
		// Same bytes already on disk from a prior upload; drop the dupe.
		cleanup()
		return rel, n, nil
	case errors.Is(statErr, os.ErrNotExist):
		if err := os.Rename(tmpPath, dest); err != nil {
			cleanup()
			return "", 0, err
		}
		return rel, n, nil
	default:
		cleanup()
		return "", 0, statErr
	}
}

// openByPath opens a blob given the relative path stored in photos.blob_path.
// Accepts the new "blobs/<hash>" form and the legacy "photos/<id>" form.
// Rejects any path that tries to climb out of STORAGE_DIR.
func (b *blobStore) openByPath(blobPath string) (*os.File, error) {
	clean := filepath.Clean(blobPath)
	if clean != "blobs/"+filepath.Base(clean) && clean != "photos/"+filepath.Base(clean) {
		return nil, os.ErrNotExist
	}
	if strings.Contains(clean, "..") {
		return nil, os.ErrNotExist
	}
	return os.Open(filepath.Join(b.root, clean))
}

// openByHash opens STORAGE_DIR/blobs/<hash>. Used by GET /api/blobs/{hash}.
func (b *blobStore) openByHash(hash string) (*os.File, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return os.Open(filepath.Join(b.root, "blobs", hash))
}

var errPayloadTooLarge = errors.New("payload too large")
