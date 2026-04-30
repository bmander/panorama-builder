package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Server struct {
	db            *pgxpool.Pool
	blobs         *blobStore
	allowedOrigin string
	maxBlobBytes  int64
}

func main() {
	listenAddr := envDefault("LISTEN_ADDR", ":8080")
	dbURL := envDefault("DATABASE_URL",
		"postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable")
	storageDir := envDefault("STORAGE_DIR", "./data")
	allowedOrigin := envDefault("ALLOWED_ORIGIN", "*")
	maxBlobBytes := envInt64("MAX_BLOB_BYTES", 50_000_000)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	pool, err := openDB(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	blobs, err := newBlobStore(storageDir)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}

	s := &Server{
		db:            pool,
		blobs:         blobs,
		allowedOrigin: allowedOrigin,
		maxBlobBytes:  maxBlobBytes,
	}

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
