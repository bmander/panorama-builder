import * as L from 'leaflet';
import type * as THREE from 'three';
import { R_EARTH, bearingFromLocation, viewerAzToBearing, bearingToViewerAz } from './geo.js';
import type { Cone, LatLng, POIBearing } from './types.js';

export interface MapView {
  getLocation(): LatLng | null;
  setLocation(latlng: LatLng | null): void;
  viewerAzToAnchor(latlng: LatLng): number;
  setOverlayCones(newCones: Cone[]): void;
  setPOIBearings(newPOIs: POIBearing[]): void;
  isVisible(): boolean;
  onShow(): void;
  onHide(): void;
  toggleSetLocationArmed(): void;
}

export interface CreateMapViewOptions {
  container: HTMLElement;
  onLocationChange?: (loc: LatLng) => void;
  onPOIAnchorClick?: (handle: THREE.Mesh, latlng: LatLng) => void;
  onPOIAnchorDragged?: (handle: THREE.Mesh, latlng: LatLng, viewerAz: number) => void;
  onShowRefresh?: () => void;
  onArmedChange?: (armed: boolean) => void;
}

const HIST_ATTR = 'Historical maps via <a href="https://bmander.com/seamap">bmander.com/seamap</a>';
const histLayer = (year: number, opts: L.TileLayerOptions = {}): L.TileLayer => L.tileLayer(
  `https://storage.googleapis.com/seatimemap/${year}/{z}/{x}/{y}.png`,
  { minZoom: 12, maxZoom: 20, attribution: HIST_ATTR, ...opts },
);

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
  onPOIAnchorDragged,
  onShowRefresh,
  onArmedChange,
}: CreateMapViewOptions): MapView {
  const layers: Record<string, L.TileLayer> = {
    'Sanborn 1884': histLayer(1884),
    'Sanborn 1888': histLayer(1888),
    'Sanborn 1893': histLayer(1893),
    'Baist 1908':   histLayer(1908, { maxNativeZoom: 19 }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }),
  };

  const baseLayer = layers['Sanborn 1893']!;
  const map = L.map(container, { layers: [baseLayer] })
    .setView([47.607, -122.335], 14);
  L.control.layers(layers, {}, { collapsed: false, position: 'topleft' }).addTo(map);

  let location: LatLng | null = null;
  let marker: L.Marker | null = null;
  let cones: Cone[] = [];
  const coneLayers: L.Polygon[] = [];
  let pois: POIBearing[] = [];
  const poiLayers: L.Polyline[] = [];
  const anchorMarkers = new Map<THREE.Mesh, L.Marker>();
  let visible = false;
  let setLocationArmed = false;
  function setArmed(v: boolean): void {
    if (setLocationArmed === v) return;
    setLocationArmed = v;
    container.classList.toggle('armed', v);
    onArmedChange?.(v);
  }

  const CONE_STYLE: L.PolylineOptions = { color: '#ffd84a', weight: 1, fillColor: '#ffd84a', fillOpacity: 0.18 };
  const POI_STYLE: L.PolylineOptions = { color: '#ff5050', weight: 2, opacity: 0.8 };
  const ANCHOR_ICON = L.divIcon({
    className: 'poi-anchor-marker',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

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
    syncLayerPool<POIBearing, L.Polyline>(pois, poiLayers,
      () => L.polyline([[0, 0], [0, 0]], POI_STYLE),
      (layer, p, distM) => {
        const loc = location!;
        const pt = destination(loc, viewerAzToBearing(p.az), distM);
        layer.setLatLngs([[loc.lat, loc.lng], [pt.lat, pt.lng]]);
      });
    // Re-bind click handlers (closures need fresh poi references).
    for (let i = 0; i < poiLayers.length; i++) {
      const poi = pois[i]!;
      const layer = poiLayers[i]!;
      const handle = poi.handle;
      const az = poi.az;
      layer.off('click');
      layer.on('click', (e: L.LeafletMouseEvent) => {
        if (!location) return;
        const projected = projectClickToRay(location, viewerAzToBearing(az), e.latlng);
        onPOIAnchorClick?.(handle, projected);
        L.DomEvent.stopPropagation(e);
      });
    }
  }

  function redrawAnchors(): void {
    if (!visible) return;
    const wanted = new Map<THREE.Mesh, LatLng>();
    for (const p of pois) {
      if (p.mapAnchor) wanted.set(p.handle, p.mapAnchor);
    }
    for (const [handle, m] of anchorMarkers) {
      if (!wanted.has(handle)) { map.removeLayer(m); anchorMarkers.delete(handle); }
    }
    for (const [handle, anchor] of wanted) {
      const existing = anchorMarkers.get(handle);
      if (!existing) {
        const m = L.marker([anchor.lat, anchor.lng], { draggable: true, icon: ANCHOR_ICON }).addTo(map);
        m.on('drag', (e: L.LeafletEvent) => {
          if (!location) return;
          const ll = (e.target as L.Marker).getLatLng();
          const bearing = bearingFromLocation(location, ll);
          onPOIAnchorDragged?.(handle, ll, bearingToViewerAz(bearing));
        });
        anchorMarkers.set(handle, m);
      } else {
        existing.setLatLng([anchor.lat, anchor.lng]);
      }
    }
  }

  function redrawAll(): void { redrawCones(); redrawPOIs(); redrawAnchors(); }

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
    if (!setLocationArmed) return;
    setArmed(false);
    location = { lat: e.latlng.lat, lng: e.latlng.lng };
    ensureMarker(e.latlng);
    onLocationChange?.(location);
    redrawAll();
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
    setPOIBearings(newPOIs: POIBearing[]): void { pois = newPOIs; redrawPOIs(); redrawAnchors(); },
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
    toggleSetLocationArmed(): void { setArmed(!setLocationArmed); },
  };
}
