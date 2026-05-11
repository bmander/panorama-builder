package main

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Writes (POST/PUT/DELETE) require an open session. List remains
// session-agnostic for now; the index-page CP-constraint reader doesn't yet
// apply the overlay (TODO).

const cpConstraintCols = `id, cp_a_id, cp_b_id, constraint_type, created_at, updated_at`

func scanCPConstraint(row pgx.Row) (CPConstraint, error) {
	var c CPConstraint
	err := row.Scan(&c.ID, &c.CpAId, &c.CpBId, &c.ConstraintType, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func (s *Server) postCPConstraint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.postCPConstraintInSession(w, r, sess)
}

func (s *Server) listCPConstraints(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listCPConstraintsInSession(w, r, sess)
		return
	}
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
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.putCPConstraintInSession(w, r, sess)
}

func (s *Server) deleteCPConstraint(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.deleteCPConstraintInSession(w, r, sess)
}
