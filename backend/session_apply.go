package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// session_apply.go converts JSONB-stored row snapshots back into typed
// inserts/updates against the main tables. Used during merge and revert.
//
// Inserts serialize the full row (after_json carries every column on insert
// ops). Updates parse the partial column-diff in after_json and emit a
// dynamic UPDATE that only sets the columns the session actually changed —
// matching the on-disk shape session_diff.go shrinks to. `updated_at` is
// always bumped to NOW() so merge ordering stays correct even when no
// user-facing column moved.

// partialUpdate is a thin JSON-key-driven wrapper around the handler-side
// UpdateBuilder. It parses the diff body once into a key set, then defers
// the actual column binding to UpdateBuilder.Set when bindIf is called for
// a key that's present.
type partialUpdate struct {
	keys  map[string]json.RawMessage
	inner *UpdateBuilder
}

func newPartialUpdate(id string, body []byte) (*partialUpdate, error) {
	b := &partialUpdate{inner: newUpdateBuilder(id)}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &b.keys); err != nil {
			return nil, err
		}
	}
	return b, nil
}

func (b *partialUpdate) has(jsonKey string) bool {
	_, ok := b.keys[jsonKey]
	return ok
}

// bindIf binds (col, val) when jsonKey is present in the diff. Returns the
// receiver for chaining.
func (b *partialUpdate) bindIf(jsonKey, col string, val any) *partialUpdate {
	if b.has(jsonKey) {
		b.inner.Set(col, val)
	}
	return b
}

func (b *partialUpdate) exec(ctx context.Context, tx pgx.Tx, table string) error {
	return b.inner.Exec(ctx, tx, table)
}

func insertEntityFromJSON(ctx context.Context, tx pgx.Tx, entityType string, body []byte) error {
	spec, ok := entityRegistry[entityType]
	if !ok {
		return fmt.Errorf("insert: unknown entity_type %q", entityType)
	}
	return spec.insert(ctx, tx, body)
}

func updateEntityFromJSON(ctx context.Context, tx pgx.Tx, entityType, id string, body []byte) error {
	spec, ok := entityRegistry[entityType]
	if !ok {
		return fmt.Errorf("update: unknown entity_type %q", entityType)
	}
	return spec.update(ctx, tx, id, body)
}

func deleteEntityByID(ctx context.Context, tx pgx.Tx, entityType, id string) error {
	spec, ok := entityRegistry[entityType]
	if !ok {
		return fmt.Errorf("delete: unknown entity_type %q", entityType)
	}
	// Idempotent: zero rows is fine (the in-session delete may have removed
	// it before the row was ever written to main, e.g. insert+delete coalesce
	// is dropped earlier by collapseOps; but a delete-of-already-deleted via
	// FK cascade arrives here as a no-op).
	_, err := tx.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id=$1`, spec.table()), id)
	return err
}

// loadEntityJSONsByType bulk-reads rows for a set of ids from one entity
// table and returns id → JSON bytes shaped the same way session_ops.before
// _json / after_json are (Go struct json tags, not Postgres' to_jsonb).
// Missing ids are simply absent from the map. Accepts queryerLike so both
// pool reads (overlay construction) and tx reads (merge / revert paths)
// share the same helper.
func loadEntityJSONsByType(ctx context.Context, q queryerLike, entityType string, ids []string) (map[string][]byte, error) {
	if len(ids) == 0 {
		return map[string][]byte{}, nil
	}
	spec, ok := entityRegistry[entityType]
	if !ok {
		return nil, fmt.Errorf("loadEntityJSONsByType: unknown entity_type %q", entityType)
	}
	rows, err := q.Query(ctx,
		fmt.Sprintf(`SELECT %s FROM %s WHERE id = ANY($1::text[])`, spec.cols(), spec.table()), ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]byte, len(ids))
	for rows.Next() {
		id, js, err := spec.scanJSON(rows)
		if err != nil {
			return nil, err
		}
		out[id] = js
	}
	return out, rows.Err()
}
