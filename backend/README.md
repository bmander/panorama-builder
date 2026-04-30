# panorama-builder API

Minimal Go HTTP service exposing the panorama domain objects (locations,
photos with embedded pose, map POIs, image POIs) over a JSON API. Backed by
Postgres + PostGIS for metadata and local disk for photo blobs.

## Quick start

Requires Go 1.22+ for the stdlib method-routing mux. First run:

```sh
go mod tidy                                    # fetch pgx/v5 + go.sum
docker compose up -d                           # postgres + postgis on :5432
make schema                                    # one-time table creation
make run                                       # API on :8080
```

## Env vars

| Var               | Default                                                                          |
|-------------------|----------------------------------------------------------------------------------|
| `DATABASE_URL`    | `postgres://panorama:panorama@localhost:5432/panorama?sslmode=disable`           |
| `STORAGE_DIR`     | `./data`                                                                         |
| `LISTEN_ADDR`     | `:8080`                                                                          |
| `ALLOWED_ORIGIN`  | `*` (loose for local dev — set to the frontend origin in prod)                   |
| `MAX_BLOB_BYTES`  | `50000000` (50 MB)                                                               |

## Endpoints

| Method | Path                              |
|--------|-----------------------------------|
| GET    | `/healthz`                        |
| POST   | `/locations`                      |
| GET    | `/locations` (`?bbox=minLng,minLat,maxLng,maxLat`) |
| GET    | `/locations/{id}` (hydrated)      |
| PUT    | `/locations/{id}`                 |
| DELETE | `/locations/{id}`                 |
| POST   | `/locations/{id}/photos`          |
| GET    | `/photos/{id}`                    |
| PUT    | `/photos/{id}`                    |
| DELETE | `/photos/{id}`                    |
| PUT    | `/photos/{id}/blob`               |
| GET    | `/photos/{id}/blob`               |
| POST   | `/locations/{id}/map-pois`        |
| PUT    | `/map-pois/{id}`                  |
| DELETE | `/map-pois/{id}`                  |
| POST   | `/photos/{id}/image-pois`         |
| PUT    | `/image-pois/{id}`                |
| DELETE | `/image-pois/{id}`                |

## Smoke test

```sh
LOC=$(curl -sS -X POST http://localhost:8080/locations \
       -H 'Content-Type: application/json' \
       -d '{"lat":47.607,"lng":-122.335,"name":"Seattle"}' | jq -r .id)

PHOTO=$(curl -sS -X POST "http://localhost:8080/locations/$LOC/photos" \
         -H 'Content-Type: application/json' -d '{"aspect":1.5}' | jq -r .id)

curl -sS -X PUT "http://localhost:8080/photos/$PHOTO/blob" \
     -H 'Content-Type: image/jpeg' --data-binary @sample.jpg

curl -sS "http://localhost:8080/locations/$LOC" | jq .
```
