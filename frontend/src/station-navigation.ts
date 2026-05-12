// Tweens the camera into the destination's pose, then hands off to the
// host's loadStation(destId) — same /world page, no remount, just swap
// the per-station data in place.

import * as api from './api.js';
import { dirFromAzAlt } from './overlay.js';
import { groundDistance, latLngToCameraRelativeMeters, vecToAzAlt } from './geo.js';
import { wrapPi } from './mathx.js';
import type { LatLng } from './types.js';
import type { Viewer } from './viewer.js';
import { DEFAULT_FOV } from './viewer.js';
import type { TerrainView } from './terrain/index.js';
import type { ControlPointColumns } from './map-poi-columns.js';
import type { StationMarker, StationMarkers } from './station-markers.js';
import type { PhotoPreviews } from './photo-previews.js';

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
  photoPreviews: PhotoPreviews;
  getCurrentStationId: () => string;
  getStationLocation: () => LatLng | null;
  setStationLocation: (loc: LatLng) => void;
  getStationCache: () => { name: string | null; alt: number } | null;
  getOtherStations: () => readonly StationMarker[];
  setOtherStations: (stations: readonly StationMarker[]) => void;
  // Fired per frame during the fly tween. Hosts use it to update any
  // world-space overlays whose positions track the camera location
  // (cones, observation rays, …) — without it those overlays freeze in
  // their pre-fly positions and visually detach from the moving world.
  onFlyFrame?: (loc: LatLng, alt: number) => void;
  // Called at fly end (and on early-out paths) to swap the host's per-
  // station data to destId. Passing the prefetched dest lets the host
  // skip its own getStation call — the fly already fetched it.
  loadStation: (destId: string, prefetched?: api.ApiHydratedStation) => Promise<void>;
}

export interface StationNavigation {
  flyToStation: (destId: string) => Promise<void>;
}

export function createStationNavigation(deps: StationNavigationDeps): StationNavigation {
  const {
    viewer, terrain, cpColumns, stationDots, photoPreviews,
    getCurrentStationId,
    getStationLocation, setStationLocation, getStationCache,
    getOtherStations, setOtherStations,
    onFlyFrame, loadStation,
  } = deps;

  let flyInProgress = false;

  async function flyToStation(destId: string): Promise<void> {
    if (flyInProgress) return;
    const here = getStationLocation();
    const cache = getStationCache();
    const currentStationId = getCurrentStationId();
    if (!here || !cache || destId === currentStationId) {
      await loadStation(destId);
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
        await loadStation(destId);
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

      // CP markers + observation lines connect world-space CPs to
      // source-anchored POIs; hide the whole CP layer until the post-fly
      // reload rebuilds it for the destination station.
      cpColumns.setVisible(false);

      photoPreviews.set(dest.photos.map(p => ({
        photoId: p.id,
        fromLat: dest.station.lat, fromLng: dest.station.lng, fromAlt: dest.station.alt,
        photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
        sizeRad: p.size_rad, aspect: p.aspect,
      })));

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
          terrain.setCameraMSL(alt);
          // Glue source panes to the source station as the camera flies
          // away — finally block resets to origin before dest hydrate.
          const srcOffset = latLngToCameraRelativeMeters(src, loc);
          viewer.overlaysGroup.position.set(srcOffset.x, src.alt - alt, srcOffset.z);
          viewer.setAzAlt(srcAz + azDelta * k, srcAlt + (dstAlt - srcAlt) * k);
          viewer.setFov(srcFov + (dstFov - srcFov) * k);
          // CP markers are hidden above; the dots / cones / rays are pure
          // world-space and track the moving camera per frame. Visual
          // quirk at k=1: the destination's cone apex / ray origins
          // coincide with the camera at world (0,0,0), so the GPU clips
          // those line segments at the near plane and they emerge from a
          // small starburst near image center instead of one converging
          // point. We accept this — landing slightly back of the lens to
          // hide it would put the camera at a non-station position.
          stationDots.update(loc, alt, getOtherStations());
          onFlyFrame?.(loc, alt);
          viewer.requestRender();
          if (tau < 1) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });

      // Hide before reset so source panes don't snap to origin for one
      // frame before clearStationData removes them.
      viewer.overlaysGroup.visible = false;
      viewer.overlaysGroup.position.set(0, 0, 0);
      await loadStation(destId, dest);
    } finally {
      flyInProgress = false;
      viewer.overlaysGroup.visible = true;
      viewer.overlaysGroup.position.set(0, 0, 0);
      cpColumns.setVisible(true);
      photoPreviews.clear();
    }
  }

  return { flyToStation };
}
