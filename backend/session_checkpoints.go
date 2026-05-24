package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Unified undo/redo for a session, built on whole-journal snapshots.
//
// session_ops is a coalesced terminal-state overlay, so undo can't replay it
// backwards. Instead each undoable action snapshots the whole journal and the
// snapshot is pushed onto a bounded stack; undo pops it and restores. These
// snapshots are session scratch — they never reach main or the commit log, so
// undo/redo carry no sign_off (the same reasoning as abandonSession).

const checkpointStackCap = 50

const (
	stackUndo = "undo"
	stackRedo = "redo"
)

// journalOpSnapshot / journalSnapshot serialize a session's journal as it
// stood at a point in time. before_json / after_json are carried verbatim as
// raw JSON (nil for the populated-on-one-side insert/delete shapes).
type journalOpSnapshot struct {
	Seq        int64           `json:"seq"`
	EntityType string          `json:"entity_type"`
	EntityID   string          `json:"entity_id"`
	Op         string          `json:"op"`
	BeforeJSON json.RawMessage `json:"before_json,omitempty"`
	AfterJSON  json.RawMessage `json:"after_json,omitempty"`
}

type journalSnapshot struct {
	Ops          []journalOpSnapshot `json:"ops"`
	NextSeq      int64               `json:"next_seq"`
	LastSolveRMS *float64            `json:"last_solve_rms,omitempty"`
}

// captureJournalSnapshot reads the session's current journal (session_ops +
// next_seq + last_solve_rms) into an in-memory snapshot.
func captureJournalSnapshot(ctx context.Context, tx pgx.Tx, sessionID string) (journalSnapshot, error) {
	var snap journalSnapshot
	if err := tx.QueryRow(ctx,
		`SELECT next_seq, last_solve_rms FROM sessions WHERE id=$1`, sessionID,
	).Scan(&snap.NextSeq, &snap.LastSolveRMS); err != nil {
		return snap, err
	}
	rows, err := tx.Query(ctx, `
		SELECT seq, entity_type, entity_id, op, before_json, after_json
		FROM session_ops WHERE session_id=$1 ORDER BY seq`, sessionID)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var o journalOpSnapshot
		var before, after []byte
		if err := rows.Scan(&o.Seq, &o.EntityType, &o.EntityID, &o.Op, &before, &after); err != nil {
			rows.Close()
			return snap, err
		}
		o.BeforeJSON = before
		o.AfterJSON = after
		snap.Ops = append(snap.Ops, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return snap, err
	}
	return snap, nil
}

// restoreJournalSnapshot replaces the session's journal with a snapshot's
// contents. next_seq is restored alongside the rows so the seq allocator
// doesn't drift and collide on the (session_id, seq) primary key.
func restoreJournalSnapshot(ctx context.Context, tx pgx.Tx, sessionID string, snap journalSnapshot) error {
	if _, err := tx.Exec(ctx, `DELETE FROM session_ops WHERE session_id=$1`, sessionID); err != nil {
		return err
	}
	for _, o := range snap.Ops {
		if _, err := tx.Exec(ctx, `
			INSERT INTO session_ops (session_id, seq, entity_type, entity_id, op, before_json, after_json)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			sessionID, o.Seq, o.EntityType, o.EntityID, o.Op,
			jsonbBytesOrNil(o.BeforeJSON), jsonbBytesOrNil(o.AfterJSON)); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `
		UPDATE sessions SET next_seq=$2, last_solve_rms=$3, updated_at=NOW()
		WHERE id=$1`, sessionID, snap.NextSeq, snap.LastSolveRMS)
	return err
}

// jsonbBytesOrNil maps an empty snapshot field to a nil arg so the JSONB
// column round-trips to SQL NULL rather than failing on an empty string.
func jsonbBytesOrNil(b json.RawMessage) []byte {
	if len(b) == 0 {
		return nil
	}
	return b
}

// pushCheckpoint appends a snapshot to a stack and evicts everything older
// than the newest checkpointStackCap entries.
func pushCheckpoint(ctx context.Context, tx pgx.Tx, sessionID, stack, label string, snap journalSnapshot) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO session_checkpoints (session_id, stack, position, snapshot_json, label)
		VALUES ($1, $2,
		  COALESCE((SELECT MAX(position) FROM session_checkpoints WHERE session_id=$1 AND stack=$2), 0) + 1,
		  $3, $4)`,
		sessionID, stack, jsonMust(snap), label); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		DELETE FROM session_checkpoints
		WHERE session_id=$1 AND stack=$2
		  AND position <= (SELECT MAX(position) FROM session_checkpoints
		                   WHERE session_id=$1 AND stack=$2) - $3`,
		sessionID, stack, checkpointStackCap)
	return err
}

// popCheckpoint removes and returns the newest snapshot on a stack. ok=false
// means the stack was empty.
func popCheckpoint(ctx context.Context, tx pgx.Tx, sessionID, stack string) (journalSnapshot, bool, error) {
	var pos int64
	var blob []byte
	err := tx.QueryRow(ctx, `
		SELECT position, snapshot_json FROM session_checkpoints
		WHERE session_id=$1 AND stack=$2
		ORDER BY position DESC LIMIT 1`, sessionID, stack).Scan(&pos, &blob)
	if errors.Is(err, pgx.ErrNoRows) {
		return journalSnapshot{}, false, nil
	}
	if err != nil {
		return journalSnapshot{}, false, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM session_checkpoints WHERE session_id=$1 AND stack=$2 AND position=$3`,
		sessionID, stack, pos); err != nil {
		return journalSnapshot{}, false, err
	}
	var snap journalSnapshot
	if err := json.Unmarshal(blob, &snap); err != nil {
		return journalSnapshot{}, false, err
	}
	return snap, true, nil
}

func clearCheckpoints(ctx context.Context, tx pgx.Tx, sessionID, stack string) error {
	_, err := tx.Exec(ctx,
		`DELETE FROM session_checkpoints WHERE session_id=$1 AND stack=$2`, sessionID, stack)
	return err
}

func checkpointExists(ctx context.Context, db queryerLike, sessionID, stack string) (bool, error) {
	var exists bool
	err := db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM session_checkpoints WHERE session_id=$1 AND stack=$2)`,
		sessionID, stack).Scan(&exists)
	return exists, err
}

// maybePushCheckpoint records a pre-action journal snapshot the first time a
// session sees a given X-Action-Id. Every write in one user action (one
// flushSync batch) carries the same id, so this fires exactly once per
// action; an empty id (e.g. the solve stream, which manages its own
// checkpoint) records nothing. FOR UPDATE serializes the parallel writes of a
// batch so they don't double-push. A new action invalidates the redo stack.
func (s *Server) maybePushCheckpoint(ctx context.Context, sessionID, actionID string) error {
	if actionID == "" {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var current *string
	if err := tx.QueryRow(ctx,
		`SELECT current_action_id FROM sessions WHERE id=$1 FOR UPDATE`, sessionID,
	).Scan(&current); err != nil {
		return err
	}
	if current != nil && *current == actionID {
		return nil // a later write of the same in-flight action
	}
	snap, err := captureJournalSnapshot(ctx, tx, sessionID)
	if err != nil {
		return err
	}
	if err := pushCheckpoint(ctx, tx, sessionID, stackUndo, "edit", snap); err != nil {
		return err
	}
	if err := clearCheckpoints(ctx, tx, sessionID, stackRedo); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET current_action_id=$2 WHERE id=$1`, sessionID, actionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
