// Migration shim. Workers converting geo.js DELETE this file.
import type { LatLng } from './types.js';

export const R_EARTH: number;
export function bearingFromLocation(loc: LatLng, latlng: LatLng): number;
export function groundDistance(a: LatLng, b: LatLng): number;
export function viewerAzToBearing(az: number): number;
export function bearingToViewerAz(bDeg: number): number;
