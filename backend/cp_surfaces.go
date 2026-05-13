package main

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Writes (POST/DELETE) require an open session. List remains
// session-agnostic when no session header is provided, mirroring
// the cp_constraints reader behavior.

const cpSurfaceCols = `id, cp_1_id, cp_2_id, cp_3_id, cp_4_id, created_at, updated_at`

func scanCPSurface(row pgx.Row) (CPSurface, error) {
	var s CPSurface
	err := row.Scan(&s.ID, &s.Cp1ID, &s.Cp2ID, &s.Cp3ID, &s.Cp4ID, &s.CreatedAt, &s.UpdatedAt)
	return s, err
}

func (s *Server) postCPSurface(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.postCPSurfaceInSession(w, r, sess)
}

func (s *Server) listCPSurfaces(w http.ResponseWriter, r *http.Request) {
	if sess, ok := s.tryLoadSession(w, r); !ok {
		return
	} else if sess != nil {
		s.listCPSurfacesInSession(w, r, sess)
		return
	}
	rows, err := s.db.Query(r.Context(),
		`SELECT `+cpSurfaceCols+` FROM cp_surfaces ORDER BY created_at`)
	if err != nil {
		writeErrorFromDB(w, err)
		return
	}
	defer rows.Close()
	out := []CPSurface{}
	for rows.Next() {
		v, err := scanCPSurface(rows)
		if err != nil {
			writeErrorFromDB(w, err)
			return
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		writeErrorFromDB(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) deleteCPSurface(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	s.deleteCPSurfaceInSession(w, r, sess)
}
