import * as L from 'leaflet';

const HIST_ATTR = 'Historical maps via <a href="https://bmander.com/seamap">bmander.com/seamap</a>';
const histLayer = (year, opts = {}) => L.tileLayer(
  `https://storage.googleapis.com/seatimemap/${year}/{z}/{x}/{y}.png`,
  { minZoom: 12, maxZoom: 20, attribution: HIST_ATTR, ...opts },
);

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

  map.on('click', e => {
    location = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (marker) marker.setLatLng(e.latlng);
    else marker = L.marker(e.latlng).addTo(map);
    onLocationChange?.(location);
  });

  return {
    getLocation: () => location,
    // Leaflet computes tile dims from container size at construction; if hidden then,
    // we must invalidate after the container becomes visible.
    onShow() { map.invalidateSize(); },
  };
}
