# CLAUDE.md

Notes for future sessions in this repo.

## Project

Browser-only panorama composition tool. ~1300 LOC TypeScript across `src/`. Loads Three.js + Leaflet via importmap from unpkg — **no bundler, no dev server, no test suite, by design**. The compile step is just `tsc`; output lands in `build/` (gitignored), and `index.html` loads `build/main.js`.

## Architecture

Factory functions, not classes. Each module exports a `createX({...}): X` factory plus an `interface X` for the return type. Modules:

- `viewer.ts` — Three.js renderer + camera; dirty-driven rAF loop
- `overlay.ts` — scene-graph manager (overlays + POIs + selection + batched-mutation notify)
- `bake.ts` — cube → equirect render pipeline + canvas paint
- `map.ts` — Leaflet view; cone / POI-bearing rendering; location picker
- `input.ts` — pointer / keyboard / wheel state machine (discriminated-union `ModeState`)
- `solver.ts` — Gauss-Newton pose solver (no DOM, no Three)
- `geo.ts` — bearing / distance helpers
- `ui.ts` — tabs, HUD, tools, download
- `main.ts` — wires everything; no exports
- `types.ts` — cross-cutting types **and** small shared helpers (`overlayData`, `poiData`, `meshMat`, `lineMat`, `getRole`, `getElement`, `Mutable<T>`)

`main.ts` owns the solve loop. `runSolve()` is the single re-entrancy guard around `solveAllPhotos()`; three call sites invoke it (mutation notify, location pick, lock toggle).

## Conventions

- **Factory + interface, never class.** Don't refactor existing factories into classes.
- **Shared types in `types.ts`.** File-local types stay inline in their owning file. Don't add cross-cutting types ad-hoc; consolidate via `types.ts`.
- **No `any`.** Use `unknown` if truly needed.
- **`!` is fine** for in-bounds matrix indexing under `noUncheckedIndexedAccess`. The project's eslint config already disables `no-non-null-assertion` — don't add runtime checks just to satisfy the linter.
- **userData casts go through helpers** in `types.ts` (`overlayData(o)`, `poiData(p)`, `getRole(o)`). Don't write inline `(x.userData as Y)` at call sites.
- **DOM lookups use `getElement<T>(id)`** from `types.ts`, not `document.getElementById('id')!`.
- **Imports keep `.js` extensions** (`import { foo } from './bar.js'`) — required by both the runtime importmap and `moduleResolution: Bundler`.

## Commands

- `npm run build` — `tsc` to `build/`
- `npm run watch` — `tsc -w`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint on `src/`
- `npm run lint:fix` — auto-fix safe issues

## Don't

- Don't add a bundler, framework, or test suite without asking.
- Don't add classes.
- Don't loosen `tsconfig` strictness or eslint presets.
- Don't write new `.md` files unless asked.

## End-to-end smoke test

`npm run lint && npm run typecheck` should both exit 0. Then:

```sh
python3 -m http.server 8765
```

Open `http://localhost:8765?v=N` (cache-buster bypasses the static server's cache). Drop a JPEG onto the page (a synthesized `DragEvent` with a fetched blob works for headless tests). Toggle the lock checkbox. Switch through 360° / Map / Flat tabs. Browser console should be silent.
