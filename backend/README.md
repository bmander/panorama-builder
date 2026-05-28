# Viewfinder API

Minimal Go HTTP service exposing the panorama domain objects (stations,
photos with embedded pose, map measurements, image measurements) over a JSON
API. Backed by Postgres + PostGIS for metadata and local disk for photo blobs.
Also serves the frontend static files (`STATIC_DIR=../frontend/dist` by default)
so a single `make run` brings up both API and SPA on `:8080`.

## Quick start

Requires Go 1.25+ for the stdlib method-routing mux. Links Google
Ceres-Solver via cgo for bundle adjustment (see `solver/bridge.cc`);
install system deps first:

```sh
# macOS
brew install ceres-solver eigen suite-sparse glog gflags
# Linux
sudo apt install libceres-dev libeigen3-dev libsuitesparse-dev libgoogle-glog-dev libgflags-dev
```

First run:

```sh
go mod tidy                                    # fetch pgx/v5 + go.sum
docker compose up -d                           # postgres + postgis on :5432
make run                                       # API + SPA on :8080
```

Migrations under `migrations/NNNN_description.sql` run automatically at
startup, tracked in a `schema_migrations` table. To add one, drop a new
file in that directory with the next version prefix.

The API contract lives at `../openapi.yaml`. Edit the spec, then run
`make generate` to regenerate `types.gen.go` (Go) and the matching
`../frontend/src/api-types.gen.ts` (TS). Both generated files are
committed.

Make sure the frontend has been built once: `cd ../frontend && npm install && npm run build`.

Open <http://localhost:8080>. Setting a station pushes the URL to `/station/<id>`.

## Containerized dev (api + private solver)

The production architecture is one public API service plus a private
solver microservice that the API calls server-to-server. The browser only
talks to the API. The solver scales to zero independently; cold-start cost
is paid when a user-triggered solve fires.

```sh
(cd ../frontend && npm run build)   # plain build — single /api origin
make split-up                       # postgres + api + solver

# Browse http://localhost:8080 — api serves frontend + every /api/* route.
# The solver has no host port — only api reaches it on the docker network.

make split-down                     # stop the cluster
```

The api binary is built with `-tags noceres` (no cgo, no Ceres) and
forwards `/api/solve/*` calls to the solver service via `SOLVER_URL`. The
solver binary lives at `../solver/` and exposes `POST /solve`,
`POST /solve/stream`, and `POST /stop` — see `solver_client.go` and
`../shared/wire/` for the wire contract.

## Env vars

| Var               | Default                                                                          |
|-------------------|----------------------------------------------------------------------------------|
| `DATABASE_URL`    | `postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable`           |
| `STORAGE_DIR`     | `./data` (ignored if `STORAGE_BUCKET` is set)                                    |
| `STORAGE_BUCKET`  | unset (when set, blobs live in this GCS bucket instead of `STORAGE_DIR`; uses Application Default Credentials) |
| `STATIC_DIR`      | `../frontend/dist`                                                               |
| `LISTEN_ADDR`     | `:8080`                                                                          |
| `ALLOWED_ORIGIN`  | `*` (loose for local dev — set to the frontend origin in prod)                   |
| `MAX_BLOB_BYTES`  | `25000000` (25 MB)                                                               |
| `MAX_IMAGE_MEGAPIXELS` | `50` (header-only decode bomb gate on photo uploads)                        |
| `RATE_LIMIT_READ_PER_MIN`  | `600` (per-IP GET/HEAD budget; burst is 10% of this)                    |
| `RATE_LIMIT_WRITE_PER_MIN` | `60` (per-IP POST/PUT/PATCH/DELETE budget; burst is 10% of this)        |
| `TRUSTED_PROXY_HOPS` | `0` (number of trusted L7 proxies in front of this binary; e.g. `1` for Cloud Run / Cloud Run + GFE — client IP is then read from X-Forwarded-For) |
| `SOLVER_URL`      | `http://localhost:8081` (base URL of the private solver service — see `../solver/`)                                                                |

## Routes

API endpoints all live under `/api/`. Anything else is served from `STATIC_DIR`,
falling back to `index.html` (SPA `/station/<id>` and `/cp/<id>` deep-links).

| Method | Path                                |
|--------|-------------------------------------|
| GET    | `/api/healthz`                      |
| POST   | `/api/stations`                     |
| GET    | `/api/stations` (`?bbox=minLng,minLat,maxLng,maxLat`) |
| GET    | `/api/stations/{id}` (hydrated)     |
| PUT    | `/api/stations/{id}`                |
| DELETE | `/api/stations/{id}`                |
| POST   | `/api/stations/{id}/photos`         |
| GET    | `/api/photos/{id}`                  |
| PUT    | `/api/photos/{id}`                  |
| DELETE | `/api/photos/{id}`                  |
| PUT    | `/api/photos/{id}/blob`             |
| GET    | `/api/photos/{id}/blob`             |
| POST   | `/api/photos/{id}/image-measurements`    |
| PUT    | `/api/image-measurements/{id}`           |
| DELETE | `/api/image-measurements/{id}`           |
| POST   | `/api/control-points`                    |
| GET    | `/api/control-points` (`?bbox=...`)      |
| GET    | `/api/control-points/{id}`               |
| PUT    | `/api/control-points/{id}`               |
| DELETE | `/api/control-points/{id}`               |

## Backups

The Postgres data lives in the `pgdata` docker volume; photo blobs are
stored on the host under `STORAGE_DIR` (default `./data`). The two are
backed up separately.

Dump the database to a plain-SQL file via `make`:

```sh
make dump                                    # writes panorama_<UTC-timestamp>.sql
make dump DUMP_FILE=path/to/backup.sql       # explicit destination
```

This shells into the running `postgres` container and runs `pg_dump`, so
no host-side `postgres-client` is required — only `docker compose up -d`.

Restore a dump back into the running container (drops and recreates the
`public` schema first, so existing data is wiped):

```sh
make restore DUMP_FILE=path/to/backup.sql
```

To back up photos as well, snapshot `STORAGE_DIR` (e.g. `tar czf
photos.tgz data/`) alongside the SQL dump.

## Tests

Most of the suite is pure (no DB) and runs with no setup:

```sh
go test ./...
```

The merge/revert tests in `session_merge_revert_test.go` exercise the full
apply → merge → revert cycle (the rollback invariant) against live tables, so
they need a Postgres+PostGIS database. They **skip** unless `TEST_DATABASE_URL`
is set, which is why the bare `go test ./...` above stays green. The tests
truncate every domain table between runs, so point the var at a **throwaway**
database — never one whose data you care about:

```sh
docker compose up -d postgres                       # postgres + postgis on :5432
docker compose exec -T postgres createdb -U panorama panorama_test

TEST_DATABASE_URL='postgres://panorama:panorama@localhost:5432/panorama_test?sslmode=disable' \
  go test ./...
```

There is no CI test job today (the only workflow builds + deploys), so these
are run manually.

## Smoke test

Writes never touch main directly — they journal into a session and land on
merge. Every mutating call carries an `X-Session-Id` header; without it the
API returns `428 Precondition Required`. So the flow is: open a session,
write through it, then merge with a non-empty `sign_off`.

```sh
SID=$(curl -sS -X POST http://localhost:8080/api/sessions | jq -r .id)

ST=$(curl -sS -X POST http://localhost:8080/api/stations \
      -H "X-Session-Id: $SID" -H 'Content-Type: application/json' \
      -d '{"lat":47.607,"lng":-122.335,"captured_at":"2026-05-05T12:00:00Z","name":"Seattle"}' | jq -r .id)

PHOTO=$(curl -sS -X POST "http://localhost:8080/api/stations/$ST/photos" \
         -H "X-Session-Id: $SID" -H 'Content-Type: application/json' -d '{"aspect":1.5}' | jq -r .id)

curl -sS -X PUT "http://localhost:8080/api/photos/$PHOTO/blob" \
     -H "X-Session-Id: $SID" -H 'Content-Type: image/jpeg' --data-binary @sample.jpg

# Until merged, the new rows are visible only through the session overlay:
curl -sS "http://localhost:8080/api/stations/$ST" -H "X-Session-Id: $SID" | jq .

# Merge promotes the session's journal into one commit on main.
curl -sS -X POST "http://localhost:8080/api/sessions/$SID/merge" \
     -H 'Content-Type: application/json' -d '{"sign_off":"smoke test"}' | jq .

# Now the station is on main, no header needed.
curl -sS "http://localhost:8080/api/stations/$ST" | jq .
```
