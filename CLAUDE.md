# CLAUDE.md

Notes for future sessions in this repo.

## Project

Monorepo with two top-level dirs:

- **`frontend/`** — TypeScript frontend. Source under `frontend/src/`; **Vite** bundles to `frontend/dist/` (gitignored). Six HTML entry points at `frontend/*.html` (index, cp, cp-index, history, photos-index, stations-index), each loading its TS entry via `<script type="module" src="/src/<name>.ts">`. Three.js + Leaflet are npm `dependencies` (no importmap). Static CSS lives in `frontend/public/` and is copied to `dist/` as-is. **Vite for build + dev server with HMR; no test suite, by design.**
- **`backend/`** — Go HTTP API backed by Postgres + PostGIS. Also serves the frontend static files (`STATIC_DIR=../frontend/dist` by default; SPA fallback for `/station/<id>` and `/cp/<id>` routes). Stores stations (camera setup points), photos with embedded pose, map measurements, image measurements (which optionally reference a control point to encode a "match"). Single binary, no framework. Runs locally via `docker compose` for the DB.

## Trust model (load-bearing)

Panorama-builder is a **radically trusting**, account-less app — anyone reaching the API can contribute. Two invariants keep that safe; preserve both when adding write paths or schema changes:

1. **Intentional.** No mutation reaches `main` without an explicit, user-supplied sign-off. Today this is enforced by funneling every write through `s.requireSession` (`backend/session.go`) — writes journal ops into `session_ops` rather than touching main tables — and by `mergeSession` rejecting an empty `sign_off`. The same gate should apply to anything that alters shared state, including reverts.
2. **Non-destructive.** Every change must be rollback-able. The commit log is append-only; `session_ops.before_json/after_json` carry full row snapshots so `revertCommit` can apply the inverse. Disk-backed state (photo blobs) must obey the same rule — don't overwrite or delete bytes outside a journaled, revertible step.

### Rules for new code

- **New write endpoint?** Call `s.requireSession(w, r)` first; mutate via `recordOp` / `recordOpDirect`, never directly against main. The solver writeback in `solver_writeback.go` is the canonical example.
- **New entity type?** Add it to `entityRank` in `session.go`, to the `session_ops.entity_type` CHECK constraint (see migration `0022_session_ops_cp_surface.sql`), and to `insertEntityFromJSON` / `updateEntityFromJSON` / `deleteEntityByID` in `session_apply.go`.
- **`ON DELETE CASCADE` in a migration?** The cascade must be explicitly walked + journaled in the corresponding `delete*InSession` handler (see `deleteStationInSession` for the pattern). A cascade that fires only at merge time will silently bypass the journal and break revert.
- **Touching disk bytes (blobs)?** Don't overwrite by id. Blob bytes that back a row must survive a revert of the row's deletion — content-addressing or per-session staging is the right shape; direct `id`-keyed `os.Rename` is not.
- **New "destructive" operation (revert, bulk delete, etc.)?** It needs the same sign-off shape as merge — non-empty `sign_off` recorded on the resulting commit row (`commits.sign_off` exists for this).

## Frontend architecture

Factory functions, not classes. Each module exports a `createX({...}): X` factory plus an `interface X` for the return type. Modules under `frontend/src/`:

- `viewer.ts` — Three.js renderer + camera; dirty-driven rAF loop
- `overlay.ts` — scene-graph manager (overlays + POIs + selection + batched-mutation notify; standalone map-POI list lives here too)
- `bake.ts` — cube → equirect render pipeline + canvas paint
- `map.ts` — Leaflet view; cone / POI-bearing rendering; location picker; map-POI marker rendering (crosshair-in-circle SVG divIcons)
- `map-poi-columns.ts` — vertical lines in 360° at every map-anchored lat/lng (blue, yellow when selected/hovered)
- `terrain.ts` — DEM-driven terrain reference, off / wireframe / shaded; meshes ride on a `terrainGroup` so live-camera moves translate (no rebuild)
- `dem.ts`, `imagery.ts` — tile fetchers (DEM via Terrarium, imagery via Esri)
- `solar.ts`, `sun-marker.ts` — solar azimuth/altitude + visible disc
- `input.ts` — pointer / keyboard / wheel state machine (discriminated-union `ModeState`); also tracks the hovered map-POI column for the matcher
- `solver.ts` — Gauss-Newton pose solver (no DOM, no Three)
- `geo.ts` — bearing / distance / `latLngToCameraRelativeMeters` / `M_PER_DEG_LAT`
- `api.ts` — typed `fetch` wrappers around the backend (`/api/*`); plus `photoBlobUrl(id)` for `TextureLoader.load`
- `prefs.ts` — localStorage-backed per-station view state (azimuth, fov, terrain mode, etc.)
- `ui.ts` — tabs, HUD, `triggerDownload`
- `main.ts` — wires everything; URL parsing, hydrate from API, diff-based sync via `flushSync`, async create handlers
- `types.ts` — cross-cutting types **and** small shared helpers (`overlayData`, `poiData`, `meshMat`, `lineMat`, `getRole`, `getElement`, `Mutable<T>`)

`main.ts` owns the solve loop. `runSolve()` is the single re-entrancy guard around `solveAllPhotos()`. The 360° tab is gated on `mapView.getLocation() !== null` via `applyLocationGate()`. The active station is identified by URL path `/station/<13-char-id>`; visiting `/` is the empty state.

## Backend architecture

Single Go package under `backend/`:

- `main.go` — `Server` struct, env parsing, signal-aware shutdown
- `router.go` — stdlib mux (`mux.HandleFunc("POST /stations/{id}/photos", ...)`) + `/healthz`
- `db.go` — pgxpool init + ping
- `storage.go` — disk blob helpers (`STORAGE_DIR/photos/<id>`, with `errPayloadTooLarge` short-circuit)
- `ids.go` — 13-char base32 IDs from `crypto/rand`; `validID` regex
- `cors.go` — tiny CORS middleware
- `http.go` — `writeJSON` / `writeError` / `parseJSON` / `requireID` + range checks (`validLat`, `validLng`, `validUV`)
- `stations.go` — handlers + the cascade-fetch helpers used by the hydrated `GET /stations/{id}`
- `photos.go` — metadata + pose CRUD plus `PUT/GET /photos/{id}/blob`
- `map_measurements.go`, `image_measurements.go` — straightforward CRUD; `image_measurements.control_point_id` is the FK that encodes a "match"
- `migrations.go` + `migrations/NNNN_*.sql` — embedded migrations applied at startup; tracked in `schema_migrations`
- `types.gen.go` — generated from `../openapi.yaml` (the API contract); regenerate via `make generate`. Mirror file on the frontend is `frontend/src/api-types.gen.ts`
- Domain vocabulary: **stations** (camera setup points; formerly "locations"/"projects"), **control points** (cross-station landmarks with latent estimated locations), **map measurements** (per-station ground-truth observations on the map; formerly "map POI"), **image measurements** (reticle anchors on photos; formerly "image POI"). Both measurement types FK to a control point

Sole external dep: `github.com/jackc/pgx/v5`. Targets Go 1.22+ for stdlib method-routing.

## Conventions

### Frontend
- **Factory + interface, never class.** Don't refactor existing factories into classes.
- **Shared types in `types.ts`.** File-local types stay inline in their owning file. Don't add cross-cutting types ad-hoc; consolidate via `types.ts`.
- **No `any`.** Use `unknown` if truly needed.
- **`!` is fine** for in-bounds matrix indexing under `noUncheckedIndexedAccess`. The project's eslint config already disables `no-non-null-assertion` — don't add runtime checks just to satisfy the linter.
- **userData casts go through helpers** in `types.ts` (`overlayData(o)`, `poiData(p)`, `getRole(o)`). Don't write inline `(x.userData as Y)` at call sites.
- **DOM lookups use `getElement<T>(id)`** from `types.ts`, not `document.getElementById('id')!`.
- **Imports keep `.js` extensions** (`import { foo } from './bar.js'`) — historical from the importmap days; Vite + `moduleResolution: Bundler` accept them and we keep the convention so all imports look the same.

### Backend
- **Stdlib first.** Only `pgx/v5` so far. Don't add chi/gin/echo/gorilla; the Go 1.22 method-routing mux is enough.
- **No ORM.** Hand-rolled SQL with prepared statements via `s.db.QueryRow` / `s.db.Query` / `s.db.Exec`.
- **Server-assigned IDs.** 13-char base32 from `newID()`. Validate every path-param id with `requireID(w, r, "id")` before any work.
- **Validation in handler-local `validate()` methods.** Range-check lat/lng, u/v, opacity, etc. Reject early with `writeError(w, 400, ...)`.
- **`gofmt -l .` empty, `go vet ./...` clean, `go build ./...` clean** before commit.

## Commands

### Frontend (from `frontend/`)
- `npm run dev` — Vite dev server on `:5173` with HMR; proxies `/api/*` to backend at `:8080`
- `npm run build` — Vite production build to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint on `src/`
- `npm run lint:fix` — auto-fix safe issues

### Backend (from `backend/`)
- `make run` — `go run .` (defaults to `localhost:5432` panorama/panorama)
- `make build` — `go build -o bin/panorama-api .`
- `make fmt` / `make vet` / `make tidy`
- `make generate` — regenerate `types.gen.go` and `frontend/src/api-types.gen.ts` from `openapi.yaml`
- `docker compose up -d` / `docker compose down` — Postgres + PostGIS lifecycle

## Don't

- Don't add a frontend framework (React/Vue/Svelte) or test suite without asking. Vite is the bundler; don't swap it out.
- Don't add classes (frontend) or web frameworks like chi/gin/echo (backend).
- Don't loosen `tsconfig` strictness or eslint presets; don't add an ORM or schema-validator dep without asking.
- Don't write new `.md` files unless asked.

## End-to-end smoke test

### Frontend
`cd frontend && npm run lint && npm run typecheck && npm run build` should all exit 0.

Two ways to run:
- **Dev**: `npm run dev` serves on `:5173` with HMR; the Vite config proxies `/api/*` to the backend at `:8080`. Use this for iterating on TS/CSS.
- **Prod-like**: `npm run build` then run the backend (it serves from `frontend/dist/`). Visit `http://localhost:8080/`. Use this to verify a full build path before commit.

Smoke test: set a camera location → URL updates to `/station/<id>`, drop a JPEG. Browser console should be silent.

### Backend
`go build ./... && go vet ./...` from `backend/` should exit 0. Then:

```sh
cd backend
docker compose up -d
make run                                     # API on :8080 (auto-migrates)
```

Smoke-test via `curl` per `backend/README.md`. Tear down with `^C` and `docker compose down`.
