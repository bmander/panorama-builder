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
)

// Path layout: STORAGE_DIR/blobs/<sha256>. Legacy "photos/<id>" entries
// from before content-addressing remain readable through openByPath until
// blob_migration rewrites them. Derived previews live alongside under
// STORAGE_DIR/previews/<sha256> — pure cache, regenerable from the
// content-addressed original, never journaled.

const blobDir = "blobs"
const previewDir = "previews"

type blobStore struct {
	root string
}

var blobHashRegexp = regexp.MustCompile(`^[0-9a-f]{64}$`)

func newBlobStore(root string) (*blobStore, error) {
	for _, sub := range []string{blobDir, previewDir, "tmp"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			return nil, fmt.Errorf("mkdir storage/%s: %w", sub, err)
		}
	}
	return &blobStore{root: root}, nil
}

// writeBlob streams up to maxBytes through SHA-256 into a temp file, then
// commits it to blobs/<hash>. Identical bytes converge on the same file.
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
	rel, err := b.placeAtHash(tmpPath, hex.EncodeToString(hasher.Sum(nil)))
	if err != nil {
		cleanup()
		return "", 0, err
	}
	return rel, n, nil
}

// placeAtHash moves src to blobs/<hash>, or removes src if the destination
// already exists (dedup). Returns the relative path stored in blob_path.
func (b *blobStore) placeAtHash(src, hash string) (string, error) {
	rel := filepath.Join(blobDir, hash)
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

// openByPath opens a blob stored as `<dir>/<basename>` under STORAGE_DIR,
// where <dir> is one of the recognized subtrees. The base-equality check
// rejects path traversal: filepath.Clean of any escape would not match.
func (b *blobStore) openByPath(blobPath string) (*os.File, error) {
	clean := filepath.Clean(blobPath)
	base := filepath.Base(clean)
	if clean != blobDir+"/"+base && clean != "photos/"+base {
		return nil, os.ErrNotExist
	}
	return os.Open(filepath.Join(b.root, clean))
}

func (b *blobStore) openByHash(hash string) (*os.File, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return os.Open(filepath.Join(b.root, blobDir, hash))
}

// openPreviewByHash opens the lazily-generated medium-res preview for the
// original at blobs/<hash>. Caller is responsible for treating ErrNotExist
// as "regenerate from original".
func (b *blobStore) openPreviewByHash(hash string) (*os.File, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return os.Open(filepath.Join(b.root, previewDir, hash))
}

// placePreviewAtHash moves src to previews/<hash>, or removes src if the
// destination already exists. JPEG encoding is deterministic from the same
// source, so a race between two slow-path requests resolves benignly:
// whichever rename lands first wins, the second is discarded.
func (b *blobStore) placePreviewAtHash(src, hash string) (string, error) {
	rel := filepath.Join(previewDir, hash)
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

var errPayloadTooLarge = errors.New("payload too large")
