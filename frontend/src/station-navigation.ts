// Tweens the camera into roughly the destination's pose, then page-reloads at
// the destination URL — landing close to the final pose lets the post-reload
// hydrate paint without a visible snap.

import * as api from './api.js';
import { dirFromAzAlt } from './overlay.js';
import { groundDistance, vecToAzAlt } from './geo.js';
import { wrapPi } from './mathx.js';
import { stationHref } from './types.js';
import type { LatLng } from './types.js';
import type { Viewer } from './viewer.js';
import { DEFAULT_FOV } from './viewer.js';
import type { TerrainView } from './terrain.js';
import type { ControlPointColumns } from './map-poi-columns.js';
import type { StationMarker, StationMarkers } from './station-markers.js';

export function meanPhotoAzAlt(photos: readonly api.ApiPhoto[]): { az: number; alt: number } | null {
  let sx = 0, sy = 0, sz = 0;
  for (const p of photos) {
    const d = dirFromAzAlt(p.photo_az, p.photo_tilt);
    sx += d.x; sy += d.y; sz += d.z;
  }
  if (sx * sx + sy * sy + sz * sz < 1e-6) return null;
  return vecToAzAlt(sx, sy, sz);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface StationNavigationDeps {
  viewer: Viewer;
  terrain: TerrainView;
  cpColumns: ControlPointColumns;
  stationDots: StationMarkers;
  currentStationId: string;
  getStationLocation: () => LatLng | null;
  setStationLocation: (loc: LatLng) => void;
  getStationCache: () => { name: string | null; alt: number } | null;
  getOtherStations: () => readonly StationMarker[];
  setOtherStations: (stations: readonly StationMarker[]) => void;
}

export interface StationNavigation {
  flyToStation: (destId: string) => Promise<void>;
}

export function createStationNavigation(deps: StationNavigationDeps): StationNavigation {
  const {
    viewer, terrain, cpColumns, stationDots,
    currentStationId,
    getStationLocation, setStationLocation, getStationCache,
    getOtherStations, setOtherStations,
  } = deps;

  let flyInProgress = false;

  async function flyToStation(destId: string): Promise<void> {
    if (flyInProgress) return;
    const here = getStationLocation();
    const cache = getStationCache();
    if (!here || !cache || destId === currentStationId) {
      location.assign(stationHref(destId));
      return;
    }
    flyInProgress = true;
    const savedOtherStations = getOtherStations();
    try {
      let dest: api.ApiHydratedStation;
      try {
        dest = await api.getStation(destId);
      } catch (err) {
        console.error('fly: dest fetch failed:', err);
        location.assign(stationHref(destId));
        return;
      }

      const src = { lat: here.lat, lng: here.lng, alt: cache.alt };
      const dst = { lat: dest.station.lat, lng: dest.station.lng, alt: dest.station.alt };

      setOtherStations([...savedOtherStations, {
        id: currentStationId,
        name: cache.name,
        anchor: { lat: src.lat, lng: src.lng },
        altitude: src.alt,
      }]);

      // Photos are anchored to the source camera frame and would shear as the
      // world translates underneath them. Same shear hits CP markers and their
      // observation lines (lines connect world-space CPs to source-anchored
      // POIs); hide the whole CP layer until the post-fly reload rebuilds it.
      viewer.overlaysGroup.visible = false;
      cpColumns.setVisible(false);

      const { azimuth: srcAz, altitude: srcAlt } = viewer.getAzAlt();
      const dstOrient = meanPhotoAzAlt(dest.photos);
      const dstAz = dstOrient?.az ?? srcAz;
      const dstAlt = dstOrient?.alt ?? srcAlt;
      const azDelta = wrapPi(dstAz - srcAz);
      // FOV: tween toward DEFAULT_FOV — the post-fly reload re-creates the
      // viewer at that value, so landing there avoids a snap-zoom on reload.
      const srcFov = viewer.camera.fov;
      const dstFov = DEFAULT_FOV;

      const distM = groundDistance(src, dst);
      const durationMs = Math.min(4000, Math.max(1000, distM * 3));
      // Parabolic hop: clear cap keeps very long flights from going suborbital.
      const hopHeightM = Math.max(5, Math.min(distM * 0.15, 200));

      await new Promise<void>(resolve => {
        const startTime = performance.now();
        function step(now: number): void {
          const tau = Math.min(1, (now - startTime) / durationMs);
          const k = easeInOutCubic(tau);
          const lat = src.lat + (dst.lat - src.lat) * k;
          const lng = src.lng + (dst.lng - src.lng) * k;
          const alt = src.alt + (dst.alt - src.alt) * k + hopHeightM * Math.sin(Math.PI * k);
          const loc = { lat, lng };
          setStationLocation(loc);
          terrain.setLocation(loc);
          terrain.setCameraHeight(alt);
          viewer.setAzAlt(srcAz + azDelta * k, srcAlt + (dstAlt - srcAlt) * k);
          viewer.setFov(srcFov + (dstFov - srcFov) * k);
          // Only the green station dots track the moving camera. CP markers
          // are hidden above; building their per-frame markers list is wasted
          // work (and would also rebuild the line geometry).
          stationDots.update(loc, alt, getOtherStations());
          viewer.requestRender();
          if (tau < 1) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });

      location.assign(stationHref(destId));
    } finally {
      flyInProgress = false;
      // If location.assign was queued the browser tears the page down before
      // these run visually; if the navigation is somehow intercepted, the
      // restoration leaves the viewer in a usable state.
      setOtherStations(savedOtherStations);
      viewer.overlaysGroup.visible = true;
      cpColumns.setVisible(true);
    }
  }

  return { flyToStation };
}
