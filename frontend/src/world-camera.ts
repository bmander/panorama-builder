// Unified world-camera pose: a single source of truth for where the camera
// is in WGS84 + MSL, plus the station anchor it sits on top of.
//
// "Live" location and altitude track the camera as the user shift-wheels or
// flies. "Station anchor" is what's persisted to the backend — the station's
// published lat/lng/alt. Editing the station form snaps live back to anchor.
//
// Renderers consume this via a single push fired by `subscribe`; mirrors the
// subscribe/notify pattern in `curvature.ts`.

import type { LatLng } from './types.js';

export interface WorldCameraPose {
  // Live camera location. Equals stationAnchor unless shift-wheel/fly has detached.
  location: LatLng | null;
  // Live camera MSL. Equals stationAltitudeMSL unless shift-wheel has detached.
  altitudeMSL: number;
  // Persisted anchor location for the current station. Null when no station is loaded.
  stationAnchor: LatLng | null;
  // Persisted anchor altitude for the current station. Null when no station is loaded.
  stationAltitudeMSL: number | null;
}

export interface WorldCamera {
  getPose(): Readonly<WorldCameraPose>;
  // Station load, form edit, or fly landing. Resets live camera to the new anchor.
  setStationAnchor(anchor: { location: LatLng; altitudeMSL: number }): void;
  // Shift-wheel / fly mid-flight. Anchor unchanged.
  setLiveCamera(live: { location: LatLng; altitudeMSL: number }): void;
  // Station unload — clears all four fields back to null/0.
  clear(): void;
  subscribe(cb: () => void): () => void;
}

function locEq(a: LatLng | null, b: LatLng | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.lat === b.lat && a.lng === b.lng;
}

export function createWorldCamera(): WorldCamera {
  let location: LatLng | null = null;
  let altitudeMSL = 0;
  let stationAnchor: LatLng | null = null;
  let stationAltitudeMSL: number | null = null;
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const cb of subscribers) cb();
  }

  return {
    getPose: () => ({ location, altitudeMSL, stationAnchor, stationAltitudeMSL }),
    setStationAnchor({ location: loc, altitudeMSL: alt }) {
      const changed = !locEq(stationAnchor, loc)
        || stationAltitudeMSL !== alt
        || !locEq(location, loc)
        || altitudeMSL !== alt;
      stationAnchor = loc;
      stationAltitudeMSL = alt;
      location = loc;
      altitudeMSL = alt;
      if (changed) notify();
    },
    setLiveCamera({ location: loc, altitudeMSL: alt }) {
      if (locEq(location, loc) && altitudeMSL === alt) return;
      location = loc;
      altitudeMSL = alt;
      notify();
    },
    clear() {
      const changed = location !== null || altitudeMSL !== 0
        || stationAnchor !== null || stationAltitudeMSL !== null;
      location = null;
      altitudeMSL = 0;
      stationAnchor = null;
      stationAltitudeMSL = null;
      if (changed) notify();
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => { subscribers.delete(cb); };
    },
  };
}
