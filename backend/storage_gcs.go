package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cloud.google.com/go/storage"
)

// gcsBlobStore implements blobStore against a GCS bucket. Path layout
// mirrors the disk impl: blobs/<hash>, previews/<hash>, with legacy
// photos/<id> objects accepted on read by openByPath.
//
// Reads buffer the whole object into memory so the returned blobReader is
// seekable for http.ServeContent. Acceptable here because blobs are capped
// at maxBlobBytes (~25 MB) and in production the editor service rarely
// serves blob bytes — view-mode clients fetch direct from the bucket URL
// via Cloud CDN.
type gcsBlobStore struct {
	bucket *storage.BucketHandle
	tmpDir string
}

func newGCSBlobStore(ctx context.Context, bucketName string) (*gcsBlobStore, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("gcs client: %w", err)
	}
	bucket := client.Bucket(bucketName)
	// Fail-fast on missing bucket or broken creds: crash on startup beats
	// 500-ing on first photo upload.
	if _, err := bucket.Attrs(ctx); err != nil {
		return nil, fmt.Errorf("gcs bucket %q: %w", bucketName, err)
	}
	return &gcsBlobStore{bucket: bucket, tmpDir: os.TempDir()}, nil
}

func (b *gcsBlobStore) writeBlob(ctx context.Context, r io.Reader, maxBytes int64) (string, int64, error) {
	// Stage to a local temp file so we can hash before naming the object,
	// then upload to blobs/<hash>. Cloud Run /tmp is tmpfs so this is
	// effectively a memory buffer.
	tmp, err := os.CreateTemp(b.tmpDir, "upload-*")
	if err != nil {
		return "", 0, fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	hasher := sha256.New()
	// maxBytes can be near-MaxInt64 from rewriteLegacyPath; guard the +1
	// to avoid overflow into a negative limit (which io.LimitReader treats
	// as "read nothing").
	limit := maxBytes
	if limit < math.MaxInt64 {
		limit++
	}
	n, err := io.Copy(io.MultiWriter(tmp, hasher), io.LimitReader(r, limit))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", 0, err
	}
	if n > maxBytes {
		return "", 0, errPayloadTooLarge
	}

	hash := hex.EncodeToString(hasher.Sum(nil))
	objName := blobDir + "/" + hash

	f, err := os.Open(tmpPath)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	// Sniff Content-Type from the leading bytes so view-mode clients that
	// fetch the object URL directly get a sensible MIME header.
	var sniffBuf [512]byte
	sn, _ := io.ReadFull(f, sniffBuf[:])
	contentType := http.DetectContentType(sniffBuf[:sn])
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	if err := b.upload(ctx, objName, f, contentType); err != nil {
		return "", 0, err
	}
	return objName, n, nil
}

func (b *gcsBlobStore) writePreview(ctx context.Context, hash string, r io.Reader) error {
	return b.upload(ctx, previewDir+"/"+hash, r, "image/jpeg")
}

// upload writes r to objName with Content-Type and an immutable long-cache
// header. Both blobs and previews are content-addressed by the source hash,
// so cache-forever is correct. Concurrent writes of identical bytes
// overwrite benignly; we don't bother gating on existence.
func (b *gcsBlobStore) upload(ctx context.Context, objName string, r io.Reader, contentType string) error {
	w := b.bucket.Object(objName).NewWriter(ctx)
	w.ContentType = contentType
	w.CacheControl = "public, max-age=31536000, immutable"
	if _, err := io.Copy(w, r); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}

func (b *gcsBlobStore) writeOg(ctx context.Context, key string, r io.Reader) error {
	return b.upload(ctx, ogDir+"/"+key, r, "image/jpeg")
}

func (b *gcsBlobStore) openOgByHash(ctx context.Context, key string) (blobReader, error) {
	if !blobHashRegexp.MatchString(key) {
		return nil, os.ErrNotExist
	}
	return b.read(ctx, ogDir+"/"+key)
}

func (b *gcsBlobStore) openByHash(ctx context.Context, hash string) (blobReader, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return b.read(ctx, blobDir+"/"+hash)
}

func (b *gcsBlobStore) openPreviewByHash(ctx context.Context, hash string) (blobReader, error) {
	if !blobHashRegexp.MatchString(hash) {
		return nil, os.ErrNotExist
	}
	return b.read(ctx, previewDir+"/"+hash)
}

func (b *gcsBlobStore) openByPath(ctx context.Context, blobPath string) (blobReader, error) {
	clean := filepath.Clean(blobPath)
	base := filepath.Base(clean)
	if clean != blobDir+"/"+base && clean != "photos/"+base {
		return nil, os.ErrNotExist
	}
	return b.read(ctx, clean)
}

func (b *gcsBlobStore) read(ctx context.Context, objName string) (blobReader, error) {
	rc, err := b.bucket.Object(objName).NewReader(ctx)
	if err != nil {
		if errors.Is(err, storage.ErrObjectNotExist) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	defer rc.Close()
	buf, err := io.ReadAll(rc)
	if err != nil {
		return nil, err
	}
	return &gcsBlobReader{Reader: bytes.NewReader(buf), mtime: rc.Attrs.LastModified}, nil
}

// rewriteLegacyPath hashes the bytes at a "photos/<id>" object and writes
// them to "blobs/<hash>" without deleting the source. migrateLegacyBlobs
// updates the DB row before any cleanup so a crash between rewrite and
// UPDATE leaves the row pointing at a still-existing legacy object —
// preserving the trust-model invariant that every photo row references
// readable bytes.
func (b *gcsBlobStore) rewriteLegacyPath(ctx context.Context, oldPath string) (string, error) {
	if !strings.HasPrefix(oldPath, "photos/") {
		return "", fmt.Errorf("unexpected legacy path %q", oldPath)
	}
	rc, err := b.bucket.Object(oldPath).NewReader(ctx)
	if err != nil {
		return "", err
	}
	defer rc.Close()
	// Stream legacy bytes through writeBlob — stages locally, hashes,
	// uploads to blobs/<hash>. Source object is intentionally untouched.
	path, _, err := b.writeBlob(ctx, rc, math.MaxInt64-1)
	return path, err
}

// gcsBlobReader holds object bytes in memory; Close is a no-op (GC handles
// the buffer). mtime is GCS Updated, which the disk impl mirrors via the
// file's filesystem mtime.
type gcsBlobReader struct {
	*bytes.Reader
	mtime time.Time
}

func (g *gcsBlobReader) Close() error       { return nil }
func (g *gcsBlobReader) ModTime() time.Time { return g.mtime }
