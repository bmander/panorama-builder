//go:build !noceres

// Solver microservice. Receives an opaque solver.Problem + Config (plus
// optional SeededCPIDs) over HTTP and runs solver.Solve or
// SolveJointWithSeed against a Ceres-Solver-linked binary. No DB, no
// session knowledge, no public ingress — the api service is the only
// caller. See ../../solver/dto.go for the wire contract.
//
// Gated on the default (no-noceres) build because it imports the Ceres-
// bound parts of backend/solver. `go build -tags noceres ./...` skips
// this package entirely.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type server struct {
	// solveMu serializes Ceres runs. The bridge is solo-user-scale (one
	// active solve at a time across the whole process); a single global
	// mutex avoids the bookkeeping of per-instance pools.
	solveMu sync.Mutex
	// activeStop is non-nil while a streaming solve is in flight; sending
	// on it signals the solver loop to break gracefully (the "stop here"
	// button). Guarded by activeStopMu so /stop can fire while the solve
	// still holds solveMu.
	activeStopMu sync.Mutex
	activeStop   chan struct{}
}

func main() {
	listenAddr := envDefault("LISTEN_ADDR", ":8080")

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	s := &server{}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("POST /solve", s.postSolve)
	mux.HandleFunc("POST /solve/stream", s.postSolveStream)
	mux.HandleFunc("POST /stop", s.postStop)

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("solver listening on %s", listenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func (s *server) healthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func envDefault(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
