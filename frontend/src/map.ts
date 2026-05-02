import * as L from 'leaflet';
import type * as THREE from 'three';
import { R_EARTH, bearingFromLocation, viewerAzToBearing, bearingToViewerAz } from './geo.js';
import type { Cone, LatLng, MapMeasurementView, ImageMeasurementBearing } from './types.js';
import { TILE_PX, fetchTileElevations, tileYToLat } from './dem.js';

export interface ProjectMarker {
  id: string;
  latlng: LatLng;
  label: string;
}

// Fetched-on-click summary of a project, used at the index view to preview
// what's inside without navigating into it.
export interface ProjectPreview {
  origin: LatLng;
  cones: Cone[];
  linkedMapPOIs: readonly LatLng[];
}

export interface IndexControlPoint {
  id: string;
  latlng: LatLng;
  description: string;
}

export interface MapView {
  getLocation(): LatLng | null;
  setLocation(latlng: LatLng | null): void;
  viewerAzToAnchor(latlng: LatLng): number;
  setOverlayCones(newCones: Cone[]): void;
  setImageMeasurementBearings(newPOIs: ImageMeasurementBearing[]): void;
  setMapMeasurements(mapPois: readonly MapMeasurementView[]): void;
  setProjectMarkers(projects: readonly ProjectMarker[]): void;
  setProjectPreview(preview: ProjectPreview | null): void;
  // Index-view dots: every control point with a location estimate, drawn as
  // small red markers regardless of which project owns them. Click → popup
  // with a link to the CP's detail page.
  setIndexControlPoints(cps: readonly IndexControlPoint[]): void;
  isVisible(): boolean;
  onShow(): void;
  onHide(): void;
  toggleMapPoiArm(): void;
  // Disarms armed states. Used on tab switch so the user doesn't get
  // surprised by stale arming when they come back to the Map tab.
  disarmAll(): void;
}

export interface CreateMapViewOptions {
  container: HTMLElement;
  onLocationChange?: (loc: LatLng) => void;
  onPOIAnchorClick?: (handle: THREE.Mesh, latlng: LatLng) => void;
  onMapPoiArmedAddClick?: (latlng: LatLng) => void;
  onMapPoiClick?: (id: string) => void;
  onMapPoiDragged?: (id: string, latlng: LatLng) => void;
  onProjectMarkerOpen?: (id: string) => void;
  onProjectMarkerPreview?: (id: string) => void;
  onStartProjectHere?: (latlng: LatLng) => void;
  onControlPointSolveLocation?: (id: string) => void;
  onShowRefresh?: () => void;
  onMapPoiArmedChange?: (armed: boolean) => void;
}

const HIST_ATTR = 'Historical maps via <a href="https://bmander.com/seamap">bmander.com/seamap</a>';
const histLayer = (year: number, opts: L.TileLayerOptions = {}): L.TileLayer => L.tileLayer(
  `https://storage.googleapis.com/seatimemap/${year}/{z}/{x}/{y}.png`,
  { minZoom: 12, maxZoom: 20, attribution: HIST_ATTR, ...opts },
);

// Client-side hillshade rendered from the same Terrarium PNG tiles the 3D
// terrain mesh uses. Sun NW (azimuth 315°) at 45° elevation — the standard
// cartographic convention.
const SUN_AZ_RAD = 315 * Math.PI / 180;
const SUN_ALT_RAD = 45 * Math.PI / 180;
const SUN_E = Math.sin(SUN_AZ_RAD) * Math.cos(SUN_ALT_RAD);
const SUN_N = Math.cos(SUN_AZ_RAD) * Math.cos(SUN_ALT_RAD);
const SUN_U = Math.sin(SUN_ALT_RAD);

function metersPerWebMercatorPixel(lat: number, z: number): number {
  return 156543.03 * Math.cos(lat * Math.PI / 180) / 2 ** z;
}

function renderHillshade(elev: Float32Array, cellSize: number): ImageData {
  const img = new ImageData(TILE_PX, TILE_PX);
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const xm = x === 0 ? x : x - 1;
      const xp = x === TILE_PX - 1 ? x : x + 1;
      const ym = y === 0 ? y : y - 1;
      const yp = y === TILE_PX - 1 ? y : y + 1;
      const dzdE = (elev[y * TILE_PX + xp]! - elev[y * TILE_PX + xm]!) / (2 * cellSize);
      // Image y increases southward, so dz/dN = −dz/d(image_y).
      const dzdN = -(elev[yp * TILE_PX + x]! - elev[ym * TILE_PX + x]!) / (2 * cellSize);
      const nE = -dzdE;
      const nN = -dzdN;
      const dot = nE * SUN_E + nN * SUN_N + SUN_U;
      const norm = Math.sqrt(nE * nE + nN * nN + 1);
      const shade = Math.max(0, dot / norm);
      const gray = Math.min(255, Math.round(255 * shade));
      const o = (y * TILE_PX + x) * 4;
      img.data[o] = gray;
      img.data[o + 1] = gray;
      img.data[o + 2] = gray;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

const HillshadeCtor = L.GridLayer.extend({
  createTile(this: L.GridLayer, coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    void (async (): Promise<void> => {
      const elev = await fetchTileElevations(coords.z, coords.x, coords.y);
      const ctx = canvas.getContext('2d');
      if (!ctx) { done(undefined, canvas); return; }
      if (!elev) {
        ctx.fillStyle = '#101010';
        ctx.fillRect(0, 0, TILE_PX, TILE_PX);
        done(undefined, canvas);
        return;
      }
      const tileLat = tileYToLat(coords.y + 0.5, coords.z);
      const cellSize = metersPerWebMercatorPixel(tileLat, coords.z);
      ctx.putImageData(renderHillshade(elev, cellSize), 0, 0);
      done(undefined, canvas);
    })();
    return canvas;
  },
}) as unknown as new (opts?: L.GridLayerOptions) => L.GridLayer;

function createHillshadeLayer(): L.GridLayer {
  return new HillshadeCtor({
    minZoom: 8,
    maxZoom: 14,
    attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
  });
}

function destination(loc: LatLng, bearingDeg: number, distM: number): LatLng {
  const bRad = bearingDeg * Math.PI / 180;
  const dLat = (distM / R_EARTH) * Math.cos(bRad) * 180 / Math.PI;
  const dLng = (distM / R_EARTH) * Math.sin(bRad) * 180 / Math.PI / Math.cos(loc.lat * Math.PI / 180);
  return { lat: loc.lat + dLat, lng: loc.lng + dLng };
}

function projectClickToRay(loc: LatLng, bearingDeg: number, click: L.LatLng): LatLng {
  // Flat-earth projection of click onto the ray (loc, bearing); clamps t≥0 (no points behind apex).
  const cosLat = Math.cos(loc.lat * Math.PI / 180);
  const dLat = click.lat - loc.lat;
  const dE = (click.lng - loc.lng) * cosLat;
  const bRad = bearingDeg * Math.PI / 180;
  const dirN = Math.cos(bRad), dirE = Math.sin(bRad);
  const t = Math.max(0, dLat * dirN + dE * dirE);
  return { lat: loc.lat + t * dirN, lng: loc.lng + (t * dirE) / cosLat };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function pixelsToMeters(map: L.Map, pixels: number): number {
  const c = map.getCenter();
  const p = map.latLngToContainerPoint(c);
  const ll2 = map.containerPointToLatLng(L.point(p.x + pixels, p.y));
  return c.distanceTo(ll2);
}

export function createMapView({
  container,
  onLocationChange,
  onPOIAnchorClick,
  onMapPoiArmedAddClick,
  onMapPoiClick,
  onMapPoiDragged,
  onProjectMarkerOpen,
  onProjectMarkerPreview,
  onStartProjectHere,
  onControlPointSolveLocation,
  onShowRefresh,
  onMapPoiArmedChange,
}: CreateMapViewOptions): MapView {
  const layers: Record<string, L.Layer> = {
    'Sanborn 1884': histLayer(1884),
    'Sanborn 1888': histLayer(1888),
    'Sanborn 1893': histLayer(1893),
    'Baist 1908':   histLayer(1908, { maxNativeZoom: 19 }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }),
    'Hillshade': createHillshadeLayer(),
  };

  const baseLayer = layers['Sanborn 1893']!;
  const map = L.map(container, { layers: [baseLayer] })
    .setView([47.607, -122.335], 14);
  L.control.layers(layers, {}, { collapsed: false, position: 'topleft' }).addTo(map);

  let location: LatLng | null = null;
  let marker: L.Marker | null = null;
  let cones: Cone[] = [];
  const coneLayers: L.Polygon[] = [];
  let pois: ImageMeasurementBearing[] = [];
  const poiLayers: L.Polyline[] = [];
  // Tracks the last-applied selected state per polyline, so we only call
  // setStyle (an SVG attribute write that can trigger layout) when the
  // color actually needs to change.
  const poiSelectedState: boolean[] = [];
  let mapPoiData: readonly MapMeasurementView[] = [];
  // Track the last-applied selected state alongside the marker. Calling
  // setIcon() rebuilds the marker's DOM element, which kills any drag in
  // progress, so we only swap when selection actually changes.
  const mapPoiMarkers = new Map<string, { marker: L.Marker; selected: boolean }>();
  let visible = false;
  let mapPoiArmed = false;
  function setMapPoiArmed(v: boolean): void {
    if (mapPoiArmed === v) return;
    mapPoiArmed = v;
    container.classList.toggle('armed', mapPoiArmed);
    onMapPoiArmedChange?.(v);
  }

  const CONE_STYLE: L.PolylineOptions = { color: '#ffd84a', weight: 1, fillColor: '#ffd84a', fillOpacity: 0.18 };
  const POI_COLOR = '#ff5050';
  const SELECTED_COLOR = '#ffff66';
  const POI_STYLE: L.PolylineOptions = { color: POI_COLOR, weight: 2, opacity: 0.8 };
  // Crosshair-inside-a-circle, matching the procedural reticle in overlay.ts.
  // viewBox -1..1 keeps the same geometry constants as the shader (ring at
  // r=0.7, crosshair lines from |x|=0.10 to 0.85). stroke="currentColor" lets
  // the actual color come from the CSS `color` of the parent .poi-anchor-marker
  // div — so toggling the .selected class on the marker swaps blue→yellow
  // without re-rendering the SVG.
  const RETICLE_SVG = `<svg width="36" height="36" viewBox="-1 -1 2 2" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="0" cy="0" r="0.7" fill="none" stroke="currentColor" stroke-width="0.12"/>`
    + `<path d="M -0.85 0 L -0.1 0 M 0.1 0 L 0.85 0 M 0 -0.85 L 0 -0.1 M 0 0.1 L 0 0.85" `
    + `stroke="currentColor" stroke-width="0.12" stroke-linecap="round" fill="none"/>`
    + `</svg>`;
  const ANCHOR_ICON = L.divIcon({
    className: 'poi-anchor-marker',
    html: RETICLE_SVG,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
  const ANCHOR_ICON_SELECTED = L.divIcon({
    className: 'poi-anchor-marker selected',
    html: RETICLE_SVG,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
  const projectMarkers = new Map<string, L.Marker>();
  // Preview overlay drawn at the index view when a project marker is clicked.
  // Distinct from the live cone/POI layers (which are driven by the loaded
  // project's overlay manager) since previews are fed from a separate API
  // fetch and rendered relative to the project marker's own location.
  let projectPreview: ProjectPreview | null = null;
  const previewConeLayers: L.Polygon[] = [];
  const previewDotLayers: L.CircleMarker[] = [];
  const PREVIEW_DOT_STYLE: L.PathOptions = {
    radius: 4, color: '#ff5050', weight: 1, fillColor: '#ff5050',
    fillOpacity: 0.85, interactive: false,
  } as L.CircleMarkerOptions;
  let indexControlPoints: readonly IndexControlPoint[] = [];
  const indexCpDotLayers: L.CircleMarker[] = [];
  const INDEX_CP_DOT_STYLE: L.PathOptions = {
    radius: 3, color: '#ff5050', weight: 1, fillColor: '#ff5050',
    fillOpacity: 0.9,
  } as L.CircleMarkerOptions;
  const INDEX_CP_POPUP_OPTS: L.PopupOptions = { className: 'index-cp-popup', closeButton: true };
  const GO_POPUP_OPTS: L.PopupOptions = { className: 'project-popup', closeButton: true };
  const goButtonHtml = (label: string): string => `<button type="button" class="go">${label}</button>`;
  const solveButtonHtml = (): string => '<button type="button" class="go solve-location">Solve location</button>';
  function wireGoButton(popup: L.Popup, onClick: () => void): void {
    const btn = popup.getElement()?.querySelector<HTMLButtonElement>('.go');
    btn?.addEventListener('click', () => {
      map.closePopup(popup);
      onClick();
    }, { once: true });
  }

  function screenDiagonalMeters(): number {
    const s = map.getSize();
    return pixelsToMeters(map, Math.hypot(s.x, s.y));
  }

  function syncLayerPool<TItem, TLayer extends L.Layer>(
    items: TItem[],
    layerPool: TLayer[],
    makeLayer: () => TLayer,
    applyLatLngs: (layer: TLayer, item: TItem, distM: number) => void,
  ): void {
    if (!location || items.length === 0) {
      while (layerPool.length) map.removeLayer(layerPool.pop()!);
      return;
    }
    while (layerPool.length > items.length) map.removeLayer(layerPool.pop()!);
    while (layerPool.length < items.length) layerPool.push(makeLayer().addTo(map));
    const distM = screenDiagonalMeters();
    for (let i = 0; i < items.length; i++) {
      const layer = layerPool[i]!;
      const item = items[i]!;
      applyLatLngs(layer, item, distM);
    }
  }

  function redrawCones(): void {
    if (!visible) return;
    syncLayerPool<Cone, L.Polygon>(cones, coneLayers,
      () => L.polygon([[0, 0], [0, 0], [0, 0]], CONE_STYLE),
      (layer, c, distM) => {
        const loc = location!;
        const ptL = destination(loc, viewerAzToBearing(c.azL), distM);
        const ptR = destination(loc, viewerAzToBearing(c.azR), distM);
        layer.setLatLngs([
          [loc.lat, loc.lng],
          [ptL.lat, ptL.lng],
          [ptR.lat, ptR.lng],
        ]);
      });
  }

  function redrawPOIs(): void {
    if (!visible) return;
    syncLayerPool<ImageMeasurementBearing, L.Polyline>(pois, poiLayers,
      () => L.polyline([[0, 0], [0, 0]], POI_STYLE),
      (layer, p, distM) => {
        const loc = location!;
        const pt = destination(loc, viewerAzToBearing(p.az), distM);
        layer.setLatLngs([[loc.lat, loc.lng], [pt.lat, pt.lng]]);
      });
    // Trim the parallel selected-state array to match the (possibly shrunk) pool.
    poiSelectedState.length = poiLayers.length;
    // Re-bind click handlers — closures need fresh poi references.
    for (let i = 0; i < poiLayers.length; i++) {
      const poi = pois[i]!;
      const layer = poiLayers[i]!;
      const handle = poi.handle;
      const az = poi.az;
      if (poiSelectedState[i] !== poi.selected) {
        layer.setStyle({ color: poi.selected ? SELECTED_COLOR : POI_COLOR });
        poiSelectedState[i] = poi.selected;
      }
      layer.off('click');
      layer.on('click', (e: L.LeafletMouseEvent) => {
        if (!location) return;
        const projected = projectClickToRay(location, viewerAzToBearing(az), e.latlng);
        onPOIAnchorClick?.(handle, projected);
        L.DomEvent.stopPropagation(e);
      });
    }
  }

  function redrawMapPoiAnchors(): void {
    if (!visible) return;
    const wanted = new Map<string, MapMeasurementView>();
    for (const m of mapPoiData) wanted.set(m.id, m);
    for (const [id, entry] of mapPoiMarkers) {
      if (!wanted.has(id)) { map.removeLayer(entry.marker); mapPoiMarkers.delete(id); }
    }
    for (const [id, view] of wanted) {
      const icon = view.selected ? ANCHOR_ICON_SELECTED : ANCHOR_ICON;
      const existing = mapPoiMarkers.get(id);
      if (!existing) {
        const m = L.marker([view.latlng.lat, view.latlng.lng], { draggable: true, icon }).addTo(map);
        m.on('drag', (e: L.LeafletEvent) => {
          const ll = (e.target as L.Marker).getLatLng();
          onMapPoiDragged?.(id, ll);
        });
        mapPoiMarkers.set(id, { marker: m, selected: view.selected });
      } else {
        existing.marker.setLatLng([view.latlng.lat, view.latlng.lng]);
        if (existing.selected !== view.selected) {
          existing.marker.setIcon(icon);
          existing.selected = view.selected;
        }
      }
      const entry = mapPoiMarkers.get(id)!;
      entry.marker.off('click');
      entry.marker.on('click', (e: L.LeafletMouseEvent) => {
        onMapPoiClick?.(id);
        L.DomEvent.stopPropagation(e);
        if (!view.controlPointId) return;
        const popupHtml = `<span class="name">cp ${escapeHtml(view.controlPointId.slice(0, 6))}</span>`
          + `<a class="go" href="/cp/${view.controlPointId}">View details →</a>`
          + solveButtonHtml();
        const popup = L.popup(INDEX_CP_POPUP_OPTS)
          .setLatLng([view.latlng.lat, view.latlng.lng])
          .setContent(popupHtml)
          .openOn(map);
        const solveBtn = popup.getElement()?.querySelector<HTMLButtonElement>('.solve-location');
        solveBtn?.addEventListener('click', () => {
          map.closePopup(popup);
          onControlPointSolveLocation?.(view.controlPointId!);
        }, { once: true });
      });
      entry.marker.off('contextmenu');
      entry.marker.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        L.DomEvent.stopPropagation(e);
      });
    }
  }

  function redrawProjectPreview(): void {
    if (!visible) return;
    while (previewConeLayers.length) map.removeLayer(previewConeLayers.pop()!);
    while (previewDotLayers.length) map.removeLayer(previewDotLayers.pop()!);
    if (!projectPreview) return;
    const distM = screenDiagonalMeters();
    const origin = projectPreview.origin;
    for (const c of projectPreview.cones) {
      const ptL = destination(origin, viewerAzToBearing(c.azL), distM);
      const ptR = destination(origin, viewerAzToBearing(c.azR), distM);
      const poly = L.polygon([
        [origin.lat, origin.lng],
        [ptL.lat, ptL.lng],
        [ptR.lat, ptR.lng],
      ], CONE_STYLE).addTo(map);
      previewConeLayers.push(poly);
    }
    for (const dot of projectPreview.linkedMapPOIs) {
      previewDotLayers.push(L.circleMarker([dot.lat, dot.lng], PREVIEW_DOT_STYLE).addTo(map));
    }
  }

  function redrawIndexControlPoints(): void {
    if (!visible) return;
    while (indexCpDotLayers.length) map.removeLayer(indexCpDotLayers.pop()!);
    for (const cp of indexControlPoints) {
      const dot = L.circleMarker([cp.latlng.lat, cp.latlng.lng], INDEX_CP_DOT_STYLE);
      const openPopup = (): void => {
        const label = cp.description || `cp ${cp.id.slice(0, 6)}`;
        const popupHtml = `<span class="name">${escapeHtml(label)}</span>`
          + `<a class="go" href="/cp/${cp.id}">View details →</a>`
          + solveButtonHtml();
        const popup = L.popup(INDEX_CP_POPUP_OPTS)
          .setLatLng([cp.latlng.lat, cp.latlng.lng])
          .setContent(popupHtml)
          .openOn(map);
        const solveBtn = popup.getElement()?.querySelector<HTMLButtonElement>('.solve-location');
        solveBtn?.addEventListener('click', () => {
          map.closePopup(popup);
          onControlPointSolveLocation?.(cp.id);
        }, { once: true });
      };
      dot.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        openPopup();
      });
      dot.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        L.DomEvent.stopPropagation(e);
      });
      dot.addTo(map);
      indexCpDotLayers.push(dot);
    }
  }

  function redrawAll(): void { redrawCones(); redrawPOIs(); redrawMapPoiAnchors(); redrawProjectPreview(); redrawIndexControlPoints(); }

  function ensureMarker(latlng: L.LatLngExpression): void {
    if (marker) { marker.setLatLng(latlng); return; }
    marker = L.marker(latlng, { draggable: true }).addTo(map);
    marker.on('drag', (e: L.LeafletEvent) => {
      const ll = (e.target as L.Marker).getLatLng();
      location = { lat: ll.lat, lng: ll.lng };
      onLocationChange?.(location);
      redrawAll();
    });
  }

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (mapPoiArmed) {
      setMapPoiArmed(false);
      onMapPoiArmedAddClick?.({ lat: e.latlng.lat, lng: e.latlng.lng });
    }
  });
  map.on('contextmenu', (e: L.LeafletMouseEvent) => {
    // Skip when the right-click landed on a marker or popup — those have
    // their own contextmenu / popup handling and we don't want to clobber it.
    const target = e.originalEvent.target as Element | null;
    if (target?.closest('.leaflet-marker-icon, .leaflet-popup')) return;
    L.DomEvent.preventDefault(e.originalEvent);
    const latlng: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
    const popup = L.popup(GO_POPUP_OPTS)
      .setLatLng(e.latlng)
      .setContent(goButtonHtml('Start project here'))
      .openOn(map);
    wireGoButton(popup, () => onStartProjectHere?.(latlng));
  });
  map.on('zoomend', redrawAll);
  map.on('resize', redrawAll);

  return {
    getLocation: () => location,
    // Programmatic move from the pose solver. Does NOT fire onLocationChange (which would
    // re-trigger the solver and feedback-loop).
    setLocation(latlng: LatLng | null): void {
      if (!latlng) return;
      location = { lat: latlng.lat, lng: latlng.lng };
      ensureMarker([latlng.lat, latlng.lng]);
      redrawAll();
    },
    viewerAzToAnchor(latlng: LatLng): number {
      if (!location) return 0;
      return bearingToViewerAz(bearingFromLocation(location, latlng));
    },
    setOverlayCones(newCones: Cone[]): void { cones = newCones; redrawCones(); },
    setImageMeasurementBearings(newPOIs: ImageMeasurementBearing[]): void { pois = newPOIs; redrawPOIs(); },
    setMapMeasurements(newMapPOIs: readonly MapMeasurementView[]): void {
      mapPoiData = newMapPOIs;
      redrawMapPoiAnchors();
    },
    setProjectPreview(preview: ProjectPreview | null): void {
      projectPreview = preview;
      redrawProjectPreview();
    },
    setIndexControlPoints(cps: readonly IndexControlPoint[]): void {
      indexControlPoints = cps;
      redrawIndexControlPoints();
    },
    setProjectMarkers(projects: readonly ProjectMarker[]): void {
      const wantedIds = new Set(projects.map(p => p.id));
      for (const [id, m] of projectMarkers) {
        if (!wantedIds.has(id)) { map.removeLayer(m); projectMarkers.delete(id); }
      }
      for (const p of projects) {
        const existing = projectMarkers.get(p.id);
        if (existing) {
          existing.setLatLng([p.latlng.lat, p.latlng.lng]);
          continue;
        }
        const m = L.marker([p.latlng.lat, p.latlng.lng]);
        m.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          onProjectMarkerPreview?.(p.id);
          const popupHtml = `<span class="name">${escapeHtml(p.label)}</span>`
            + goButtonHtml('Go to project →');
          const popup = L.popup(GO_POPUP_OPTS)
            .setLatLng([p.latlng.lat, p.latlng.lng])
            .setContent(popupHtml)
            .openOn(map);
          wireGoButton(popup, () => onProjectMarkerOpen?.(p.id));
        });
        m.on('contextmenu', (e: L.LeafletMouseEvent) => {
          L.DomEvent.preventDefault(e.originalEvent);
          L.DomEvent.stopPropagation(e);
        });
        m.addTo(map);
        projectMarkers.set(p.id, m);
      }
    },
    isVisible: () => visible,
    onShow(): void {
      // Pull fresh annotation data into our cone/POI caches first. The setters'
      // redraws are gated on `visible`, so they're no-ops here — the redrawAll
      // below paints once with up-to-date inputs.
      onShowRefresh?.();
      visible = true;
      // Leaflet measures tile dims from container size at construction; if hidden
      // then, we must invalidate after the container becomes visible.
      map.invalidateSize();
      redrawAll();
    },
    onHide(): void { visible = false; },
    toggleMapPoiArm(): void { setMapPoiArmed(!mapPoiArmed); },
    disarmAll(): void { setMapPoiArmed(false); },
  };
}
