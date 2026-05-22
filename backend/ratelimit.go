package main

// Per-IP token-bucket rate limiter, attached to the router as middleware.
//
// Scope: this is a single-process, in-memory limiter. Bucket state lives in a
// map guarded by a sync.Mutex. On Cloud Run (and any scale-to-zero deploy)
// instance bucket state evaporates on cold start, and a determined attacker
// can rotate IPs cheaply. The point of this layer is to stop the dumb-script
// case (single IP, no rotation) — by far the most common form of casual
// abuse — and to compose with whatever lives at the edge (Cloud Armor on a
// global LB, Cloudflare, etc.).
//
// Two buckets per IP, classified by HTTP method:
//   - reads (GET/HEAD): generous
//   - writes (POST/PUT/PATCH/DELETE): tight (DB ops, journal rows, disk I/O)
// OPTIONS preflight bypasses both — CORS already short-circuits it.

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type bucket struct {
	readTokens, writeTokens float64
	last                    time.Time
}

type limiter struct {
	mu            sync.Mutex
	buckets       map[string]*bucket
	rRate, rBurst float64
	wRate, wBurst float64
	trustedHops   int
	now           func() time.Time
}

// newLimiter returns a limiter with the given per-minute refill rates. Burst
// capacity is 10% of the per-minute rate, clamped to a minimum of 1. Rates
// are clamped to a minimum of 1/min so that misconfigured env vars (0 or
// negative) can't yield Inf-duration retry math — the resulting limiter
// behaves as "1 per minute" rather than producing implementation-defined
// time.Duration overflow.
//
// trustedHops is the number of proxies between this server and the client.
// 0 = no proxy (use r.RemoteAddr). 1 = one trusted hop (e.g. Cloud Run,
// where the GFE/LB writes `X-Forwarded-For: <client>, <LB>` — we trust that
// hop and read entry (len-1-hops) from the right, which is the client).
func newLimiter(readPerMin, writePerMin int64, trustedHops int) *limiter {
	if readPerMin < 1 {
		readPerMin = 1
	}
	if writePerMin < 1 {
		writePerMin = 1
	}
	if trustedHops < 0 {
		trustedHops = 0
	}
	rRate := float64(readPerMin) / 60.0
	wRate := float64(writePerMin) / 60.0
	rBurst := max(1.0, float64(readPerMin)/10.0)
	wBurst := max(1.0, float64(writePerMin)/10.0)
	return &limiter{
		buckets:     make(map[string]*bucket),
		rRate:       rRate,
		rBurst:      rBurst,
		wRate:       wRate,
		wBurst:      wBurst,
		trustedHops: trustedHops,
		now:         time.Now,
	}
}

// clientIP extracts the client IP, honoring trustedHops trusted proxies in
// front of us. With N trusted hops we take entry (len-1-N) from the right of
// X-Forwarded-For — that's the value the outermost trusted proxy itself
// wrote as the originating client. Anything further left in XFF is
// client-supplied and spoofable; anything further right is from an untrusted
// upstream proxy and not under our control.
//
// Falls back to r.RemoteAddr when XFF is missing or has fewer hops than
// configured (e.g. internal health probes that don't go through the LB).
func (l *limiter) clientIP(r *http.Request) string {
	if l.trustedHops > 0 {
		if h := r.Header.Get("X-Forwarded-For"); h != "" {
			parts := strings.Split(h, ",")
			idx := len(parts) - 1 - l.trustedHops
			if idx >= 0 && idx < len(parts) {
				ip := strings.TrimSpace(parts[idx])
				if ip != "" {
					return ip
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// take debits one token from the read or write bucket. Returns (true, 0) on
// allow; (false, retryAfter) when over budget. retryAfter is rounded up to
// the next whole second (RFC 7231 Retry-After).
func (l *limiter) take(ip string, write bool) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	b, ok := l.buckets[ip]
	if !ok {
		b = &bucket{readTokens: l.rBurst, writeTokens: l.wBurst, last: now}
		l.buckets[ip] = b
	}

	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.readTokens += elapsed * l.rRate
		if b.readTokens > l.rBurst {
			b.readTokens = l.rBurst
		}
		b.writeTokens += elapsed * l.wRate
		if b.writeTokens > l.wBurst {
			b.writeTokens = l.wBurst
		}
		b.last = now
	}

	if write {
		if b.writeTokens >= 1 {
			b.writeTokens--
			return true, 0
		}
		need := 1 - b.writeTokens
		secs := need / l.wRate
		return false, time.Duration((secs + 0.999)) * time.Second
	}
	if b.readTokens >= 1 {
		b.readTokens--
		return true, 0
	}
	need := 1 - b.readTokens
	secs := need / l.rRate
	return false, time.Duration((secs + 0.999)) * time.Second
}

// isWriteMethod returns true for HTTP methods that mutate state.
func isWriteMethod(m string) bool {
	switch m {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// shouldRateLimit decides whether a request consumes a token. We only meter
// /api/* (static assets, SPA fallback, favicon etc. are unmetered — they're
// served from disk and don't touch the DB). Within /api/* a few endpoints
// are exempt:
//
//   - /api/healthz: liveness/readiness probes share a small set of source
//     IPs and at probe frequency would exhaust the budget, triggering
//     orchestrator-driven instance kills.
//   - /api/solve/stop: release-of-resources for a runaway streaming solver.
//     It must always succeed; rate-limiting it would let the very abuse
//     case the limiter exists to stop (rapid solve clicks) make itself
//     un-cancellable.
//
// OPTIONS preflight bypasses regardless (CORS already short-circuits it).
func shouldRateLimit(r *http.Request) bool {
	if r.Method == http.MethodOptions {
		return false
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	switch r.URL.Path {
	case "/api/healthz", "/api/solve/stop":
		return false
	}
	return true
}

func (l *limiter) middleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !shouldRateLimit(r) {
			h.ServeHTTP(w, r)
			return
		}
		ip := l.clientIP(r)
		ok, retry := l.take(ip, isWriteMethod(r.Method))
		if !ok {
			secs := max(1, int(retry/time.Second))
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
		h.ServeHTTP(w, r)
	})
}

// janitor sweeps stale buckets every 5 minutes, evicting anything idle for
// more than 10 minutes. Bounds memory by active-IP count over that window.
func (l *limiter) janitor(stop <-chan struct{}) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			cutoff := l.now().Add(-10 * time.Minute)
			l.mu.Lock()
			for ip, b := range l.buckets {
				if b.last.Before(cutoff) {
					delete(l.buckets, ip)
				}
			}
			l.mu.Unlock()
		}
	}
}
