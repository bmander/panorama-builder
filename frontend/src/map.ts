import * as L from 'leaflet';
import { R_EARTH, viewerAzToBearing } from './geo.js';
import { degToRad, dot3, norm2, norm3, radToDeg } from './mathx.js';
import { cpHref } from './types.js';
import type { Cone, LatLng } from './types.js';
import { TILE_PX, fetchTileElevations, tileYToLat } from './dem.js';
import { NULL_CP_RAY_CSS, NULL_CP_RAY_LENGTH_M } from './null-cp-rays.js';

export interface StationMarker {
  id: string;
  latlng: LatLng;
  label: string;
}

// Fetched-on-click summary of a station, used at the index view to preview
// what's inside without navigating into it.
export interface StationPreview {
  origin: LatLng;
  cones: Cone[];
  // CP IDs observed by this station — turns the matching index dots green
  // while the preview is active.
  observedCpIds: ReadonlySet<string>;
  // Compass bearings (CW from N, degrees) of rays emitted by this station's
  // observations of null-location CPs — drawn as 5km purple polylines so the
  // user can see how this station's rays would converge with others.
  nullCpRayBearingsDeg: readonly number[];
}

export interface IndexControlPoint {
  id: string;
  latlng: LatLng;
  description: string;
}

export interface MapViewState {
  lat: number;
  lng: number;
  zoom: number;
}

export interface MapView {
  setStationMarkers(stations: readonly StationMarker[]): void;
  setStationPreview(preview: StationPreview | null): void;
  // Index-view dots: every control point with a location estimate, drawn as
  // small red markers regardless of which station owns them. Click → popup
  // with a link to the CP's detail page.
  setIndexControlPoints(cps: readonly IndexControlPoint[]): void;
  // Pan/zoom the index map to the named CP and open its popup. No-op if the
  // CP isn't in the current `indexControlPoints` list (e.g. no estimate yet).
  focusIndexControlPoint(id: string): boolean;
  // Pan/zoom to the named station marker and open its popup. No-op if the
  // marker isn't in the current set.
  focusStationMarker(id: string): boolean;
  getView(): MapViewState;
}

export interface CreateMapViewOptions {
  container: HTMLElement;
  onStationMarkerOpen?: (id: string) => void;
  onStationMarkerPreview?: (id: string) => void;
  onStartStationHere?: (latlng: LatLng) => void;
  onAddControlPointHere?: (latlng: LatLng) => void;
  onControlPointSolveLocation?: (id: string) => void;
  // Fired when the user drags a station marker and releases it at a new spot.
  onStationMarkerMove?: (id: string, latlng: LatLng) => void;
  // Same idea for index-CP dots: drag-end commits the new lat/lng.
  onControlPointMove?: (id: string, latlng: LatLng) => void;
  // Image file(s) dropped on the map — typically opens the start-station
  // modal pre-populated with this location and these files.
  onPhotoDroppedOnMap?: (latlng: LatLng, files: readonly File[]) => void;
  // Initial center + zoom; defaults to the Seattle waterfront at z=14.
  initialView?: MapViewState | undefined;
  // Fired whenever the user pans or zooms (Leaflet's moveend covers both).
  // Also fires on the initial layout pass, so the URL can be kept in sync
  // without an explicit first-paint write.
  onViewChange?: (view: MapViewState) => void;
  // Fires when an open station-marker preview is dismissed (popup closed by
  // any means). Lets the index page drop "always-show-observed" overrides
  // it applied while the preview was active.
  onStationPreviewClose?: () => void;
}

const DEFAULT_INDEX_VIEW: MapViewState = { lat: 47.607, lng: -122.335, zoom: 14 };

const HIST_ATTR = 'Historical maps via <a href="https://bmander.com/seamap">bmander.com/seamap</a>';
const histLayer = (year: number, opts: L.TileLayerOptions = {}): L.TileLayer => L.tileLayer(
  `https://storage.googleapis.com/seatimemap/${year}/{z}/{x}/{y}.png`,
  { minZoom: 12, maxZoom: 20, attribution: HIST_ATTR, ...opts },
);

// Client-side hillshade rendered from the same Terrarium PNG tiles the 3D
// terrain mesh uses. Sun NW (azimuth 315°) at 45° elevation — the standard
// cartographic convention.
const SUN_AZ_RAD = degToRad(315);
const SUN_ALT_RAD = degToRad(45);
const SUN_E = Math.sin(SUN_AZ_RAD) * Math.cos(SUN_ALT_RAD);
const SUN_N = Math.cos(SUN_AZ_RAD) * Math.cos(SUN_ALT_RAD);
const SUN_U = Math.sin(SUN_ALT_RAD);

function metersPerWebMercatorPixel(lat: number, z: number): number {
  return 156543.03 * Math.cos(degToRad(lat)) / 2 ** z;
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
      const dot = dot3(nE, nN, 1, SUN_E, SUN_N, SUN_U);
      const norm = norm3(nE, nN, 1);
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
  const bRad = degToRad(bearingDeg);
  const angDist = distM / R_EARTH;
  const dLat = radToDeg(angDist * Math.cos(bRad));
  const dLng = radToDeg(angDist * Math.sin(bRad)) / Math.cos(degToRad(loc.lat));
  return { lat: loc.lat + dLat, lng: loc.lng + dLng };
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
  onStationMarkerOpen,
  onStationMarkerPreview,
  onStartStationHere,
  onAddControlPointHere,
  onControlPointSolveLocation,
  onStationMarkerMove,
  onControlPointMove,
  onPhotoDroppedOnMap,
  initialView = DEFAULT_INDEX_VIEW,
  onViewChange,
  onStationPreviewClose,
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
    .setView([initialView.lat, initialView.lng], initialView.zoom);
  L.control.layers(layers, {}, { collapsed: false, position: 'topleft' }).addTo(map);

  const currentView = (): MapViewState => {
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  };
  // moveend fires after both pan and zoom (zoom triggers a move). Leaflet
  // emits one shortly after the initial setView too, so the very first paint
  // also delivers a state snapshot.
  map.on('moveend', () => { onViewChange?.(currentView()); });

  const CONE_STYLE: L.PolylineOptions = { color: '#ffd84a', weight: 1, fillColor: '#ffd84a', fillOpacity: 0.18 };
  const NULL_RAY_STYLE: L.PolylineOptions = { color: NULL_CP_RAY_CSS, weight: 2, opacity: 0.85 };
  const stationMarkers = new Map<string, { marker: L.Marker; view: StationMarker }>();
  // Preview overlay drawn when a station marker is clicked.
  let stationPreview: StationPreview | null = null;
  const previewConeLayers: L.Polygon[] = [];
  const previewRayLayers: L.Polyline[] = [];
  let indexControlPoints: readonly IndexControlPoint[] = [];
  const indexCpDots = new Map<string, L.Marker>();
  const CP_ICON = L.divIcon({
    className: 'cp-dot', html: '', iconSize: [10, 10], iconAnchor: [5, 5],
  });
  const isCpObserved = (id: string): boolean =>
    stationPreview?.observedCpIds.has(id) ?? false;
  const INDEX_CP_POPUP_OPTS: L.PopupOptions = { className: 'index-cp-popup', closeButton: true };
  const GO_POPUP_OPTS: L.PopupOptions = { className: 'station-popup', closeButton: true };
  const goButtonHtml = (label: string, cls = ''): string =>
    `<button type="button" class="go${cls ? ' ' + cls : ''}">${label}</button>`;
  const solveButtonHtml = (): string => '<button type="button" class="go solve-location">Refine location</button>';
  function wireGoButton(popup: L.Popup, selector: string, onClick: () => void): void {
    const btn = popup.getElement()?.querySelector<HTMLButtonElement>(selector);
    btn?.addEventListener('click', () => {
      map.closePopup(popup);
      onClick();
    }, { once: true });
  }

  function screenDiagonalMeters(): number {
    const s = map.getSize();
    return pixelsToMeters(map, norm2(s.x, s.y));
  }

  function redrawStationPreview(): void {
    while (previewConeLayers.length) map.removeLayer(previewConeLayers.pop()!);
    while (previewRayLayers.length) map.removeLayer(previewRayLayers.pop()!);
    if (!stationPreview) return;
    const distM = screenDiagonalMeters();
    const origin = stationPreview.origin;
    for (const c of stationPreview.cones) {
      const ptL = destination(origin, viewerAzToBearing(c.azL), distM);
      const ptR = destination(origin, viewerAzToBearing(c.azR), distM);
      const poly = L.polygon([
        [origin.lat, origin.lng],
        [ptL.lat, ptL.lng],
        [ptR.lat, ptR.lng],
      ], CONE_STYLE).addTo(map);
      previewConeLayers.push(poly);
    }
    for (const bearingDeg of stationPreview.nullCpRayBearingsDeg) {
      const end = destination(origin, bearingDeg, NULL_CP_RAY_LENGTH_M);
      const line = L.polyline([
        [origin.lat, origin.lng],
        [end.lat, end.lng],
      ], NULL_RAY_STYLE).addTo(map);
      previewRayLayers.push(line);
    }
  }

  function openIndexCpPopup(cp: IndexControlPoint): void {
    const label = cp.description || `cp ${cp.id.slice(0, 6)}`;
    const popupHtml = `<span class="name">${escapeHtml(label)}</span>`
      + `<a class="go" href="${cpHref(cp.id)}">View details →</a>`
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
  }

  // Rebuild the entire index-CP layer from `indexControlPoints`. Use only
  // when the CP list itself changes; toggling preview state should call
  // restyleIndexControlPoints() to avoid tearing down per-marker handlers.
  function redrawIndexControlPoints(): void {
    for (const dot of indexCpDots.values()) map.removeLayer(dot);
    indexCpDots.clear();
    for (const cp of indexControlPoints) {
      const dot = L.marker([cp.latlng.lat, cp.latlng.lng], { icon: CP_ICON, draggable: true });
      dot.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        openIndexCpPopup(cp);
      });
      dot.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        L.DomEvent.stopPropagation(e);
      });
      dot.on('dragend', () => {
        const ll = dot.getLatLng();
        onControlPointMove?.(cp.id, { lat: ll.lat, lng: ll.lng });
      });
      dot.addTo(map);
      // Observed-state class can only be toggled after the icon element exists.
      dot.getElement()?.classList.toggle('observed', isCpObserved(cp.id));
      indexCpDots.set(cp.id, dot);
    }
  }

  function restyleIndexControlPoints(): void {
    for (const [id, dot] of indexCpDots) {
      dot.getElement()?.classList.toggle('observed', isCpObserved(id));
    }
  }

  function applyStationPreview(next: StationPreview | null): void {
    stationPreview = next;
    redrawStationPreview();
    restyleIndexControlPoints();
  }

  map.on('contextmenu', (e: L.LeafletMouseEvent) => {
    // Skip when the right-click landed on a marker or popup — those have
    // their own contextmenu / popup handling and we don't want to clobber it.
    const target = e.originalEvent.target as Element | null;
    if (target?.closest('.leaflet-marker-icon, .leaflet-popup')) return;
    L.DomEvent.preventDefault(e.originalEvent);
    const latlng: LatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
    const popup = L.popup(GO_POPUP_OPTS)
      .setLatLng(e.latlng)
      .setContent(
        goButtonHtml('Start station here', 'start-station')
        + goButtonHtml('Add control point', 'add-cp'),
      )
      .openOn(map);
    wireGoButton(popup, '.go.start-station', () => onStartStationHere?.(latlng));
    wireGoButton(popup, '.go.add-cp', () => onAddControlPointHere?.(latlng));
  });
  map.on('zoomend', redrawStationPreview);
  map.on('resize', redrawStationPreview);

  // Drag-and-drop image files onto the map → callback gets the drop location
  // and the files. Only photo MIME types count; non-image drops are ignored.
  const dragHasImage = (dt: DataTransfer | null): boolean =>
    !!dt && Array.from(dt.items).some(it => it.kind === 'file' && it.type.startsWith('image/'));
  container.addEventListener('dragover', e => {
    if (!dragHasImage(e.dataTransfer)) return;
    e.preventDefault();
    container.classList.add('photo-drop-active');
  });
  container.addEventListener('dragleave', e => {
    // Only clear when the cursor actually leaves the container, not when it
    // moves between child elements (which fires dragleave on the parent).
    if (e.target === container) container.classList.remove('photo-drop-active');
  });
  container.addEventListener('drop', e => {
    container.classList.remove('photo-drop-active');
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    // Stop propagation so the window-level drop listener in input.ts (which
    // is for the 360° viewer) doesn't also try to handle this drop.
    e.stopPropagation();
    const ll = map.mouseEventToLatLng(e);
    onPhotoDroppedOnMap?.({ lat: ll.lat, lng: ll.lng }, files);
  });

  return {
    setStationPreview(preview: StationPreview | null): void {
      applyStationPreview(preview);
    },
    setIndexControlPoints(cps: readonly IndexControlPoint[]): void {
      indexControlPoints = cps;
      redrawIndexControlPoints();
    },
    focusIndexControlPoint(id: string): boolean {
      const cp = indexControlPoints.find(c => c.id === id);
      if (!cp) return false;
      const FOCUS_ZOOM = 18;
      map.setView([cp.latlng.lat, cp.latlng.lng],
        Math.max(map.getZoom(), FOCUS_ZOOM), { animate: false });
      openIndexCpPopup(cp);
      return true;
    },
    setStationMarkers(stations: readonly StationMarker[]): void {
      const wantedIds = new Set(stations.map(p => p.id));
      for (const [id, entry] of stationMarkers) {
        if (!wantedIds.has(id)) { map.removeLayer(entry.marker); stationMarkers.delete(id); }
      }
      for (const p of stations) {
        const existing = stationMarkers.get(p.id);
        if (existing) {
          existing.marker.setLatLng([p.latlng.lat, p.latlng.lng]);
          existing.view = p;
          continue;
        }
        const m = L.marker([p.latlng.lat, p.latlng.lng], { draggable: true });
        m.on('click', (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          openStationPopup(p);
        });
        m.on('contextmenu', (e: L.LeafletMouseEvent) => {
          L.DomEvent.preventDefault(e.originalEvent);
          L.DomEvent.stopPropagation(e);
        });
        m.on('dragend', () => {
          const ll = m.getLatLng();
          onStationMarkerMove?.(p.id, { lat: ll.lat, lng: ll.lng });
        });
        m.addTo(map);
        stationMarkers.set(p.id, { marker: m, view: p });
      }
    },
    focusStationMarker(id: string): boolean {
      const entry = stationMarkers.get(id);
      if (!entry) return false;
      const FOCUS_ZOOM = 18;
      map.setView([entry.view.latlng.lat, entry.view.latlng.lng],
        Math.max(map.getZoom(), FOCUS_ZOOM), { animate: false });
      openStationPopup(entry.view);
      return true;
    },
    getView: currentView,
  };

  function openStationPopup(p: StationMarker): void {
    const popupHtml = `<span class="name">${escapeHtml(p.label)}</span>`
      + goButtonHtml('Go to station →');
    // openOn auto-closes any prior popup; its 'remove' event clears the
    // previous station's preview before the new preview is kicked off below.
    const popup = L.popup(GO_POPUP_OPTS)
      .setLatLng([p.latlng.lat, p.latlng.lng])
      .setContent(popupHtml)
      .openOn(map);
    popup.on('remove', () => {
      applyStationPreview(null);
      onStationPreviewClose?.();
    });
    onStationMarkerPreview?.(p.id);
    wireGoButton(popup, '.go', () => onStationMarkerOpen?.(p.id));
  }
}
