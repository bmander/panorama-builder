// Tweens the camera into the destination's pose, then hands off to the
// host's loadStation(destId) — same /world page, no remount, just swap
// the per-station data in place.

import * as api from './api.js';
import { dirFromAzAlt } from './overlay.js';
import { azAltToPoint, groundDistance, vecToAzAlt } from './geo.js';
import { clamp, degToRad, radToDeg, wrapPi } from './mathx.js';
import type { Viewer } from './viewer.js';
import { DEFAULT_FOV, FOCUS_FOV_DEG, FOV_MAX, FOV_MIN } from './viewer.js';
import type { TerrainView } from './terrain/index.js';
import type { ControlPointColumns } from './map-poi-columns.js';
import type { StationMarker } from './station-markers.js';
import type { PhotoPreviews } from './photo-previews.js';
import type { WorldCamera } from './world-camera.js';
import type { LatLng } from './types.js';

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

// Fraction of a fly-to-CP flight over which the camera rotates to lock the CP
// to screen center; past it the CP stays centered and the camera orbits it.
const CP_LOCK_FRACTION = 0.25;

// Landing orientation + FOV for a fly-to-CP target, plus the data the flight
// needs to keep the CP screen-centered the whole way (orbit effect). The
// orientation centers the destination camera on the control point — the same
// view data-controller's focusCameraOnControlPoint produces. The FOV is chosen
// so the CP keeps the on-screen size (pixels per meter) it had from the source
// camera: with the viewport height fixed, pixels/m at range d is
// H/(2·d·tan(fov/2)), so holding it constant gives
// tan(fov_dst/2) = (d_src/d_dst)·tan(fov_src/2), where d_src / d_dst are the
// source- and destination-camera ranges to the CP. `cp` is the CP's world
// position (the flight looks at it every frame); `srcLookAz`/`srcLookAlt` are
// the look-straight-at-CP angles from the start position, used to derive the
// camera's initial framing offset. Returns null if the CP has no estimated 3D
// position (caller falls back to the station's mean orientation).
function planCpFocus(
  dest: api.ApiHydratedStation, cpId: string,
  src: { lat: number; lng: number; alt: number }, srcFov: number,
): {
  az: number; alt: number; fov: number;
  cp: { lat: number; lng: number; alt: number };
  srcLookAz: number; srcLookAlt: number;
} | null {
  const cp = dest.control_points.find(c => c.id === cpId);
  if (cp?.est_lat == null || cp.est_lng == null || cp.est_alt == null) return null;
  const cpLoc = { lat: cp.est_lat, lng: cp.est_lng };

  const dstStation = { lat: dest.station.lat, lng: dest.station.lng };
  const dst = azAltToPoint(dstStation, dest.station.alt, cpLoc, cp.est_alt);
  const srcLook = azAltToPoint({ lat: src.lat, lng: src.lng }, src.alt, cpLoc, cp.est_alt);

  // Degenerate ranges (CP sitting on a camera) just keep the source FOV.
  let fov = srcFov;
  if (dst.range > 1e-6 && srcLook.range > 1e-6) {
    const fovRad = 2 * Math.atan((srcLook.range / dst.range) * Math.tan(degToRad(srcFov) / 2));
    fov = clamp(radToDeg(fovRad), FOV_MIN, FOV_MAX);
  }
  return {
    az: dst.az, alt: dst.alt, fov,
    cp: { lat: cp.est_lat, lng: cp.est_lng, alt: cp.est_alt },
    srcLookAz: srcLook.az, srcLookAlt: srcLook.alt,
  };
}

// Post-hydrate camera focus for a fly-to-CP: center on cpId and set the FOV.
// The animated path supplies the size-matched FOV it tweened to; the non-
// animated load paths supply FOCUS_FOV_DEG (they can't size-match without a
// flight).
export interface CpFlightFocus {
  readonly cpId: string;
  readonly fovDeg: number;
}

export interface StationNavigationDeps {
  viewer: Viewer;
  terrain: TerrainView;
  cpColumns: ControlPointColumns;
  photoPreviews: PhotoPreviews;
  worldCamera: WorldCamera;
  getCurrentStationId: () => string;
  getStationName: () => string | null;
  getOtherStations: () => readonly StationMarker[];
  setOtherStations: (stations: readonly StationMarker[]) => void;
  // Called at fly end (and on early-out paths) to swap the host's per-
  // station data to destId. Passing the prefetched dest lets the host
  // skip its own getStation call — the fly already fetched it. focus, when
  // set, centers + zooms the camera on that control point once the
  // destination station finishes hydrating.
  loadStation: (destId: string, prefetched?: api.ApiHydratedStation, focus?: CpFlightFocus | null) => Promise<void>;
}

export interface StationNavigation {
  // focusCpId: after landing, focus the camera on this control point in the
  // destination station (used by the CP context menu's "Zoom to…" entries).
  flyToStation: (destId: string, focusCpId?: string | null) => Promise<void>;
}

type Flight =
  | { kind: 'direct-load' }
  | {
      kind: 'normal';
      startStationId: string;
      startStationName: string | null;
      startLocation: LatLng;
      startAltMSL: number;
      anchor: LatLng;
      anchorAltMSL: number;
      savedOtherStations: readonly StationMarker[];
    };

type NormalFlight = Extract<Flight, { kind: 'normal' }>;

interface FlightPlan {
  src: { lat: number; lng: number; alt: number };
  dst: { lat: number; lng: number; alt: number };
  srcAz: number;
  azDelta: number;
  srcAlt: number;
  dstAlt: number;
  srcFov: number;
  dstFov: number;
  durationMs: number;
  hopHeightM: number;
  // Set for a fly-to-CP flight: keep the camera pointed at this control point
  // every frame so it stays screen-centered (the "orbit the point" effect).
  // offsetAz/offsetAlt are the camera's initial framing error vs. looking
  // straight at the CP; they decay to zero early on for a smooth lock-on.
  // null for ordinary station-to-station flights (linear orientation tween).
  focus: { lat: number; lng: number; alt: number; offsetAz: number; offsetAlt: number } | null;
}

export function createStationNavigation(deps: StationNavigationDeps): StationNavigation {
  const {
    viewer, terrain, cpColumns, photoPreviews,
    worldCamera,
    getCurrentStationId, getStationName,
    getOtherStations, setOtherStations,
    loadStation,
  } = deps;

  let flyInProgress = false;

  function beginFlight(): boolean {
    if (flyInProgress) return false;
    flyInProgress = true;
    return true;
  }

  function endFlight(): void {
    flyInProgress = false;
  }

  function captureFlightStart(destId: string): Flight {
    const startPose = worldCamera.getPose();
    const currentStationId = getCurrentStationId();
    if (!startPose.location || startPose.stationAnchor === null
        || startPose.stationAltitudeMSL === null || destId === currentStationId) {
      return { kind: 'direct-load' };
    }
    return {
      kind: 'normal',
      startStationId: currentStationId,
      startStationName: getStationName(),
      startLocation: { lat: startPose.location.lat, lng: startPose.location.lng },
      startAltMSL: startPose.altitudeMSL,
      anchor: { lat: startPose.stationAnchor.lat, lng: startPose.stationAnchor.lng },
      anchorAltMSL: startPose.stationAltitudeMSL,
      savedOtherStations: getOtherStations(),
    };
  }

  async function fetchDestinationOrLoadDirect(
    destId: string, fallbackFocus: CpFlightFocus | null,
  ): Promise<api.ApiHydratedStation | null> {
    try {
      return await api.getStation(destId);
    } catch (err) {
      console.error('fly: dest fetch failed:', err);
      await loadStation(destId, undefined, fallbackFocus);
      return null;
    }
  }

  function isFlightStillCurrent(flight: NormalFlight): boolean {
    return getCurrentStationId() === flight.startStationId;
  }

  function buildFlightPlan(
    flight: NormalFlight, dest: api.ApiHydratedStation, focusCpId: string | null,
  ): FlightPlan {
    // Fly starts from the live camera (shift-wheel-driven override if any,
    // else the station anchor) but the *station leaves behind* is the
    // anchor — that's the dot that appears in the destination view.
    const src = {
      lat: flight.startLocation.lat, lng: flight.startLocation.lng, alt: flight.startAltMSL,
    };
    const dst = { lat: dest.station.lat, lng: dest.station.lng, alt: dest.station.alt };

    const { azimuth: srcAz, altitude: srcAlt } = viewer.getAzAlt();
    const srcFov = viewer.camera.fov;
    // A fly-to-CP target stays centered on the control point the whole way (the
    // step loop re-aims each frame) and lands at the FOV that keeps it the same
    // on-screen size as before the flight; otherwise center on the station's
    // mean photo orientation at DEFAULT_FOV via a plain linear tween.
    const focusPlan = focusCpId ? planCpFocus(dest, focusCpId, src, srcFov) : null;
    const dstOrient = focusPlan ?? meanPhotoAzAlt(dest.photos);
    const dstAz = dstOrient?.az ?? srcAz;
    const dstAlt = dstOrient?.alt ?? srcAlt;
    const azDelta = wrapPi(dstAz - srcAz);
    const dstFov = focusPlan ? focusPlan.fov : DEFAULT_FOV;
    // Initial framing offset: how far the current view sits from looking
    // straight at the CP from the start position. Decays during the flight so
    // the lock-on eases in instead of snapping the CP to center on frame 0.
    const focus = focusPlan ? {
      lat: focusPlan.cp.lat, lng: focusPlan.cp.lng, alt: focusPlan.cp.alt,
      offsetAz: wrapPi(srcAz - focusPlan.srcLookAz),
      offsetAlt: srcAlt - focusPlan.srcLookAlt,
    } : null;

    const distM = groundDistance(src, dst);
    const durationMs = Math.min(4000, Math.max(1000, distM * 3));
    // Parabolic hop: clear cap keeps very long flights from going suborbital.
    const hopHeightM = Math.max(5, Math.min(distM * 0.15, 200));

    return { src, dst, srcAz, azDelta, srcAlt, dstAlt, srcFov, dstFov, durationMs, hopHeightM, focus };
  }

  function prepareFlightScene(flight: NormalFlight, dest: api.ApiHydratedStation): void {
    setOtherStations([...flight.savedOtherStations, {
      id: flight.startStationId,
      name: flight.startStationName,
      anchor: { lat: flight.anchor.lat, lng: flight.anchor.lng },
      altitude: flight.anchorAltMSL,
    }]);

    // CP markers + observation lines connect world-space CPs to
    // source-anchored POIs; hide the whole CP layer until the post-fly
    // reload rebuilds it for the destination station.
    cpColumns.setVisible(false);

    photoPreviews.set(dest.photos.map(p => ({
      photoId: p.id, blobPath: p.blob_path,
      fromLat: dest.station.lat, fromLng: dest.station.lng, fromAlt: dest.station.alt,
      photoAz: p.photo_az, photoTilt: p.photo_tilt, photoRoll: p.photo_roll,
      sizeRad: p.size_rad, aspect: p.aspect,
    })));
  }

  async function animateFlight(plan: FlightPlan): Promise<void> {
    const { src, dst, srcAz, azDelta, srcAlt, dstAlt, srcFov, dstFov, durationMs, hopHeightM, focus } = plan;
    await new Promise<void>(resolve => {
      const startTime = performance.now();
      function step(now: number): void {
        const tau = Math.min(1, (now - startTime) / durationMs);
        const k = easeInOutCubic(tau);
        const lat = src.lat + (dst.lat - src.lat) * k;
        const lng = src.lng + (dst.lng - src.lng) * k;
        const alt = src.alt + (dst.alt - src.alt) * k + hopHeightM * Math.sin(Math.PI * k);
        const loc = { lat, lng };
        // Pose update fans out to dots, cones, rays, constraints, and
        // the overlaysGroup offset via the host's pushPose subscriber —
        // the source panes stay glued to the anchor as the camera flies.
        worldCamera.setLiveCamera({ location: loc, altitudeMSL: alt });
        terrain.setLocation(loc);
        terrain.setCameraMSL(alt);
        if (focus) {
          // Orbit the point: look from the current position straight at the CP
          // so it stays screen-centered. The initial framing offset decays over
          // the first CP_LOCK_FRACTION of the flight for a smooth lock-on.
          const look = azAltToPoint(loc, alt, { lat: focus.lat, lng: focus.lng }, focus.alt);
          const settle = 1 - easeInOutCubic(Math.min(1, tau / CP_LOCK_FRACTION));
          viewer.setAzAlt(look.az + focus.offsetAz * settle, look.alt + focus.offsetAlt * settle);
        } else {
          viewer.setAzAlt(srcAz + azDelta * k, srcAlt + (dstAlt - srcAlt) * k);
        }
        viewer.setFov(srcFov + (dstFov - srcFov) * k);
        // Destination-photo previews track the camera in world space.
        // Visual quirk at k=1: the destination's cone apex / ray origins
        // coincide with the camera at world (0,0,0), so the GPU clips
        // those line segments at the near plane and they emerge from a
        // small starburst near image center instead of one converging
        // point. We accept this — landing slightly back of the lens to
        // hide it would put the camera at a non-station position.
        photoPreviews.update(loc, alt);
        viewer.requestRender();
        if (tau < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  async function finishFlight(
    destId: string, dest: api.ApiHydratedStation, focus: CpFlightFocus | null,
  ): Promise<void> {
    // Hide before reset so source panes don't snap to origin for one
    // frame before clearStationData removes them.
    viewer.overlaysGroup.visible = false;
    viewer.overlaysGroup.position.set(0, 0, 0);
    await loadStation(destId, dest, focus);
  }

  function restoreFlightScene(): void {
    viewer.overlaysGroup.visible = true;
    viewer.overlaysGroup.position.set(0, 0, 0);
    cpColumns.setVisible(true);
    photoPreviews.clear();
  }

  async function flyToStation(destId: string, focusCpId: string | null = null): Promise<void> {
    if (!beginFlight()) return;

    // Load paths that don't run animateFlight (no station pose yet, or the dest
    // fetch failed) can't size-match the FOV, so they zoom to the standard
    // focus FOV. The animated path overrides this with its tweened FOV below.
    const fallbackFocus: CpFlightFocus | null =
      focusCpId ? { cpId: focusCpId, fovDeg: FOCUS_FOV_DEG } : null;

    const flight = captureFlightStart(destId);
    if (flight.kind === 'direct-load') {
      try { await loadStation(destId, undefined, fallbackFocus); }
      finally { endFlight(); }
      return;
    }

    try {
      const dest = await fetchDestinationOrLoadDirect(destId, fallbackFocus);
      if (!dest) return;

      if (!isFlightStillCurrent(flight)) return;

      const plan = buildFlightPlan(flight, dest, focusCpId);
      prepareFlightScene(flight, dest);

      await animateFlight(plan);

      if (!isFlightStillCurrent(flight)) return;

      // The animation already tweened the FOV to plan.dstFov (size-matched when
      // focusing); land on exactly that so the post-hydrate focus doesn't snap.
      await finishFlight(destId, dest,
        focusCpId ? { cpId: focusCpId, fovDeg: plan.dstFov } : null);
    } finally {
      restoreFlightScene();
      endFlight();
    }
  }

  return { flyToStation };
}
