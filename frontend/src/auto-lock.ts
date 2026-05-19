// Auto-lock derives per-axis locks from the matched-observation count on the
// owning entity. The rule mirrors backend/solver/autolock.go exactly so the
// solver and the lock UI agree on what's free. Manual locks (the lock_*
// columns) stay as user intent; the effective lock the UI shows and the
// solver applies is manual || auto.

// Minimum matched-observation count required to *unlock* each axis. Below
// the threshold ⇒ axis is auto-locked. Photo-owned axes use the per-photo
// count; station-owned axes use the station-total count.
//
// Keep in sync with backend/solver/autolock.go.
export const AUTO_LOCK_THRESHOLDS = {
  // photo-owned
  photoAz: 1,
  photoTilt: 1,
  photoRoll: 4,
  sizeRad: 2,
  distK1: 5,
  distK2: 5,
  // station-owned
  lat: 3,
  lng: 3,
  alt: 4,
} as const;

export interface PhotoAutoLock {
  readonly photoAz: boolean;
  readonly photoTilt: boolean;
  readonly photoRoll: boolean;
  readonly sizeRad: boolean;
  readonly distK1: boolean;
  readonly distK2: boolean;
}

export interface StationAutoLock {
  readonly lat: boolean;
  readonly lng: boolean;
  readonly alt: boolean;
}

// Minimal shape: anything carrying a control_point_id and (for the
// per-photo cut) a photoId. Accepts the API row, the scene-graph
// ImageMeasurementBearing, or any other carrier.
export interface AutoLockMeasurement {
  readonly photoId: string;
  readonly controlPointId: string | null;
}

export function photoAutoLockFor(matchedCount: number): PhotoAutoLock {
  return {
    photoAz: matchedCount < AUTO_LOCK_THRESHOLDS.photoAz,
    photoTilt: matchedCount < AUTO_LOCK_THRESHOLDS.photoTilt,
    photoRoll: matchedCount < AUTO_LOCK_THRESHOLDS.photoRoll,
    sizeRad: matchedCount < AUTO_LOCK_THRESHOLDS.sizeRad,
    distK1: matchedCount < AUTO_LOCK_THRESHOLDS.distK1,
    distK2: matchedCount < AUTO_LOCK_THRESHOLDS.distK2,
  };
}

export function stationAutoLockFor(matchedCount: number): StationAutoLock {
  return {
    lat: matchedCount < AUTO_LOCK_THRESHOLDS.lat,
    lng: matchedCount < AUTO_LOCK_THRESHOLDS.lng,
    alt: matchedCount < AUTO_LOCK_THRESHOLDS.alt,
  };
}

// Sum matched (control_point_id != null) measurements per photo id.
export function countMatchedByPhoto(
  measurements: Iterable<AutoLockMeasurement>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of measurements) {
    if (m.controlPointId === null) continue;
    counts.set(m.photoId, (counts.get(m.photoId) ?? 0) + 1);
  }
  return counts;
}

// Render one lock checkbox with the effective state (manual || auto).
// When auto-locked, the checkbox is forced checked and disabled; the
// tooltip names the threshold so the user knows what would unlock it.
// Returns the effective bool so the caller can reuse it (e.g. to hide
// the σ readout for an effectively-locked axis).
export function applyLockState(
  el: HTMLInputElement, manual: boolean, auto: boolean, threshold: number,
): boolean {
  const effective = manual || auto;
  if (el.checked !== effective && document.activeElement !== el) {
    el.checked = effective;
  }
  el.disabled = auto;
  el.title = auto
    ? `auto-locked: needs ${threshold.toString()} matched observations`
    : '';
  return effective;
}
