# panorama-builder

Browser-based tool for compositing flat photos into a 360° equirectangular panorama. Pick a camera location on a historical map, drop photos onto the panorama sphere, anchor each photo's POIs to map locations, and the pose solver fits each photo's azimuth, FOV, and (optionally) the camera location automatically.

## Run

```sh
npm install
npm run watch                  # tsc watch mode
python3 -m http.server 8000    # any static server
```

Open <http://localhost:8000>.

## Use

- **360° tab** — pan with mouse, zoom with wheel. Drop a JPEG/PNG to add an overlay. Drag to reposition; corner handles to resize.
- **POI tool** — click on an overlay to drop a marker, then click on the **Map tab** to anchor it to a real-world lat/lng. Once a photo has anchored markers, the pose solver runs automatically.
- **Lock camera position** — keeps the camera fixed at the user-set lat/lng, turning a 4+ POI fit from exact to least-squares.
- **Map tab** — shows each photo's bearing cone and POI bearings. Pick a location with a click; drag the marker to refine.
- **Flat tab** — flat preview of the equirect bake.
- **download PNG** — 8192-wide composite.

## Stack

- TypeScript (strict + `noUncheckedIndexedAccess`), no bundler
- Three.js, Leaflet (loaded via importmap from unpkg)
- ESLint with typescript-eslint `strict-type-checked` + `stylistic-type-checked`

Scripts: `build`, `watch`, `typecheck`, `lint`, `lint:fix`.
