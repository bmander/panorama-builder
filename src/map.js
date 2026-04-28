import * as L from 'leaflet';

export function createMapView({ container, onLocationChange }) {
  const map = L.map(container).setView([0, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

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
