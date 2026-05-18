// Route + URL state for the station view. Owns the mutable stationId, the
// focused-id deep-link state, the URL camera-param read/write, the
// "view on map" anchor sync, and the popstate listener. No imports from
// viewer / worldCamera: callers translate between domain values and
// UrlCameraSnapshot's plain-number fields.

import { getElement, indexStationHref, parseStaFromURL, stationHref } from '../types.js';

const URL_AZ = 'az';
const URL_ALT = 'alt';
const URL_FOV = 'fov';
const URL_CAM_LA = 'cam_la';
const URL_CAM_LO = 'cam_lo';
const URL_CAM_MSL = 'cam_msl';

export interface UrlCameraSnapshot {
  // null when the URL omits the param (or the value failed validation).
  readonly azDeg: number | null;
  readonly altDeg: number | null;
  readonly fovDeg: number | null;
  // Live camera override; null whenever the camera is still anchored on the
  // station (cam_la/lo/msl get dropped from the URL in that case).
  readonly live: { readonly lat: number; readonly lng: number; readonly altitudeMSL: number } | null;
}

export interface StationRouteState {
  getStationId(): string;
  setStationId(newId: string): void;
  pushStationToHistory(newId: string): void;
  getFocusedCpId(): string | null;
  clearFocusedCpId(): void;
  // One-shot: returns the URL-supplied focus measurement id once, then null.
  consumeFocusImageMeasurementId(): string | null;
  readCameraFromURL(): UrlCameraSnapshot;
  writeCameraToURL(snapshot: UrlCameraSnapshot): void;
  // Subscriber fires with the station id parsed from `?sta=` on every popstate.
  // null when the URL has no valid sta param.
  onPopState(cb: (stationIdFromUrl: string | null) => void): () => void;
}

export interface CreateStationRouteStateOptions {
  readonly initialStationId: string;
  readonly focusImageMeasurementId: string | null;
  readonly focusControlPointId: string | null;
}

function parseUrlFloat(sp: URLSearchParams, key: string, validate?: (v: number) => boolean): number | null {
  const v = parseFloat(sp.get(key) ?? '');
  if (!Number.isFinite(v)) return null;
  if (validate && !validate(v)) return null;
  return v;
}

export function createStationRouteState(opts: CreateStationRouteStateOptions): StationRouteState {
  let stationId = opts.initialStationId;
  let focusedCpId = opts.focusControlPointId;
  let focusImageMeasurementId: string | null = opts.focusImageMeasurementId;

  function syncViewOnMapHref(): void {
    getElement<HTMLAnchorElement>('view-on-map').href = indexStationHref(stationId);
  }
  syncViewOnMapHref();

  function setStationId(newId: string): void {
    stationId = newId;
    syncViewOnMapHref();
  }

  function pushStationToHistory(newId: string): void {
    history.pushState(null, '', stationHref(newId));
  }

  function readCameraFromURL(): UrlCameraSnapshot {
    const sp = new URLSearchParams(location.search);
    const azDeg = parseUrlFloat(sp, URL_AZ);
    const altDeg = parseUrlFloat(sp, URL_ALT, v => Math.abs(v) <= 90);
    const fovDeg = parseUrlFloat(sp, URL_FOV, v => v > 0 && v < 180);
    const camLat = parseUrlFloat(sp, URL_CAM_LA, v => Math.abs(v) <= 90);
    const camLng = parseUrlFloat(sp, URL_CAM_LO, v => Math.abs(v) <= 180);
    const camMsl = parseUrlFloat(sp, URL_CAM_MSL);
    const live = (camLat !== null && camLng !== null && camMsl !== null)
      ? { lat: camLat, lng: camLng, altitudeMSL: camMsl }
      : null;
    return { azDeg, altDeg, fovDeg, live };
  }

  function writeCameraToURL(snapshot: UrlCameraSnapshot): void {
    const url = new URL(location.href);
    const sp = url.searchParams;
    if (snapshot.azDeg !== null) sp.set(URL_AZ, snapshot.azDeg.toFixed(1));
    if (snapshot.altDeg !== null) sp.set(URL_ALT, snapshot.altDeg.toFixed(1));
    if (snapshot.fovDeg !== null) sp.set(URL_FOV, snapshot.fovDeg.toFixed(1));
    if (snapshot.live) {
      sp.set(URL_CAM_LA, snapshot.live.lat.toFixed(6));
      sp.set(URL_CAM_LO, snapshot.live.lng.toFixed(6));
      sp.set(URL_CAM_MSL, snapshot.live.altitudeMSL.toFixed(2));
    } else {
      sp.delete(URL_CAM_LA);
      sp.delete(URL_CAM_LO);
      sp.delete(URL_CAM_MSL);
    }
    if (url.href === location.href) return;
    history.replaceState(null, '', url);
  }

  function onPopState(cb: (stationIdFromUrl: string | null) => void): () => void {
    const handler = (): void => { cb(parseStaFromURL()); };
    addEventListener('popstate', handler);
    return () => { removeEventListener('popstate', handler); };
  }

  return {
    getStationId: () => stationId,
    setStationId,
    pushStationToHistory,
    getFocusedCpId: () => focusedCpId,
    clearFocusedCpId: () => { focusedCpId = null; },
    consumeFocusImageMeasurementId: () => {
      const v = focusImageMeasurementId;
      focusImageMeasurementId = null;
      return v;
    },
    readCameraFromURL,
    writeCameraToURL,
    onPopState,
  };
}
