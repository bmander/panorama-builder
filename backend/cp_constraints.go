package main

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const cpConstraintCols = `id, cp_a_id, cp_b_id, constraint_type, created_at, updated_at`

func scanCPConstraint(row pgx.Row) (CPConstraint, error) {
	var c CPConstraint
	err := row.Scan(&c.ID, &c.CpAId, &c.CpBId, &c.ConstraintType, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func (s *Server) postCPConstraint(w http.ResponseWriter, r *http.Request) {
	var req CPConstraintCreate
	if !parseJSON(w, r, &req) {
		return
	}
	if !validID(req.CpAId) || !validID(req.CpBId) {
		writeError(w, http.StatusBadRequest, "invalid cp_a_id or cp_b_id")
		return
	}
	if req.CpAId == req.CpBId {
		writeError(w, http.StatusBadRequest, "cp_a_id and cp_b_id must differ")
		return
	}
	if !req.ConstraintType.Valid() {
		writeError(w, http.StatusBadRequest, "constraint_type must be 'plumb' or 'level'")
		return
	}
	a, b := req.CpAId, req.CpBId
	if a > b {
		a, b = b, a
	}

	id := newID()
	q := `INSERT INTO cp_constraints (id, cp_a_id, cp_b_id, constraint_type)
	      VALUES ($1, $2, $3, $4)
	      RETURNING ` + cpConstraintCols
	c, err := scanCPConstraint(s.db.QueryRow(r.Context(), q, id, a, b, req.ConstraintType))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23505": // unique_violation
				writeError(w, http.StatusConflict, "constraint already exists for this pair and type")
				return
			case "23503": // foreign_key_violation
				writeError(w, http.StatusNotFound, "control point not found")
				return
			}
		}
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) listCPConstraints(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT `+cpConstraintCols+` FROM cp_constraints ORDER BY created_at`)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()
	out := []CPConstraint{}
	for rows.Next() {
		c, err := scanCPConstraint(rows)
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

func (s *Server) putCPConstraint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	var req CPConstraintPatch
	if !parseJSON(w, r, &req) {
		return
	}
	if req.ConstraintType == nil {
		writeError(w, http.StatusBadRequest, "no updatable fields")
		return
	}
	if !req.ConstraintType.Valid() {
		writeError(w, http.StatusBadRequest, "constraint_type must be 'plumb' or 'level'")
		return
	}
	q := `UPDATE cp_constraints
	      SET constraint_type = $2, updated_at = NOW()
	      WHERE id = $1
	      RETURNING ` + cpConstraintCols
	c, err := scanCPConstraint(s.db.QueryRow(r.Context(), q, id, *req.ConstraintType))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "constraint already exists for this pair and type")
			return
		}
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) deleteCPConstraint(w http.ResponseWriter, r *http.Request) {
	id := requireID(w, r, "id")
	if id == "" {
		return
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM cp_constraints WHERE id = $1`, id)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
