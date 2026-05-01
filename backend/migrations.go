package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"path"
	"regexp"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migration filenames look like "NNNN_description.sql". We sort by the integer
// version so 9_x sorts before 10_x even though string-sort would invert them.
var migrationName = regexp.MustCompile(`^(\d+)_.+\.sql$`)

type migration struct {
	version int
	name    string // full filename (for log + read)
	sql     string
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied, err := loadAppliedVersions(ctx, pool)
	if err != nil {
		return err
	}

	migrations, err := loadEmbeddedMigrations()
	if err != nil {
		return err
	}

	// Surface accidental deletions: a stamped version with no file means
	// the developer removed a migration whose schema change is still in the
	// DB. Deleting the file does not undo the change.
	present := make(map[int]bool, len(migrations))
	for _, m := range migrations {
		present[m.version] = true
	}
	for v := range applied {
		if !present[v] {
			log.Printf("warning: schema_migrations has version %d but no migration file matches", v)
		}
	}

	for _, m := range migrations {
		if applied[m.version] {
			continue
		}
		if err := applyMigration(ctx, pool, m); err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
		log.Printf("applied migration %s", m.name)
	}
	return nil
}

func loadAppliedVersions(ctx context.Context, pool *pgxpool.Pool) (map[int]bool, error) {
	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	defer rows.Close()
	out := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("scan schema_migrations: %w", err)
		}
		out[v] = true
	}
	return out, rows.Err()
}

func loadEmbeddedMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	var out []migration
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		match := migrationName.FindStringSubmatch(e.Name())
		if match == nil {
			return nil, fmt.Errorf("migration %q does not match NNNN_description.sql", e.Name())
		}
		v, err := strconv.Atoi(match[1])
		if err != nil {
			return nil, fmt.Errorf("migration %q: parse version: %w", e.Name(), err)
		}
		body, err := fs.ReadFile(migrationsFS, path.Join("migrations", e.Name()))
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", e.Name(), err)
		}
		out = append(out, migration{version: v, name: e.Name(), sql: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	for i := 1; i < len(out); i++ {
		if out[i].version == out[i-1].version {
			return nil, fmt.Errorf("duplicate migration version %d (%s, %s)", out[i].version, out[i-1].name, out[i].name)
		}
	}
	return out, nil
}

func applyMigration(ctx context.Context, pool *pgxpool.Pool, m migration) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, m.sql); err != nil {
		return fmt.Errorf("exec: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
		m.version, m.name,
	); err != nil {
		return fmt.Errorf("record: %w", err)
	}
	return tx.Commit(ctx)
}
