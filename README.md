# panorama-builder

Tools for compositing flat photos into a 360° equirectangular panorama and sharing them. The frontend is a browser-only TypeScript app; the backend is a small Go HTTP service that stores the constituent objects (locations, photos with pose, map POIs, image POIs).

## Layout

- `frontend/` — TypeScript frontend. `frontend/src/` is the TS source; `frontend/build/` is the `tsc` output. No bundler.
- `backend/` — Go API service backed by Postgres + PostGIS. Also serves the frontend static files. See `backend/README.md`.

## Frontend

```sh
cd frontend
npm install
npm run watch                  # tsc watch mode → frontend/build/
```

The Go backend serves `frontend/` (`STATIC_DIR=../frontend` by default), so visit <http://localhost:8080> after starting the backend below.

## Backend

```sh
cd backend
docker compose up -d                         # postgis/postgis:16-3.4 on :5432
make schema                                  # one-time table creation
make run                                     # API on :8080
```

`backend/README.md` lists env vars, endpoints, and a curl smoke test.

## Use

- **Map tab** (default until a camera location is set) — click *Set location*, then click on the map. Drag the camera marker to refine. *+ POI* drops a free-floating map landmark (blue crosshair on the map; blue column in 360°).
- **360° tab** — pan with mouse, zoom with wheel. Drop a JPEG/PNG to add a photo overlay. Drag a photo to reposition; corner handles to resize; shift-drag to roll. *+ POI* drops an image marker on the photo.
- **Match by hover** — in 360°, hover a blue map-POI column to highlight it; click on the underlying photo to create a paired image-POI anchored to that landmark. The pose solver kicks in once a photo has anchored POIs.
- **⚙ Settings** — Lock camera position, Auto-solve photo rotation, Terrain mode (off / wireframe / shaded), sun datetime, photo opacity, atmospheric haze, Earth curvature, atmospheric refraction.
- **Save…** / **Load…** / **Clear** — round-trip the project as a JSON bundle (photos base64-encoded inline) or wipe IDB.
- **download PNG** — 8192-wide composite of the current panorama.

## Stack

- **Frontend**: TypeScript (strict + `noUncheckedIndexedAccess`), Three.js, Leaflet, IndexedDB. No bundler. Three.js + Leaflet loaded via importmap from unpkg.
- **Backend**: Go 1.22+ stdlib `net/http` (method routing), `pgx/v5`, Postgres + PostGIS, local-disk photo blobs.

Frontend scripts (run from `frontend/`): `build`, `watch`, `typecheck`, `lint`, `lint:fix`. Backend tasks: `cd backend && make {run,build,fmt,vet,tidy,schema}`.
