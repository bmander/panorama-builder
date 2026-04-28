// Migration shim. Workers converting map.js DELETE this file.
import type * as THREE from 'three';
import type { Cone, LatLng, POIBearing } from './types.js';

export interface MapView {
  getLocation(): LatLng | null;
  setLocation(latlng: LatLng | null): void;
  viewerAzToAnchor(latlng: LatLng): number;
  setOverlayCones(newCones: Cone[]): void;
  setPOIBearings(newPOIs: POIBearing[]): void;
  isVisible(): boolean;
  onShow(): void;
  onHide(): void;
}

export function createMapView(options: {
  container: HTMLElement;
  onLocationChange?: (loc: LatLng) => void;
  onPOIAnchorClick?: (handle: THREE.Mesh, latlng: LatLng) => void;
  onPOIAnchorDragged?: (handle: THREE.Mesh, latlng: LatLng, viewerAz: number) => void;
  onShowRefresh?: () => void;
}): MapView;
