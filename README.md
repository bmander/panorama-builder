# panorama-builder

Tools for compositing flat photos into a 360° equirectangular panorama, anchoring them to shared landmarks across multiple camera setups, and recovering camera pose by bundle adjustment. The frontend is a browser-only TypeScript app; the backend is a small Go HTTP service that stores the domain objects (stations, photos with pose, image measurements, control points) and runs the solver.

## Layout

- `frontend/` — TypeScript frontend. `frontend/src/` is the TS source; `frontend/build/` is the `tsc` output. No bundler. Three HTML entry points: `index.html` (map + station list), `cp-index.html` (control-point listing), `cp.html` (control-point detail). All load `build/main.js`, which dispatches by URL.
- `backend/` — Go API service backed by Postgres + PostGIS. Also serves the frontend static files and owns the Gauss-Newton bundle-adjustment solver. See `backend/README.md`.
- `openapi.yaml` — single source of truth for the API contract. `make generate` (from `backend/`) regenerates both the Go (`backend/types.gen.go`) and TS (`frontend/src/api-types.gen.ts`) type files.

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
make run                                     # API on :8080; migrations run on startup
```

`backend/README.md` lists env vars, endpoints, and a curl smoke test.

## Use

- **Index page** (`/`) — Leaflet map of all stations and located control points. Click *Add station* to drop a camera setup; a station id is assigned and the URL becomes `/station/<id>`. The cross-station *Solve* button opens a streaming joint-solve modal with a live loss chart.
- **Station page** (`/station/<id>`) —
  - **Map tab** (default until a camera location is set) — drag the camera marker to refine. Right-click a feature on the map to attach an existing control point or create a new one.
  - **360° tab** — pan with mouse, zoom with wheel. Drop a JPEG/PNG to add a photo overlay. Drag a photo to reposition; corner handles to resize; shift-drag to roll. Right-click on a photo to drop an image measurement and link it to a control point.
  - **Match by hover** — in 360°, hover a blue control-point column to highlight it; click on the underlying photo to create a paired image measurement anchored to that landmark. Hit *Solve* to refine pose for this station only.
  - **⚙ Settings** — Lock camera position, terrain mode (off / wireframe / shaded), sun datetime, photo opacity, atmospheric haze, Earth curvature, atmospheric refraction.
  - **download PNG** — 8192-wide composite of the current panorama.
- **Control-point pages** —
  - `/cp/` lists all control points (searchable, sortable).
  - `/cp/<id>` shows description / notes / lifespan bounds / locks and every observation across stations. *Solve this CP* triangulates from current observations.

## Stack

- **Frontend**: TypeScript (strict + `noUncheckedIndexedAccess`), Three.js, Leaflet. No bundler. Three.js + Leaflet loaded via importmap from unpkg. No localStorage / IndexedDB — the API is authoritative.
- **Backend**: Go 1.22+ stdlib `net/http` (method routing), `pgx/v5`, `gonum` (matrix math for the solver), Postgres + PostGIS, local-disk photo blobs.

Frontend scripts (run from `frontend/`): `build`, `watch`, `typecheck`, `lint`, `lint:fix`, `generate-types`. Backend tasks: `cd backend && make {run,build,fmt,vet,tidy,generate}`; `go test ./...` runs the solver tests.
