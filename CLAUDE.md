# CLAUDE.md

Notes for future sessions in this repo.

## Project

Monorepo with two parts:

- **`src/`** — TypeScript frontend. Browser-only panorama composition tool. Loads Three.js + Leaflet via importmap from unpkg — **no bundler, no dev server, no test suite, by design**. The compile step is just `tsc`; output lands in `build/` (gitignored), and `index.html` loads `build/main.js`.
- **`backend/`** — Go HTTP API backed by Postgres + PostGIS. Stores locations, photos with embedded pose, map POIs, image POIs (which optionally reference a map POI to encode a "match"). Single binary, no framework. Runs locally via `docker compose` for the DB.

## Frontend architecture

Factory functions, not classes. Each module exports a `createX({...}): X` factory plus an `interface X` for the return type. Modules:

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
- `persistence.ts` — IndexedDB-backed snapshot + photo-blob store; `replaceAll` and `clearAll` for the Save/Load/Clear flow
- `ui.ts` — tabs, HUD, `triggerDownload`
- `main.ts` — wires everything; no exports
- `types.ts` — cross-cutting types **and** small shared helpers (`overlayData`, `poiData`, `meshMat`, `lineMat`, `getRole`, `getElement`, `Mutable<T>`)

`main.ts` owns the solve loop. `runSolve()` is the single re-entrancy guard around `solveAllPhotos()`. The 360° tab is gated on `mapView.getLocation() !== null` via `applyLocationGate()`.

## Backend architecture

Single Go package under `backend/`:

- `main.go` — `Server` struct, env parsing, signal-aware shutdown
- `router.go` — stdlib mux (`mux.HandleFunc("POST /locations/{id}/photos", ...)`) + `/healthz`
- `db.go` — pgxpool init + ping
- `storage.go` — disk blob helpers (`STORAGE_DIR/photos/<id>`, with `errPayloadTooLarge` short-circuit)
- `ids.go` — 13-char base32 IDs from `crypto/rand`; `validID` regex
- `cors.go` — tiny CORS middleware
- `http.go` — `writeJSON` / `writeError` / `parseJSON` / `requireID` + range checks (`validLat`, `validLng`, `validUV`)
- `locations.go` — handlers + the cascade-fetch helpers used by the hydrated `GET /locations/{id}`
- `photos.go` — metadata + pose CRUD plus `PUT/GET /photos/{id}/blob`
- `map_pois.go`, `image_pois.go` — straightforward CRUD; `image_pois.map_poi_id` is the FK that encodes a "match"
- `schema.sql` — single-shot table creation (4 tables)

Sole external dep: `github.com/jackc/pgx/v5`. Targets Go 1.22+ for stdlib method-routing.

## Conventions

### Frontend
- **Factory + interface, never class.** Don't refactor existing factories into classes.
- **Shared types in `types.ts`.** File-local types stay inline in their owning file. Don't add cross-cutting types ad-hoc; consolidate via `types.ts`.
- **No `any`.** Use `unknown` if truly needed.
- **`!` is fine** for in-bounds matrix indexing under `noUncheckedIndexedAccess`. The project's eslint config already disables `no-non-null-assertion` — don't add runtime checks just to satisfy the linter.
- **userData casts go through helpers** in `types.ts` (`overlayData(o)`, `poiData(p)`, `getRole(o)`). Don't write inline `(x.userData as Y)` at call sites.
- **DOM lookups use `getElement<T>(id)`** from `types.ts`, not `document.getElementById('id')!`.
- **Imports keep `.js` extensions** (`import { foo } from './bar.js'`) — required by both the runtime importmap and `moduleResolution: Bundler`.

### Backend
- **Stdlib first.** Only `pgx/v5` so far. Don't add chi/gin/echo/gorilla; the Go 1.22 method-routing mux is enough.
- **No ORM.** Hand-rolled SQL with prepared statements via `s.db.QueryRow` / `s.db.Query` / `s.db.Exec`.
- **Server-assigned IDs.** 13-char base32 from `newID()`. Validate every path-param id with `requireID(w, r, "id")` before any work.
- **Validation in handler-local `validate()` methods.** Range-check lat/lng, u/v, opacity, etc. Reject early with `writeError(w, 400, ...)`.
- **`gofmt -l .` empty, `go vet ./...` clean, `go build ./...` clean** before commit.

## Commands

### Frontend (from repo root)
- `npm run build` — `tsc` to `build/`
- `npm run watch` — `tsc -w`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint on `src/`
- `npm run lint:fix` — auto-fix safe issues

### Backend (from `backend/`)
- `make run` — `go run .` (defaults to `localhost:5432` panorama/panorama)
- `make build` — `go build -o bin/panorama-api .`
- `make fmt` / `make vet` / `make tidy`
- `make schema` — apply `schema.sql`
- `docker compose up -d` / `docker compose down` — Postgres + PostGIS lifecycle

## Don't

- Don't add a bundler, framework, or test suite (frontend or backend) without asking.
- Don't add classes (frontend) or web frameworks like chi/gin/echo (backend).
- Don't loosen `tsconfig` strictness or eslint presets; don't add an ORM or schema-validator dep without asking.
- Don't write new `.md` files unless asked.

## End-to-end smoke test

### Frontend
`npm run lint && npm run typecheck` should both exit 0. Then:

```sh
python3 -m http.server 8765
```

Open `http://localhost:8765?v=N` (cache-buster bypasses the static server's cache). The app starts on the Map tab with the 360° tab disabled until a location is set. Click *Set location* → click on the map → 360° tab enables. Drop a JPEG. Switch to 360°. Browser console should be silent.

### Backend
`go build ./... && go vet ./...` from `backend/` should exit 0. Then:

```sh
cd backend
docker compose up -d
make schema
make run                                     # API on :8080
```

Smoke-test via `curl` per `backend/README.md`. Tear down with `^C` and `docker compose down`.
