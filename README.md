# Viewfinder

A collaborative web app for working out **where photographs were taken**. You set up a *station* (a camera location), drop photos into a 360° view and aim them, mark *control points* — landmarks shared across photos and stations — and a bundle-adjustment solver recovers each photo's pose and each landmark's geographic position. Terrain, sky, and sun overlays aid alignment, and an aligned station can be baked into an equirectangular panorama.

Contributions are account-less but safe: every change is journaled in a session and only reaches `main` behind an explicit sign-off, and every commit is revertible (see [Trust model](#trust-model)).

## Layout

A Go workspace (`go.work`) of three Go modules plus the frontend:

- `frontend/` — TypeScript SPA (Three.js + Leaflet). `frontend/src/` is the source; **Vite** bundles it to `frontend/dist/` (gitignored). Three.js and Leaflet are npm dependencies.
- `backend/` — Go HTTP API (stdlib method-routing mux, `pgx/v5`, Postgres + PostGIS; photo blobs on local disk or GCS). Serves the `/api/*` endpoints and the built frontend. See `backend/README.md`.
- `solver/` — Go bundle-adjustment service linking Google Ceres-Solver via cgo. The backend calls it over HTTP (`SOLVER_URL`); it has no database access.
- `shared/` — Go types shared between backend and solver (the `wire` package).
- `openapi.yaml` — the API contract. `make generate` (from `backend/`) regenerates the Go and TypeScript types from it; both generated files are committed.

## Run it locally

**Frontend** — Vite dev server with hot reload:

```sh
cd frontend
npm install
npm run dev                    # http://localhost:5173 (proxies /api → :8080)
```

**Backend + database:**

```sh
cd backend
docker compose up -d           # Postgres + PostGIS on :5432
make run                       # API on :8080 (migrations apply on startup)
```

Iterate against the Vite server on <http://localhost:5173>. For a production-like check, `npm run build` then open the API at <http://localhost:8080> — it serves `frontend/dist/` (`STATIC_DIR=../frontend/dist` by default).

**Solver** — needed only for the *Solve* action. The API calls it at `SOLVER_URL` (default `http://localhost:8081`). The simplest way to bring up Postgres, API, and solver together is the dockerized split:

```sh
cd backend
make split-up                  # docker compose --profile app up -d --build
make split-down                # tear it down
```

To run the solver outside Docker, install Ceres-Solver first (`brew install ceres-solver eigen suite-sparse glog gflags`, or the `libceres-dev` / `libeigen3-dev` / `libsuitesparse-dev` apt packages), then `cd solver && LISTEN_ADDR=:8081 go run .`.

`backend/README.md` covers env vars, endpoints, and a curl smoke test.

## Use

The app is a few pages over the same API:

- **Map (`/`)** — the landing page: a Leaflet map of every station (with photo-coverage cones) and located control point. Right-click to **Start station here** (create a station and upload photos) or **Add control point here**. A date-range slider filters by capture time.
- **Station view (`/world?sta=<id>`)** — the editor: a 360° Three.js scene with an inset map, terrain, and sky.
  - Drop a JPEG/PNG to add a photo; drag it to aim, corner handles to resize, shift-drag to roll; or set azimuth / tilt / roll / FOV / opacity and lens distortion (k1, k2) in the side panel, locking any axis the solver should leave fixed.
  - Right-click a photo for **Add observation here** — anchor a point on the image to a control point (existing or new). Right-click a control-point marker to mark it **Present / Absent / Obscured**, jump to **View control point →**, or **Zoom to…** another station that observes it.
  - **Edit → Solve → Save**: start an editing session, run the bundle-adjustment **Solve** (a modal with tolerances, regularization, and a live loss chart), then **Save** behind a sign-off. **Abandon** discards the session.
  - Extras: a **Sun dial** (estimate the sun's position from a gnomon CP and its shadow), CP **constraints** / **surfaces** (plumb/level geometry hints), terrain & sky **Display** settings, and **Download PNG** (an 8192-wide equirectangular bake).
- **Lists** — `/stations`, `/photos`, and `/cp` are sortable tables of stations, photos (pose + 1σ), and control points (with fit RMS). `/cp/<id>` is a control point's detail page: observations, lifespan, notes, and per-station visibility.
- **History (`/history`)** — the append-only commit log: who signed off, how many changes, and the fit score. **View changes** shows the op diff; **Revert to before here** undoes a commit (behind its own sign-off).

## Trust model

Panorama-builder follows a Wikipedia-style **radical trust** model: anonymous users can contribute, and there are no accounts. Two principles keep this safe:

1. **Intentional.** No edit reaches `main` without an explicit sign-off. Writes accumulate in a server-issued *session* (append-only journal of ops), and only a `POST /api/sessions/{id}/merge` carrying a non-empty `sign_off` promotes them into a commit. The same rule should govern any path that mutates shared state (e.g. `revert`).
2. **Non-destructive.** Every contribution is rollback-able. The commit log is append-only; merges and reverts are themselves commits; the session journal preserves before/after snapshots so a revert can replay the inverse. Disk/blob state must follow the same rule — bytes that back a row must not be overwritten or lost outside of a journaled, revertible step.

If you're adding a write path, schema-level cascade, or any operation that touches stored bytes, check it against both principles before merging.

## Stack

- **Frontend**: TypeScript (strict + `noUncheckedIndexedAccess`), Three.js, Leaflet, bundled with Vite. Factory-function modules, no UI framework, no test suite (by design).
- **Backend**: Go 1.25+ stdlib `net/http` (method routing), `pgx/v5`, Postgres + PostGIS; photo blobs on local disk or GCS.
- **Solver**: Go + Google Ceres-Solver via cgo, reached over HTTP; the `shared/wire` package carries the request/response types.

## Testing

The frontend has no test suite (by design). The Go modules do: `make test` from the repo root runs `go test ./...` across all three. Most tests are pure and need no setup, so this stays green out of the box. The backend's merge/revert rollback tests additionally exercise the apply → merge → revert cycle against a live Postgres+PostGIS database; they skip unless `TEST_DATABASE_URL` points at a throwaway DB. See [`backend/README.md`](backend/README.md#tests) for how to run them. There is no CI test job yet — tests are run manually.

## Commands

- **Frontend** (from `frontend/`): `npm run {dev, build, typecheck, lint, lint:fix, generate-types}`.
- **Go workspace** (from the repo root): `make {build, vet, fmt, tidy, test}` loops over all three modules; `make {typecheck, lint}` runs the frontend gates.
- **Backend** (from `backend/`): `make {run, build, fmt, vet, tidy, generate}`; `make {split-up, split-down}` for the full dockerized stack; `docker compose up -d` / `down` for just Postgres.

## Deploy

Pushing to the `prod` branch triggers the GitHub Actions workflow in `.github/workflows/deploy.yml`: it builds and pushes the API and solver container images to Artifact Registry and rolls new Google Cloud Run revisions.
