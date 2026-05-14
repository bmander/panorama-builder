package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateLegacyBlobs converts photos.blob_path values from the old
// "photos/<id>" form (id-keyed, mutable in place) to "blobs/<hash>"
// (content-addressed, immutable). Runs once at startup; idempotent — once
// every row is migrated the WHERE clause matches nothing and the function
// returns immediately.
//
// Per row: hash the on-disk file, move it to blobs/<hash> (or remove it if
// the destination already exists), then UPDATE blob_path. Rows whose
// on-disk file is missing are logged and skipped — blob_path stays as-is so
// a later manual recovery can find them.
func migrateLegacyBlobs(ctx context.Context, db *pgxpool.Pool, blobs *blobStore) error {
	rows, err := db.Query(ctx,
		`SELECT id, blob_path FROM photos WHERE blob_path LIKE 'photos/%'`)
	if err != nil {
		return fmt.Errorf("scan legacy photos: %w", err)
	}
	type legacy struct{ id, path string }
	var todo []legacy
	for rows.Next() {
		var l legacy
		if err := rows.Scan(&l.id, &l.path); err != nil {
			rows.Close()
			return err
		}
		todo = append(todo, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(todo) == 0 {
		return nil
	}

	log.Printf("blob migration: rewriting %d legacy photo path(s) to content-addressed", len(todo))
	for _, l := range todo {
		newPath, err := rewriteLegacyBlob(blobs, l.path)
		if err != nil {
			log.Printf("blob migration: skip photo %s (%s): %v", l.id, l.path, err)
			continue
		}
		if _, err := db.Exec(ctx,
			`UPDATE photos SET blob_path=$2 WHERE id=$1 AND blob_path=$3`,
			l.id, newPath, l.path); err != nil {
			return fmt.Errorf("update photo %s: %w", l.id, err)
		}
	}
	return nil
}

// rewriteLegacyBlob hashes the file at STORAGE_DIR/<oldPath>, moves it to
// STORAGE_DIR/blobs/<hash>, and returns the new relative path. If a blob
// with the same hash already exists (e.g. two photo rows pointed at byte-
// identical files), the legacy file is removed and the existing one is
// reused.
func rewriteLegacyBlob(b *blobStore, oldPath string) (string, error) {
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
	sum := hex.EncodeToString(hasher.Sum(nil))
	rel := filepath.Join("blobs", sum)
	dest := filepath.Join(b.root, rel)
	switch _, err := os.Stat(dest); {
	case errors.Is(err, os.ErrNotExist):
		if err := os.Rename(src, dest); err != nil {
			return "", err
		}
	case err == nil:
		_ = os.Remove(src)
	default:
		return "", err
	}
	return rel, nil
}
