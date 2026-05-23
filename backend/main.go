package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	db             *pgxpool.Pool
	blobs          blobStore
	solver         *solverClient
	staticDir      string
	allowedOrigin  string
	maxBlobBytes   int64
	maxImagePixels int64
	limiter        *limiter
	// solveMu serializes /api/solve/* runs on this api instance. The solver
	// service has its own serialization too; the api-side mutex keeps each
	// instance's load+writeback wrapper single-threaded so concurrent
	// session writebacks don't interleave. /api/solve/stop targets the
	// solver service directly (POST /stop), so it doesn't need
	// per-handler state on the api side.
	solveMu sync.Mutex
}

func main() {
	// Force every time.Time we touch (incl. those scanned from TIMESTAMPTZ
	// by pgx) into UTC for JSON serialization. Otherwise the Go runtime's
	// host TZ leaks: pre-1883 Pacific instants come back with the LMT
	// offset -07:52:58, which JSON-encodes truncated to -07:52, silently
	// shifting the instant by 58s on every round-trip.
	time.Local = time.UTC

	listenAddr := envDefault("LISTEN_ADDR", ":8080")
	dbURL := envDefault("DATABASE_URL",
		"postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable")
	storageDir := envDefault("STORAGE_DIR", "./data")
	storageBucket := envDefault("STORAGE_BUCKET", "")
	solverURL := envDefault("SOLVER_URL", "http://localhost:8081")
	staticDir := envDefault("STATIC_DIR", "../frontend/dist")
	allowedOrigin := envDefault("ALLOWED_ORIGIN", "*")
	maxBlobBytes := envInt64("MAX_BLOB_BYTES", 25_000_000)
	maxMegapixels := envInt64("MAX_IMAGE_MEGAPIXELS", 50)
	if maxMegapixels < 1 {
		maxMegapixels = 50
	}
	maxImagePixels := maxMegapixels * 1_000_000
	readPerMin := envInt64("RATE_LIMIT_READ_PER_MIN", 600)
	writePerMin := envInt64("RATE_LIMIT_WRITE_PER_MIN", 60)
	trustedProxyHops := int(envInt64("TRUSTED_PROXY_HOPS", 0))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pool, err := openDB(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	if err := runMigrations(ctx, pool); err != nil {
		log.Fatalf("migrations: %v", err)
	}

	blobs, err := newBlobStore(ctx, storageDir, storageBucket)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}

	if err := migrateLegacyBlobs(ctx, pool, blobs); err != nil {
		log.Fatalf("blob migration: %v", err)
	}

	solver, err := newSolverClient(ctx, solverURL)
	if err != nil {
		log.Fatalf("solver client: %v", err)
	}

	s := &Server{
		db:             pool,
		blobs:          blobs,
		solver:         solver,
		staticDir:      staticDir,
		allowedOrigin:  allowedOrigin,
		maxBlobBytes:   maxBlobBytes,
		maxImagePixels: maxImagePixels,
		limiter:        newLimiter(readPerMin, writePerMin, trustedProxyHops),
	}

	janitorStop := make(chan struct{})
	go s.limiter.janitor(janitorStop)

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on %s", listenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	close(janitorStop)
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func envDefault(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
