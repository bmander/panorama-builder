package main

import (
	"context"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateLegacyBlobs rewrites photos.blob_path from "photos/<id>" (id-keyed,
// mutable) to "blobs/<hash>" (content-addressed, immutable). Idempotent —
// once everything's migrated the WHERE clause matches nothing.
func migrateLegacyBlobs(ctx context.Context, db *pgxpool.Pool, blobs blobStore) error {
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
		newPath, err := blobs.rewriteLegacyPath(l.path)
		if err != nil {
			log.Printf("blob migration: skip photo %s (%s): %v", l.id, l.path, err)
			continue
		}
		// Guarded UPDATE: a concurrent process that already rewrote the row
		// would have produced the same hash, so a no-op match is fine.
		if _, err := db.Exec(ctx,
			`UPDATE photos SET blob_path=$2 WHERE id=$1 AND blob_path=$3`,
			l.id, newPath, l.path); err != nil {
			return fmt.Errorf("update photo %s: %w", l.id, err)
		}
	}
	return nil
}
