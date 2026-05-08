# CLAUDE.md

Notes for future sessions in this repo.

## Project

Monorepo with two top-level dirs:

- **`frontend/`** — TypeScript frontend. Source under `frontend/src/`; `tsc` output lands in `frontend/build/` (gitignored). Three HTML entry points at `frontend/index.html`, `frontend/cp-index.html`, `frontend/cp.html` all load `build/main.js`. Loads Three.js + Leaflet via importmap from unpkg — **no bundler, no dev server, no test suite, by design**.
- **`backend/`** — Go HTTP API backed by Postgres + PostGIS. Also serves the frontend static files (`STATIC_DIR=../frontend` by default; SPA fallback for `/station/<id>`, `/cp/`, `/cp/<id>`). Stores stations (camera setup points), photos with embedded pose + lens distortion, image measurements (reticle anchors on photos, FK to a control point), and control points (cross-station landmarks with estimated location + lifespan + locks). Owns the bundle-adjustment solver. Single binary, no framework. Runs locally via `docker compose` for the DB.

## Frontend architecture

Factory functions, not classes. Each module exports a `createX({...}): X` factory plus an `interface X` for the return type. Modules under `frontend/src/`:

**Pages / routing**
- `main.ts` — entry point for all three HTML files; reads `location.pathname` and dispatches to `mountIndexPage` / `mountStationPage` / `mountCpIndex` / `mountCpPage`.
- `index-page.ts` — `/` route: Leaflet map of stations + located control points; cross-station joint-solve modal; time filter.
- `station-page.ts` — `/station/<13-char-id>` route: 360° viewer + scene wiring (photos, terrain, measurements, solver UI).
- `cp-index.ts` — `/cp/` route: searchable/sortable control-point listing.
- `cp-page.ts` — `/cp/<id>` route: inline editors for description, notes, lifespan bounds, locks; observation list.

**3D scene + bake**
- `viewer.ts` — Three.js renderer + camera; dirty-driven rAF loop.
- `overlay.ts` — scene-graph manager (overlays + POIs + selection + batched-mutation notify).
- `overlay-photos.ts` — photo texture overlays with Brown-Conrady undistortion.
- `overlay-measurements.ts` — image-measurement reticles; undistort UV logic.
- `overlay-control-points.ts` — control-point registry + links to image measurements.
- `map-poi-columns.ts` — vertical lines in 360° at every located CP (blue, yellow when selected/hovered).
- `null-cp-rays.ts` — ray visualization for null-location CPs (triangulation guides).
- `bake.ts` — cube → equirect render pipeline + canvas paint.
- `canvas-texture.ts` — CanvasTexture builder for Three.js (CP markers, photo handles).

**Map + tiles + terrain**
- `map.ts` — Leaflet view; cone / POI-bearing rendering; location picker; CP markers as crosshair-in-circle SVG divIcons.
- `dem.ts`, `imagery.ts` — Terrarium DEM + Esri imagery tile fetchers.
- `tile-cache.ts` — LRU cache for tile requests.
- `terrain.ts` — DEM-driven terrain reference, off / wireframe / shaded; meshes ride on a `terrainGroup` so live-camera moves translate (no rebuild).
- `terrain-geometry.ts` — DEM mesh construction.
- `terrain-tiles.ts` — tile fetch/cache orchestrator for DEM.
- `dot-layer.ts` — Leaflet plugin for batch dot rendering.

**Sun**
- `solar.ts`, `sun-marker.ts` — solar azimuth/altitude + visible disc.

**Input + UI shell**
- `input.ts` — pointer / keyboard / wheel state machine (discriminated-union `ModeState`); also tracks the hovered CP column for the matcher.
- `handlers.ts` — async create/observe handlers (POST photo / CP / measurement, then mutate scene).
- `ui.ts` — tabs, HUD, `triggerDownload`.
- `context-menu.ts` — right-click menu (image + map modes).
- `observation-modal.ts` — pick existing CP or create new + observe (used by both image and map flows).
- `photo-params-modal.ts` — photo pose / opacity / distortion editor.
- `start-station-modal.ts` — new-station creation dialog.
- `admin-modal.ts` — destructive station actions.
- `solve-modal.ts` — SSE-streaming joint-solve UI (live loss chart, Cancel/Stop).
- `solve-actions.ts` — single-station + single-CP solve buttons; post-solve rehydration.
- `station-fields.ts` — station metadata editor.
- `station-markers.ts` — station markers on the map.
- `station-navigation.ts` — station list + fly-to.
- `time-filter.ts` — year slider + date picker for CP lifespan filtering.

**State / sync**
- `sync.ts` — diff-based sync engine; caches synced state and issues `PUT/POST/DELETE` per diff.
- `undo.ts` — in-memory undo/redo stack (before/after mementos).
- `settings.ts` — per-session view knobs (terrain mode, haze, sun, etc.). **No localStorage** — hydration from API is authoritative.

**Cross-cutting**
- `api.ts` — typed `fetch` wrappers around `/api/*`; `photoBlobUrl(id)` for `TextureLoader.load`.
- `api-types.gen.ts` — generated from `../openapi.yaml`; regenerate via `npm run generate-types` (or `make generate` from `backend/`, which does both Go and TS).
- `geo.ts` — bearing / distance / `latLngToCameraRelativeMeters` / `M_PER_DEG_LAT`.
- `mathx.ts` — small math helpers (clamp, lerp, etc.).
- `types.ts` — cross-cutting types **and** small shared helpers (`overlayData`, `poiData`, `meshMat`, `lineMat`, `getRole`, `getElement`, `Mutable<T>`, `cpLabel`).

The active station is identified by URL path `/station/<13-char-id>`; visiting `/` is the empty/index state. The solver runs on the backend (see below) — there is no frontend solver. The frontend just POSTs and consumes SSE iterations.

## Backend architecture

Single Go package under `backend/`, with one subpackage `backend/solver/`:

**Server shell**
- `main.go` — `Server` struct, env parsing, signal-aware shutdown.
- `router.go` — stdlib mux (`mux.HandleFunc("POST /stations/{id}/photos", ...)`); `/healthz`; SPA fallback for `/station/<id>`, `/cp/`, `/cp/<id>`.
- `db.go` — pgxpool init + ping.
- `storage.go` — disk blob helpers (`STORAGE_DIR/photos/<id>`, with `errPayloadTooLarge` short-circuit).
- `ids.go` — 13-char base32 IDs from `crypto/rand`; `validID` regex.
- `cors.go` — tiny CORS middleware.
- `http.go` — `writeJSON` / `writeError` / `parseJSON` / `requireID` + range checks (`validLat`, `validLng`, `validUV`).
- `patch.go` — JSON patch helper that distinguishes absent key from explicit null.

**Domain handlers**
- `stations.go` — handlers + the cascade-fetch helpers used by the hydrated `GET /stations/{id}`.
- `photos.go` — metadata + pose + distortion CRUD plus `PUT/GET /photos/{id}/blob`.
- `image_measurements.go` — straightforward CRUD; `image_measurements.control_point_id` is the FK that ties an observation to a control point.
- `control_points.go` — CRUD for the global control-point table (description, notes, est_lat/lng/alt, lifespan bounds + flags, locks); `GET /control-points/{id}/observations` lists every image measurement that references it.

**Solver orchestration**
- `solve_handlers.go` — synchronous endpoints: `POST /api/solve/joint`, `/api/solve/stations/{id}`, `/api/solve/control-points/{id}`.
- `solve_stream.go` — SSE variant `/api/solve/joint/stream` (one JSON event per iteration) + `/api/solve/joint/stop`.
- `solver_problem_store.go` — `loadProblem(ctx, cfg)` reads stations, photos, image measurements, control points → `solver.Problem`.
- `solver_seed.go` — `seedNullLocationCPs`: triangulates null-location CPs from ≥2-station observations; skips under-constrained ones.
- `solver_writeback.go` — applies `solver.Result.Changes` in one transaction; optimistic concurrency via `updated_at` token.
- `tools.go` — small shared helpers used by solver glue.

**Solver core (`backend/solver/`)**
- `types.go` — `Pose`, `Station`, `Photo`, `ControlPoint`, `Observation`, `Problem`, `Result`, `Config`, `EntityChange`.
- `geo.go` — geodesy / cart conversions.
- `project.go` — image plane (u,v) → viewer-frame (az,el); applies Brown-Conrady distortion (K1, K2).
- `solve.go` — Gauss-Newton bundle adjustment; finite-difference Jacobian; LM damping; backtrack on divergence.
- `solve_seeded.go` — per-CP refinement starting from a seeded initial position.
- `solve_test.go`, `solve_seeded_test.go`, `geo_test.go` — unit tests (the only tests in the repo).
- `synth/` — synthetic-scenario generator used by the tests.

**Migrations + types**
- `migrations.go` + `migrations/NNNN_*.sql` — embedded migrations applied at startup; tracked in `schema_migrations`. (Map measurements existed in 0001 but were dropped in 0006/0007; estimated location now lives directly on the control point.)
- `types.gen.go` — generated from `../openapi.yaml` (the API contract); regenerate via `make generate`. Mirror file on the frontend is `frontend/src/api-types.gen.ts`.

**Domain vocabulary**: **stations** (camera setup points; formerly "locations"/"projects"), **control points** (global, cross-station landmarks with estimated location, lifespan bounds, and locks; replaced the old "map POI" / "map measurement" pair), **photos** (per-station with pose + lens distortion), **image measurements** (reticle anchors on a photo; FK to a control point — this is the "match"). Map measurements no longer exist as an entity.

External deps: `github.com/jackc/pgx/v5` (Postgres), `gonum.org/v1/gonum` (matrix math for the solver), `github.com/oapi-codegen/oapi-codegen/v2` (code generation, build-time only). Targets Go 1.22+ for stdlib method-routing.

## Conventions

### Frontend
- **Factory + interface, never class.** Don't refactor existing factories into classes.
- **Shared types in `types.ts`.** File-local types stay inline in their owning file. Don't add cross-cutting types ad-hoc; consolidate via `types.ts`.
- **No `any`.** Use `unknown` if truly needed.
- **`!` is fine** for in-bounds matrix indexing under `noUncheckedIndexedAccess`. The project's eslint config already disables `no-non-null-assertion` — don't add runtime checks just to satisfy the linter.
- **userData casts go through helpers** in `types.ts` (`overlayData(o)`, `poiData(p)`, `getRole(o)`). Don't write inline `(x.userData as Y)` at call sites.
- **DOM lookups use `getElement<T>(id)`** from `types.ts`, not `document.getElementById('id')!`.
- **Imports keep `.js` extensions** (`import { foo } from './bar.js'`) — required by both the runtime importmap and `moduleResolution: Bundler`.
- **No localStorage / IndexedDB for app state.** API is the source of truth; per-session knobs live in `settings.ts` only.

### Backend
- **Stdlib first.** Don't add chi/gin/echo/gorilla; the Go 1.22 method-routing mux is enough.
- **No ORM.** Hand-rolled SQL with prepared statements via `s.db.QueryRow` / `s.db.Query` / `s.db.Exec`.
- **Server-assigned IDs.** 13-char base32 from `newID()`. Validate every path-param id with `requireID(w, r, "id")` before any work.
- **Validation in handler-local `validate()` methods.** Range-check lat/lng, u/v, opacity, etc. Reject early with `writeError(w, 400, ...)`.
- **Solver code is pure** (no DB, no HTTP) — keep it that way. New persistence concerns belong in the `solver_*` glue files, not in `solver/`.
- **`gofmt -l .` empty, `go vet ./...` clean, `go build ./...` clean, `go test ./...` green** before commit.

## Commands

### Frontend (from `frontend/`)
- `npm run build` — `tsc` to `build/`
- `npm run watch` — `tsc -w`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint on `src/`
- `npm run lint:fix` — auto-fix safe issues
- `npm run generate-types` — regenerate `src/api-types.gen.ts` from `../openapi.yaml`

### Backend (from `backend/`)
- `make run` — `go run .` (defaults to `localhost:5432` panorama/panorama; auto-applies migrations on startup)
- `make build` — `go build -o bin/panorama-api .`
- `make fmt` / `make vet` / `make tidy`
- `make generate` — regenerate `types.gen.go` and `frontend/src/api-types.gen.ts` from `openapi.yaml`
- `go test ./...` — runs the solver tests
- `docker compose up -d` / `docker compose down` — Postgres + PostGIS lifecycle

## Don't

- Don't add a bundler, framework, or test suite (frontend or backend) without asking.
- Don't add classes (frontend) or web frameworks like chi/gin/echo (backend).
- Don't loosen `tsconfig` strictness or eslint presets; don't add an ORM or schema-validator dep without asking.
- Don't reintroduce localStorage or IndexedDB for app state.
- Don't write new `.md` files unless asked.

## End-to-end smoke test

### Frontend
`cd frontend && npm run lint && npm run typecheck` should both exit 0, then `npm run build` (or `npm run watch`) to compile.

The Go backend serves the frontend on `:8080`, so smoke tests are: bring up the backend (below), visit `http://localhost:8080/`, set a camera location → URL updates to `/station/<id>`, drop a JPEG. Browser console should be silent.

### Backend
`go build ./... && go vet ./... && go test ./...` from `backend/` should exit 0. Then:

```sh
cd backend
docker compose up -d
make run                                     # API on :8080 (auto-migrates)
```

Smoke-test via `curl` per `backend/README.md`. Tear down with `^C` and `docker compose down`.
