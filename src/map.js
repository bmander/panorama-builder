import * as L from 'leaflet';

const HIST_ATTR = 'Historical maps via <a href="https://bmander.com/seamap">bmander.com/seamap</a>';
const histLayer = (year, opts = {}) => L.tileLayer(
  `https://storage.googleapis.com/seatimemap/${year}/{z}/{x}/{y}.png`,
  { minZoom: 12, maxZoom: 20, attribution: HIST_ATTR, ...opts },
);

const R_EARTH = 6371000;
function destination(loc, bearingDeg, distM) {
  const bRad = bearingDeg * Math.PI / 180;
  const dLat = (distM / R_EARTH) * Math.cos(bRad) * 180 / Math.PI;
  const dLng = (distM / R_EARTH) * Math.sin(bRad) * 180 / Math.PI / Math.cos(loc.lat * Math.PI / 180);
  return { lat: loc.lat + dLat, lng: loc.lng + dLng };
}

function pixelsToMeters(map, pixels) {
  const c = map.getCenter();
  const p = map.latLngToContainerPoint(c);
  const ll2 = map.containerPointToLatLng(L.point(p.x + pixels, p.y));
  return c.distanceTo(ll2);
}

export function createMapView({ container, onLocationChange }) {
  const layers = {
    'Sanborn 1884': histLayer(1884),
    'Sanborn 1888': histLayer(1888),
    'Sanborn 1893': histLayer(1893),
    'Baist 1908':   histLayer(1908, { maxNativeZoom: 19 }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }),
  };

  const map = L.map(container, { layers: [layers['Sanborn 1893']] })
    .setView([47.607, -122.335], 14);
  L.control.layers(layers, {}, { collapsed: false, position: 'topleft' }).addTo(map);

  let location = null;
  let marker = null;
  let cones = [];
  let coneLayers = [];
  let pois = [];
  let poiLayers = [];
  let visible = false;

  const CONE_STYLE = { color: '#ffd84a', weight: 1, fillColor: '#ffd84a', fillOpacity: 0.18 };
  const POI_STYLE = { color: '#ff5050', weight: 2, opacity: 0.8 };
  const viewerAzToBearing = az => -az * 180 / Math.PI;

  function screenDiagonalMeters() {
    const s = map.getSize();
    return pixelsToMeters(map, Math.hypot(s.x, s.y));
  }

  function syncLayerPool(items, layers, makeLayer, applyLatLngs) {
    if (!location || items.length === 0) {
      while (layers.length) map.removeLayer(layers.pop());
      return;
    }
    while (layers.length > items.length) map.removeLayer(layers.pop());
    while (layers.length < items.length) layers.push(makeLayer().addTo(map));
    const distM = screenDiagonalMeters();
    for (let i = 0; i < items.length; i++) applyLatLngs(layers[i], items[i], distM);
  }

  function redrawCones() {
    if (!visible) return;
    syncLayerPool(cones, coneLayers,
      () => L.polygon([[0, 0], [0, 0], [0, 0]], CONE_STYLE),
      (layer, c, distM) => {
        const ptL = destination(location, viewerAzToBearing(c.azL), distM);
        const ptR = destination(location, viewerAzToBearing(c.azR), distM);
        layer.setLatLngs([
          [location.lat, location.lng],
          [ptL.lat, ptL.lng],
          [ptR.lat, ptR.lng],
        ]);
      });
  }

  function redrawPOIs() {
    if (!visible) return;
    syncLayerPool(pois, poiLayers,
      () => L.polyline([[0, 0], [0, 0]], POI_STYLE),
      (layer, p, distM) => {
        const pt = destination(location, viewerAzToBearing(p.az), distM);
        layer.setLatLngs([[location.lat, location.lng], [pt.lat, pt.lng]]);
      });
  }

  function redrawAll() { redrawCones(); redrawPOIs(); }

  map.on('click', e => {
    location = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (marker) marker.setLatLng(e.latlng);
    else marker = L.marker(e.latlng).addTo(map);
    onLocationChange?.(location);
    redrawAll();
  });
  map.on('zoomend', redrawAll);
  map.on('resize', redrawAll);

  return {
    getLocation: () => location,
    setOverlayCones(newCones) { cones = newCones; redrawCones(); },
    setPOIBearings(newPOIs) { pois = newPOIs; redrawPOIs(); },
    onShow() {
      visible = true;
      // Leaflet measures tile dims from container size at construction; if hidden
      // then, we must invalidate after the container becomes visible.
      map.invalidateSize();
      redrawAll();
    },
    onHide() { visible = false; },
  };
}
