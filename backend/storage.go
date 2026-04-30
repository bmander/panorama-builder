package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Disk-backed photo blob storage. Path layout: STORAGE_DIR/photos/<id> with
// no extension — the MIME type lives in Postgres. The id is 13 chars of
// base32 (validated upstream), so no path traversal escape is possible.

type blobStore struct {
	root string
}

func newBlobStore(root string) (*blobStore, error) {
	if err := os.MkdirAll(filepath.Join(root, "photos"), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir storage: %w", err)
	}
	return &blobStore{root: root}, nil
}

func (b *blobStore) photoPath(id string) string {
	return filepath.Join(b.root, "photos", id)
}

// writePhoto streams up to maxBytes from r into the blob file. Returns the
// number of bytes written and the relative path stored in the photos.blob_path
// column. On error any partial file is removed.
func (b *blobStore) writePhoto(id string, r io.Reader, maxBytes int64) (int64, string, error) {
	if !validID(id) {
		return 0, "", errors.New("invalid id")
	}
	path := b.photoPath(id)
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return 0, "", fmt.Errorf("create blob file: %w", err)
	}
	n, err := io.Copy(f, io.LimitReader(r, maxBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return 0, "", err
	}
	if n > maxBytes {
		_ = os.Remove(tmp)
		return 0, "", errPayloadTooLarge
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return 0, "", err
	}
	rel := filepath.Join("photos", id)
	return n, rel, nil
}

func (b *blobStore) openPhoto(id string) (*os.File, error) {
	if !validID(id) {
		return nil, os.ErrNotExist
	}
	return os.Open(b.photoPath(id))
}

func (b *blobStore) deletePhoto(id string) error {
	if !validID(id) {
		return nil
	}
	if err := os.Remove(b.photoPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

var errPayloadTooLarge = errors.New("payload too large")
