package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Commit, CommitWithOps, CommitRef, ConflictsResponse — all generated into
// types.gen.go from openapi.yaml. We use those directly.

// commitSelect is the column list shared by listCommits and getCommit. The
// op_count CASE branches: for merge commits, count the source session's ops;
// for revert commits (no own session), count the reverted commit's ops, since
// a revert's effect is the inverse of that set.
const commitSelect = `
	SELECT c.id, c.seq, c.parent_seq, c.source_session_id, c.kind,
	       c.reverts_commit_id, c.message, c.sign_off, c.created_at,
	       CASE
	         WHEN c.source_session_id IS NOT NULL THEN
	           (SELECT COUNT(*) FROM session_ops WHERE session_id = c.source_session_id)
	         WHEN c.reverts_commit_id IS NOT NULL THEN
	           (SELECT COUNT(*) FROM session_ops so
	              JOIN commits r ON r.source_session_id = so.session_id
	              WHERE r.id = c.reverts_commit_id)
	         ELSE 0
	       END AS op_count,
	       c.error_count, c.fit_score
	FROM commits c`

func (s *Server) listCommits(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	beforeSeq := int64(-1)
	if v := r.URL.Query().Get("before_seq"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			beforeSeq = n
		}
	}
	q := commitSelect
	args := []any{}
	if beforeSeq > 0 {
		q += ` WHERE c.seq < $1`
		args = append(args, beforeSeq)
	}
	q += ` ORDER BY c.seq DESC LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := s.db.Query(r.Context(), q, args...)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()
	out := []Commit{}
	for rows.Next() {
		c, err := scanCommit(rows)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// scanCommit reads one commit row, casting the kind column into the enum
// alias the generated type uses.
func scanCommit(row pgx.Row) (Commit, error) {
	var c Commit
	var kind string
	err := row.Scan(&c.ID, &c.Seq, &c.ParentSeq, &c.SourceSessionID, &kind,
		&c.RevertsCommitID, &c.Message, &c.SignOff, &c.CreatedAt, &c.OpCount,
		&c.ErrorCount, &c.FitScore)
	if err != nil {
		return c, err
	}
	c.Kind = CommitKind(kind)
	return c, nil
}

func (s *Server) getCommit(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	c, err := scanCommit(s.db.QueryRow(r.Context(), commitSelect+` WHERE c.id=$1`, id))
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	// If commit has a source session, fetch its ops for historical record.
	out := CommitWithOps{Commit: c, Ops: []SessionOp{}}
	if c.SourceSessionID != nil {
		ops, err := loadSessionOps(r.Context(), s.db, *c.SourceSessionID)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		for _, op := range ops {
			out.Ops = append(out.Ops, makeSessionOp(op))
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// revertCommit creates a new commit that inverts the target commit's effect.
// Same conflict rule: target is unrevertible if any commit since seq has
// touched any of its entities.
func (s *Server) revertCommit(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var body RevertRequest
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

	var targetSeq int64
	var sourceSession *string
	err = tx.QueryRow(ctx, `
		SELECT seq, source_session_id FROM commits WHERE id=$1`, id,
	).Scan(&targetSeq, &sourceSession)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if sourceSession == nil {
		writeError(w, http.StatusBadRequest, "commit has no journaled ops to invert")
		return
	}
	ops, err := loadSessionOpsTx(ctx, tx, *sourceSession)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	touched, err := touchedEntities(ctx, tx, *sourceSession)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	conflicts, err := computeConflicts(ctx, tx, touched, targetSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if len(conflicts) > 0 {
		writeConflicts(w, "later commits have touched these entities", conflicts)
		return
	}

	// Build the inverse plan: walk ops in reverse, swap before/after.
	inverseOps := make([]journalOp, 0, len(ops))
	for i := len(ops) - 1; i >= 0; i-- {
		op := ops[i]
		inv := journalOp{
			Seq: op.Seq, EntityType: op.EntityType, EntityID: op.EntityID,
		}
		switch op.Op {
		case "insert":
			inv.Op = "delete"
			inv.BeforeJSON = op.AfterJSON
			inv.AfterJSON = nil
		case "delete":
			inv.Op = "insert"
			inv.BeforeJSON = nil
			inv.AfterJSON = op.BeforeJSON
		case "update":
			inv.Op = "update"
			inv.BeforeJSON = op.AfterJSON
			inv.AfterJSON = op.BeforeJSON
		}
		inverseOps = append(inverseOps, inv)
	}
	plan := orderOpsForApply(inverseOps)

	// Insert the revert commit row first so we have a seq for entity_commits.
	commitID := newID()
	var newSeq int64
	var msg *string
	if body.Message != nil && *body.Message != "" {
		msg = body.Message
	}
	revertOf := id
	err = tx.QueryRow(ctx, `
		INSERT INTO commits (id, source_session_id, parent_seq, kind, reverts_commit_id, message, sign_off)
		VALUES ($1, NULL, (SELECT MAX(seq) FROM commits), 'revert', $2, $3, $4)
		RETURNING seq`, commitID, revertOf, msg, signOff,
	).Scan(&newSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}

	if err := applyPlanToMain(ctx, tx, plan); err != nil {
		writeApplyError(w, err)
		return
	}
	if err := bumpEntityCommits(ctx, tx, plan, newSeq); err != nil {
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
	writeJSON(w, http.StatusCreated, CommitRef{CommitID: commitID, Seq: newSeq})
}

// revertToBefore creates a single new commit whose effect is the diff between
// current state and state-just-before the target. Covers every commit with
// seq in [target.seq, expected_latest_seq]. Refuses if the range contains an
// existing revert commit (those carry no journaled ops and can't be cleanly
// composed) or if a newer commit has landed since the caller observed
// expected_latest_seq.
//
// The new revert commit gets its own synthetic session journal so it shows
// the correct op_count on listCommits, and so it can itself be reverted by a
// future "revert to before here" click — closing the asymmetry where
// single-commit reverts can't be rolled back.
func (s *Server) revertToBefore(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var body RevertToBeforeRequest
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

	var targetSeq int64
	err = tx.QueryRow(ctx, `SELECT seq FROM commits WHERE id=$1`, id).Scan(&targetSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}

	var currentMaxSeq int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM commits`).Scan(&currentMaxSeq); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if body.ExpectedLatestSeq != currentMaxSeq {
		writeError(w, http.StatusConflict, "newer commits exist; refresh and retry")
		return
	}

	rows, err := tx.Query(ctx, `
		SELECT seq FROM commits
		WHERE seq BETWEEN $1 AND $2 AND kind='revert'
		ORDER BY seq`, targetSeq, currentMaxSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	var revertSeqs []int64
	for rows.Next() {
		var s int64
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			writeErrorFromDB(w, err)
			return
		}
		revertSeqs = append(revertSeqs, s)
	}
	rows.Close()
	if len(revertSeqs) > 0 {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("range contains revert commits (seq %v); revert those individually first", revertSeqs))
		return
	}

	// For each entity touched by any commit in [targetSeq, currentMaxSeq],
	// walk its ops in commit-seq order and accumulate the "earliest before"
	// value per column. After session_ops switched to partial column diffs,
	// the very-first op's before_json may only carry a subset of columns
	// (the ones THAT op touched), so we have to merge across the range: for
	// columns the first op didn't touch but a later delete op carries
	// (deletes journal full rows), the later op's before_json fills in the
	// pre-range value. First-seen-per-column always wins, since the goal is
	// the state immediately before the earliest range commit.
	rows, err = tx.Query(ctx, `
		SELECT so.entity_type, so.entity_id, so.op, so.before_json
		FROM session_ops so
		JOIN commits c ON c.source_session_id = so.session_id
		WHERE c.seq BETWEEN $1 AND $2
		ORDER BY so.entity_type, so.entity_id, c.seq ASC`, targetSeq, currentMaxSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	type entAgg struct {
		entityType   string
		entityID     string
		targetExists bool // false ⇒ entity did not exist before the range (first op was an insert)
		targetCols   map[string]json.RawMessage
	}
	aggByKey := map[string]*entAgg{}
	var entitiesInOrder []*entAgg
	for rows.Next() {
		var entityType, entityID, op string
		var beforeJSON []byte
		if err := rows.Scan(&entityType, &entityID, &op, &beforeJSON); err != nil {
			rows.Close()
			writeErrorFromDB(w, err)
			return
		}
		key := entityKey(entityType, entityID)
		a, ok := aggByKey[key]
		if !ok {
			a = &entAgg{
				entityType:   entityType,
				entityID:     entityID,
				targetExists: op != "insert",
				targetCols:   map[string]json.RawMessage{},
			}
			aggByKey[key] = a
			entitiesInOrder = append(entitiesInOrder, a)
		}
		if !a.targetExists || len(beforeJSON) == 0 {
			continue
		}
		var beforeMap map[string]json.RawMessage
		if err := json.Unmarshal(beforeJSON, &beforeMap); err != nil {
			rows.Close()
			writeErrorFromDB(w, err)
			return
		}
		for k, v := range beforeMap {
			if _, has := a.targetCols[k]; !has {
				a.targetCols[k] = v
			}
		}
	}
	rows.Close()

	idsByType := make(map[string][]string, len(entitiesInOrder))
	for _, a := range entitiesInOrder {
		idsByType[a.entityType] = append(idsByType[a.entityType], a.entityID)
	}
	currentByKey := make(map[string][]byte, len(entitiesInOrder))
	for entityType, ids := range idsByType {
		got, err := loadEntityJSONsByType(ctx, tx, entityType, ids)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		for id, js := range got {
			currentByKey[entityKey(entityType, id)] = js
		}
	}

	plan := make([]journalOp, 0, len(entitiesInOrder))
	for _, a := range entitiesInOrder {
		key := entityKey(a.entityType, a.entityID)
		current, hasCurrent := currentByKey[key]
		switch {
		case !a.targetExists && !hasCurrent:
			continue
		case !a.targetExists && hasCurrent:
			plan = append(plan, journalOp{
				EntityType: a.entityType, EntityID: a.entityID,
				Op: "delete", BeforeJSON: current, AfterJSON: nil,
			})
		case a.targetExists && !hasCurrent:
			// Entity was deleted somewhere in the range; the delete op's
			// before_json contributed the full pre-range row to targetCols.
			plan = append(plan, journalOp{
				EntityType: a.entityType, EntityID: a.entityID,
				Op: "insert", BeforeJSON: nil, AfterJSON: jsonMust(a.targetCols),
			})
		default:
			// Update: restore exactly the columns the range moved away from
			// their pre-range values. before_json is the current main slice
			// for the same keys, so the resulting op is symmetric and a
			// revert-of-revert can invert it cleanly.
			afterPartial := jsonMust(a.targetCols)
			beforePartial := sliceColumns(current, a.targetCols)
			bb, ab := trimColumnDiffToChanged(beforePartial, afterPartial)
			if bb == nil && ab == nil {
				continue
			}
			plan = append(plan, journalOp{
				EntityType: a.entityType, EntityID: a.entityID,
				Op: "update", BeforeJSON: bb, AfterJSON: ab,
			})
		}
	}

	// Synthetic session row carries the journal for the new revert commit so
	// it has an op_count and can itself be reverted later.
	sessionID := newID()
	if _, err := tx.Exec(ctx, `
		INSERT INTO sessions (id, base_seq, status, next_seq)
		VALUES ($1, $2, 'merged', $3)`, sessionID, currentMaxSeq, int64(len(plan)+1)); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	batch := &pgx.Batch{}
	for i, op := range plan {
		plan[i].Seq = int64(i + 1)
		batch.Queue(`
			INSERT INTO session_ops (session_id, seq, entity_type, entity_id, op, before_json, after_json)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			sessionID, plan[i].Seq, op.EntityType, op.EntityID, op.Op, op.BeforeJSON, op.AfterJSON)
	}
	br := tx.SendBatch(ctx, batch)
	for range plan {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			writeErrorFromDB(w, err)
			return
		}
	}
	if err := br.Close(); err != nil {
		writeErrorFromDB(w, err)
		return
	}

	commitID := newID()
	var newSeq int64
	var msg *string
	if body.Message != nil && *body.Message != "" {
		msg = body.Message
	}
	revertOf := id
	err = tx.QueryRow(ctx, `
		INSERT INTO commits (id, source_session_id, parent_seq, kind, reverts_commit_id, message, sign_off)
		VALUES ($1, $2, (SELECT MAX(seq) FROM commits), 'revert', $3, $4, $5)
		RETURNING seq`, commitID, sessionID, revertOf, msg, signOff,
	).Scan(&newSeq)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}

	ordered := orderOpsForApply(plan)
	if err := applyPlanToMain(ctx, tx, ordered); err != nil {
		writeApplyError(w, err)
		return
	}
	if err := bumpEntityCommits(ctx, tx, ordered, newSeq); err != nil {
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
	writeJSON(w, http.StatusCreated, CommitRef{CommitID: commitID, Seq: newSeq})
}
