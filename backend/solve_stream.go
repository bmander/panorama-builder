package main

import "net/http"

// Streaming joint solve is disabled while writes are required to land in a
// session. Implementing the streaming variant against the session journal
// is deferred (the iteration-progress UI would need per-iteration ops or a
// different in-memory accumulator). Until then, this endpoint always 409s.

func (s *Server) postSolveJointStream(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusConflict,
		"streaming solve is not supported; use POST /api/solve/joint")
}

// postSolveJointStop survives only to keep the route table tidy — there's
// no in-flight streaming run to stop. Treat as a no-op.
func (s *Server) postSolveJointStop(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotFound, "no active solve")
}
