package main

import (
	"errors"
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
	       END AS op_count
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
		&c.RevertsCommitID, &c.Message, &c.SignOff, &c.CreatedAt, &c.OpCount)
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
