package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// API shapes (CreateSessionResponse, SessionState, SessionOp, EntityRef,
// CommitRef, ConflictsResponse, etc.) are generated from openapi.yaml into
// types.gen.go. This file uses those generated types directly; the helpers
// below build them with the right enum casts.

// makeEntityRef constructs a generated EntityRef from raw strings, applying
// the enum-typed cast on entity_type. Used everywhere the handlers
// communicate back to the client.
func makeEntityRef(entityType, entityID string, lastSeq *int64) EntityRef {
	return EntityRef{
		EntityType: EntityRefEntityType(entityType),
		EntityID:   entityID,
		LastSeq:    lastSeq,
	}
}

func makeSessionOp(op journalOp) SessionOp {
	return SessionOp{
		Seq:        op.Seq,
		EntityType: SessionOpEntityType(op.EntityType),
		EntityID:   op.EntityID,
		Op:         SessionOpOp(op.Op),
		Before:     rawOrNil(op.BeforeJSON),
		After:      rawOrNil(op.AfterJSON),
	}
}

// postSession opens a new session at HEAD. base_seq is current MAX(seq) or
// 0 if the commit log is empty.
func (s *Server) postSession(w http.ResponseWriter, r *http.Request) {
	id := newID()
	var resp CreateSessionResponse
	var status string
	err := s.db.QueryRow(r.Context(), `
		INSERT INTO sessions (id, base_seq)
		VALUES ($1, COALESCE((SELECT MAX(seq) FROM commits), 0))
		RETURNING id, base_seq, status, next_seq, created_at`, id,
	).Scan(&resp.ID, &resp.BaseSeq, &status, &resp.NextSeq, &resp.CreatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	resp.Status = CreateSessionResponseStatus(status)
	writeJSON(w, http.StatusCreated, resp)
}

// getSession returns the session row + ops summary + live conflict list.
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	state := SessionState{ID: id, Conflicts: []EntityRef{}, TouchedEntities: []EntityRef{}}
	var status string
	err := s.db.QueryRow(ctx, `
		SELECT base_seq, status, next_seq, created_at, updated_at
		FROM sessions WHERE id=$1`, id,
	).Scan(&state.BaseSeq, &status, &state.NextSeq, &state.CreatedAt, &state.UpdatedAt)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	state.Status = SessionStateStatus(status)
	touched, err := touchedEntities(ctx, s.db, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if touched != nil {
		state.TouchedEntities = touched
	}
	// Journal length, not next_seq - 1: ops coalesce in place so a session
	// that moved one entity 10 times has 1 row, not 10.
	if err := s.db.QueryRow(ctx,
		`SELECT COUNT(*) FROM session_ops WHERE session_id=$1`, id,
	).Scan(&state.OpCount); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	conflicts, err := computeConflicts(ctx, s.db, touched, state.BaseSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if conflicts != nil {
		state.Conflicts = conflicts
	}
	writeJSON(w, http.StatusOK, state)
}

// getSessionOps returns the journal in seq order.
func (s *Server) getSessionOps(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ops, err := loadSessionOps(r.Context(), s.db, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	out := make([]SessionOp, 0, len(ops))
	for _, op := range ops {
		out = append(out, makeSessionOp(op))
	}
	writeJSON(w, http.StatusOK, out)
}

// rawOrNil wraps non-empty JSONB so the encoder passes it through verbatim
// instead of re-marshaling. Empty bytes become nil → encoded as "null".
func rawOrNil(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return json.RawMessage(b)
}

// abandonSession marks the session as 'abandoned'. Idempotent on
// already-abandoned; 409 if already merged; 404 if no such session.
func (s *Server) abandonSession(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var statusBefore string
	err := s.db.QueryRow(r.Context(), `
		WITH prev AS (SELECT status FROM sessions WHERE id=$1),
		     upd AS (
		       UPDATE sessions SET status='abandoned', updated_at=NOW()
		       WHERE id=$1 AND status IN ('open','abandoned')
		     )
		SELECT status FROM prev`, id).Scan(&statusBefore)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if statusBefore == "merged" {
		writeError(w, http.StatusConflict, "session is merged")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// touchedEntities returns the set of (entity_type, entity_id) pairs the
// session has ever journaled an op for.
func touchedEntities(ctx context.Context, db queryerLike, sessionID string) ([]EntityRef, error) {
	rows, err := db.Query(ctx, `
		SELECT DISTINCT entity_type, entity_id FROM session_ops
		WHERE session_id=$1
		ORDER BY entity_type, entity_id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EntityRef
	for rows.Next() {
		var entityType, entityID string
		if err := rows.Scan(&entityType, &entityID); err != nil {
			return nil, err
		}
		out = append(out, makeEntityRef(entityType, entityID, nil))
	}
	return out, rows.Err()
}

// queryerLike is a tiny shim so touchedEntities/computeConflicts can run
// against either *pgxpool.Pool or pgx.Tx.
type queryerLike interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// computeConflicts returns refs whose entity_commits.last_seq exceeds the
// supplied baseSeq.
func computeConflicts(ctx context.Context, db queryerLike, touched []EntityRef, baseSeq int64) ([]EntityRef, error) {
	if len(touched) == 0 {
		return nil, nil
	}
	types := make([]string, 0, len(touched))
	ids := make([]string, 0, len(touched))
	for _, t := range touched {
		types = append(types, string(t.EntityType))
		ids = append(ids, t.EntityID)
	}
	rows, err := db.Query(ctx, `
		SELECT ec.entity_type, ec.entity_id, ec.last_seq
		FROM entity_commits ec
		JOIN UNNEST($1::text[], $2::text[]) AS req(entity_type, entity_id)
		  ON ec.entity_type=req.entity_type AND ec.entity_id=req.entity_id
		WHERE ec.last_seq > $3`, types, ids, baseSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EntityRef
	for rows.Next() {
		var entityType, entityID string
		var seq int64
		if err := rows.Scan(&entityType, &entityID, &seq); err != nil {
			return nil, err
		}
		out = append(out, makeEntityRef(entityType, entityID, &seq))
	}
	return out, rows.Err()
}

// netOp is one entity's terminal state ready to apply against main.
// recordOp coalesces per-entity at write time (unique constraint on
// (session_id, entity_type, entity_id)), so each journal op already
// represents the session's terminal effect for its entity.
type netOp struct {
	EntityType string
	EntityID   string
	Op         string // "insert" | "update" | "delete"
	Before     []byte
	After      []byte
	Seq        int64
}

// orderOpsForApply orders journal ops so FK invariants hold at apply time:
//   - inserts first, parents before children (entityRank ascending)
//   - updates next (FK shape can't change in an update)
//   - deletes last, children before parents (entityRank descending)
//
// FKs are RESTRICT (migration 0024), so a delete that arrives before its
// dependents would fail loudly — the descending order on the delete phase
// keeps merge transactions clean.
func orderOpsForApply(ops []journalOp) []netOp {
	out := make([]netOp, len(ops))
	for i, op := range ops {
		out[i] = netOp{
			EntityType: op.EntityType,
			EntityID:   op.EntityID,
			Op:         op.Op,
			Before:     op.BeforeJSON,
			After:      op.AfterJSON,
			Seq:        op.Seq,
		}
	}
	sort.Slice(out, func(i, j int) bool {
		pi, pj := opPhase[out[i].Op], opPhase[out[j].Op]
		if pi != pj {
			return pi < pj
		}
		ri, rj := entityRank[out[i].EntityType], entityRank[out[j].EntityType]
		if ri != rj {
			if out[i].Op == "delete" {
				return ri > rj
			}
			return ri < rj
		}
		return out[i].Seq < out[j].Seq
	})
	return out
}

var opPhase = map[string]int{"insert": 0, "update": 1, "delete": 2}

// getSessionRankDeficient is the read-only dry-run companion to mergeSession's
// σ gate. Applies the session's plan inside a transaction we never commit,
// runs mergeGateCheck on the resulting state, then rolls back. Returns the
// list the merge endpoint would block on (empty when clean). Used by the
// session widget to surface "X problems" between Solve and Save.
func (s *Server) getSessionRankDeficient(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sess Session
	err = tx.QueryRow(ctx, `
		SELECT id, base_seq, status, next_seq FROM sessions WHERE id=$1`, id,
	).Scan(&sess.ID, &sess.BaseSeq, &sess.Status, &sess.NextSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	type body struct {
		DeficientAxes []RankDeficientAxis `json:"deficient_axes"`
	}
	// Closed sessions: their effect is already on main, so checking against
	// the session journal would double-count. Return empty.
	if sess.Status != "open" {
		writeJSON(w, http.StatusOK, body{DeficientAxes: []RankDeficientAxis{}})
		return
	}

	ops, err := loadSessionOpsTx(ctx, tx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if len(ops) > 0 {
		plan := orderOpsForApply(ops)
		// Best-effort apply: a session with conflicts can't merge anyway, so
		// return whatever the gate sees on the pre-apply state in that case.
		// We don't want a 500 here either — the widget polls this often, so
		// degrading to the pre-apply view is preferable to surfacing the
		// transient error. The real merge will catch the same issue.
		if err := applyPlanToMain(ctx, tx, plan); err != nil {
			log.Printf("rank-deficient dry-run apply failed (session %s): %v", id, err)
		}
	}

	flagged, err := mergeGateCheck(ctx, tx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if flagged == nil {
		flagged = []RankDeficientAxis{}
	}
	writeJSON(w, http.StatusOK, body{DeficientAxes: flagged})
}

// mergeSession applies all ops in the session as a single commit. Refuses
// on conflict.
func (s *Server) mergeSession(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var body MergeRequest
	if !parseJSON(w, r, &body) {
		return
	}
	signOff, ok := requireSignOff(w, body.SignOff)
	if !ok {
		return
	}
	ctx := r.Context()

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sess Session
	err = tx.QueryRow(ctx, `
		SELECT id, base_seq, status, next_seq FROM sessions
		WHERE id=$1 FOR UPDATE`, id,
	).Scan(&sess.ID, &sess.BaseSeq, &sess.Status, &sess.NextSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if sess.Status != "open" {
		writeError(w, http.StatusConflict, "session is "+sess.Status)
		return
	}
	ops, err := loadSessionOpsTx(ctx, tx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if len(ops) == 0 {
		writeError(w, http.StatusBadRequest, "session has no ops")
		return
	}
	touched, err := touchedEntities(ctx, tx, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	conflicts, err := computeConflicts(ctx, tx, touched, sess.BaseSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if len(conflicts) > 0 {
		writeConflicts(w, "session base is behind main", conflicts)
		return
	}

	plan := orderOpsForApply(ops)
	commitID := newID()
	var seq int64
	var msg *string
	if body.Message != nil && *body.Message != "" {
		msg = body.Message
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO commits (id, source_session_id, parent_seq, kind, message, sign_off)
		VALUES ($1, $2, (SELECT MAX(seq) FROM commits), 'merge', $3, $4)
		RETURNING seq`, commitID, id, msg, signOff,
	).Scan(&seq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}

	if err := applyPlanToMain(ctx, tx, plan); err != nil {
		writeApplyError(w, err)
		return
	}
	// σ-gate: refuse merge if any touched entity has a free-axis σ over the
	// refuse threshold. Runs AFTER apply so we see the post-merge state
	// (which may include σ values just written by a solve in this session).
	// MergeRequest.allow_underdetermined bypasses.
	if body.AllowUnderdetermined == nil || !*body.AllowUnderdetermined {
		flagged, err := mergeGateCheck(ctx, tx, id)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		if len(flagged) > 0 {
			writeRankDeficient(w, flagged)
			return
		}
	}
	if err := bumpEntityCommits(ctx, tx, plan, seq); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sessions SET status='merged', updated_at=NOW() WHERE id=$1`, id,
	); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "40001" {
			writeError(w, http.StatusConflict, "concurrent merge; retry")
			return
		}
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, CommitRef{CommitID: commitID, Seq: seq})
}

// loadSessionOpsTx is loadSessionOps but inside a tx.
func loadSessionOpsTx(ctx context.Context, tx pgx.Tx, sessionID string) ([]journalOp, error) {
	rows, err := tx.Query(ctx, `
		SELECT seq, entity_type, entity_id, op, before_json, after_json
		FROM session_ops
		WHERE session_id=$1
		ORDER BY seq`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []journalOp
	for rows.Next() {
		var op journalOp
		if err := rows.Scan(&op.Seq, &op.EntityType, &op.EntityID, &op.Op, &op.BeforeJSON, &op.AfterJSON); err != nil {
			return nil, err
		}
		out = append(out, op)
	}
	return out, rows.Err()
}

// writeApplyError surfaces violation errors as 400/404 where possible.
func writeApplyError(w http.ResponseWriter, err error) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503": // FK violation
			writeError(w, http.StatusBadRequest, "merge failed: missing referenced row ("+pgErr.Detail+")")
			return
		case "23505": // unique violation
			writeError(w, http.StatusConflict, "merge failed: duplicate row ("+pgErr.Detail+")")
			return
		}
	}
	writeErrorFromDB(w, err)
}

// applyPlanToMain runs the ordered netOp plan against the main tables.
func applyPlanToMain(ctx context.Context, tx pgx.Tx, plan []netOp) error {
	for _, op := range plan {
		switch op.Op {
		case "insert":
			if err := insertEntityFromJSON(ctx, tx, op.EntityType, op.After); err != nil {
				return fmt.Errorf("insert %s/%s: %w", op.EntityType, op.EntityID, err)
			}
		case "update":
			if err := updateEntityFromJSON(ctx, tx, op.EntityType, op.EntityID, op.After); err != nil {
				return fmt.Errorf("update %s/%s: %w", op.EntityType, op.EntityID, err)
			}
		case "delete":
			if err := deleteEntityByID(ctx, tx, op.EntityType, op.EntityID); err != nil {
				return fmt.Errorf("delete %s/%s: %w", op.EntityType, op.EntityID, err)
			}
		default:
			return fmt.Errorf("unknown op kind %q", op.Op)
		}
	}
	return nil
}

// bumpEntityCommits upserts (entity_type, entity_id) → last_seq for every
// entity in the plan that actually landed. Single statement via UNNEST.
// Deduplicates the plan because intent + derived ops may both reference
// the same entity (a user-edited photo that the merge-time solver also
// moved) and Postgres refuses to UPSERT the same key twice in one stmt.
func bumpEntityCommits(ctx context.Context, tx pgx.Tx, plan []netOp, seq int64) error {
	seen := make(map[string]bool, len(plan))
	types := make([]string, 0, len(plan))
	ids := make([]string, 0, len(plan))
	for _, op := range plan {
		k := op.EntityType + ":" + op.EntityID
		if seen[k] {
			continue
		}
		seen[k] = true
		types = append(types, op.EntityType)
		ids = append(ids, op.EntityID)
	}
	if len(types) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO entity_commits (entity_type, entity_id, last_seq)
		SELECT t, i, $3 FROM UNNEST($1::text[], $2::text[]) AS u(t, i)
		ON CONFLICT (entity_type, entity_id) DO UPDATE SET last_seq = EXCLUDED.last_seq`,
		types, ids, seq)
	return err
}

// writeConflicts emits the standard 409 body shared by merge and revert.
func writeConflicts(w http.ResponseWriter, msg string, conflicts []EntityRef) {
	writeJSON(w, http.StatusConflict, ConflictsResponse{Error: msg, Conflicts: conflicts})
}
