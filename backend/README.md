# panorama-builder API

Minimal Go HTTP service exposing the panorama domain objects (stations,
photos with embedded pose, map measurements, image measurements) over a JSON
API. Backed by Postgres + PostGIS for metadata and local disk for photo blobs.
Also serves the frontend static files (`STATIC_DIR=../frontend` by default)
so a single `make run` brings up both API and SPA on `:8080`.

## Quick start

Requires Go 1.22+ for the stdlib method-routing mux. First run:

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

Open <http://localhost:8080>. Setting a station pushes the URL to `/<id>`.

## Env vars

| Var               | Default                                                                          |
|-------------------|----------------------------------------------------------------------------------|
| `DATABASE_URL`    | `postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable`           |
| `STORAGE_DIR`     | `./data`                                                                         |
| `STATIC_DIR`      | `../frontend`                                                                    |
| `LISTEN_ADDR`     | `:8080`                                                                          |
| `ALLOWED_ORIGIN`  | `*` (loose for local dev — set to the frontend origin in prod)                   |
| `MAX_BLOB_BYTES`  | `50000000` (50 MB)                                                               |

## Routes

API endpoints all live under `/api/`. Anything else is served from `STATIC_DIR`,
falling back to `index.html` (SPA `/<id>` deep-links).

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
| POST   | `/api/stations/{id}/map-measurements`    |
| PUT    | `/api/map-measurements/{id}`             |
| DELETE | `/api/map-measurements/{id}`             |
| POST   | `/api/photos/{id}/image-measurements`    |
| PUT    | `/api/image-measurements/{id}`           |
| DELETE | `/api/image-measurements/{id}`           |
| POST   | `/api/control-points`                    |
| GET    | `/api/control-points` (`?bbox=...`)      |
| GET    | `/api/control-points/{id}`               |
| PUT    | `/api/control-points/{id}`               |
| DELETE | `/api/control-points/{id}`               |

## Smoke test

```sh
ST=$(curl -sS -X POST http://localhost:8080/api/stations \
      -H 'Content-Type: application/json' \
      -d '{"lat":47.607,"lng":-122.335,"name":"Seattle"}' | jq -r .id)

PHOTO=$(curl -sS -X POST "http://localhost:8080/api/stations/$ST/photos" \
         -H 'Content-Type: application/json' -d '{"aspect":1.5}' | jq -r .id)

curl -sS -X PUT "http://localhost:8080/api/photos/$PHOTO/blob" \
     -H 'Content-Type: image/jpeg' --data-binary @sample.jpg

curl -sS "http://localhost:8080/api/stations/$ST" | jq .
```
