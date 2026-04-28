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

  const CONE_STYLE = { color: '#ffd84a', weight: 1, fillColor: '#ffd84a', fillOpacity: 0.18 };

  function redrawCones() {
    if (!location || cones.length === 0) {
      while (coneLayers.length) map.removeLayer(coneLayers.pop());
      return;
    }
    // Reuse existing polygons in-place; only add/remove when overlay count changes.
    while (coneLayers.length > cones.length) map.removeLayer(coneLayers.pop());
    while (coneLayers.length < cones.length) {
      coneLayers.push(L.polygon([[0, 0], [0, 0], [0, 0]], CONE_STYLE).addTo(map));
    }
    // Cone length = screen diagonal in pixels → guaranteed to reach the edge from any apex.
    const size = map.getSize();
    const distM = pixelsToMeters(map, Math.hypot(size.x, size.y));
    for (let i = 0; i < cones.length; i++) {
      // viewer azimuth (CCW from N) → compass bearing (CW from N)
      const bL = -cones[i].azL * 180 / Math.PI;
      const bR = -cones[i].azR * 180 / Math.PI;
      const ptL = destination(location, bL, distM);
      const ptR = destination(location, bR, distM);
      coneLayers[i].setLatLngs([
        [location.lat, location.lng],
        [ptL.lat, ptL.lng],
        [ptR.lat, ptR.lng],
      ]);
    }
  }

  map.on('click', e => {
    location = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (marker) marker.setLatLng(e.latlng);
    else marker = L.marker(e.latlng).addTo(map);
    onLocationChange?.(location);
    redrawCones();
  });
  map.on('zoomend', redrawCones);
  map.on('resize', redrawCones);

  return {
    getLocation: () => location,
    setOverlayCones(newCones) { cones = newCones; redrawCones(); },
    // Leaflet computes tile dims from container size at construction; if hidden then,
    // we must invalidate after the container becomes visible.
    onShow() { map.invalidateSize(); },
  };
}
