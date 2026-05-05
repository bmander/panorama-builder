import * as THREE from 'three';
import { createPhotoStore } from './overlay-photos.js';
import { createMeasurementStore } from './overlay-measurements.js';
import { createControlPointRegistry } from './overlay-control-points.js';
import type { PhotoStore } from './overlay-photos.js';
import type { MeasurementStore } from './overlay-measurements.js';
import type { ControlPointRegistry } from './overlay-control-points.js';

export {
  OVERLAY_R,
  DEFAULT_SIZE_RAD,
  SIZE_MIN,
  SIZE_MAX,
  ROLE_BODY,
  ROLE_OUTLINE,
  ROLE_HANDLE_DRAG,
  ROLE_HANDLE_ROTATE,
  ROLE_HANDLE_FOV,
  dirFromAzAlt,
} from './overlay-photos.js';
export { ROLE_POI } from './overlay-measurements.js';

export type { PhotoStore, AddPhotoOptions } from './overlay-photos.js';
export type { MeasurementStore, AddImageMeasurementOptions } from './overlay-measurements.js';
export type {
  ControlPointRegistry,
  AddControlPointPayload,
  ControlPointEst,
} from './overlay-control-points.js';

export interface OverlayManager {
  photos: PhotoStore;
  measurements: MeasurementStore;
  controlPoints: ControlPointRegistry;
  beginBatch(): void;
  endBatch(): void;
  withBatch(fn: () => void): void;
  setVisualsVisible(visible: boolean): void;
  // Lets the host build the manager before sync/baker/scene refreshers
  // exist, then attach hooks once they do.
  setCallbacks(cbs: OverlayManagerCallbacks): void;
}

export interface OverlayManagerCallbacks {
  onMutate?: () => void;
  onSelectionChange?: () => void;
  onLightMutate?: () => void;
}

export type CreateOverlayManagerOptions = {
  overlaysGroup: THREE.Group;
  getAnisotropy: () => number;
} & OverlayManagerCallbacks;

export function createOverlayManager(
  { overlaysGroup, getAnisotropy, onMutate, onSelectionChange, onLightMutate }: CreateOverlayManagerOptions,
): OverlayManager {
  const cbs: {
    onMutate: (() => void) | undefined;
    onSelectionChange: (() => void) | undefined;
    onLightMutate: (() => void) | undefined;
  } = { onMutate, onSelectionChange, onLightMutate };
  let batching = 0;
  let batchedNotify = false;

  const notify = (): void => {
    if (batching > 0) { batchedNotify = true; return; }
    cbs.onMutate?.();
  };
  const notifyLight = (): void => { cbs.onLightMutate?.(); };
  const notifySelection = (): void => { cbs.onSelectionChange?.(); };

  const measurements = createMeasurementStore({
    overlaysGroup,
    notify,
    notifySelection,
  });

  const photos = createPhotoStore({
    overlaysGroup,
    getAnisotropy,
    notify,
    notifyLight,
    layoutPoisOn: (o, w, h) => { measurements.layoutPoisOn(o, w, h); },
    disposePoisOn: (o) => { measurements.disposePoisOn(o); },
    clearMeasurementSelectionForOverlay: (o) => { measurements.clearSelectionForOverlay(o); },
  });

  const controlPoints = createControlPointRegistry({
    notify,
    getSelectedControlPointId: () => measurements.getSelectedControlPointId(),
    clearControlPointLinks: (id) => { measurements.clearControlPointLinks(id); },
  });

  const manager: OverlayManager = {
    photos,
    measurements,
    controlPoints,
    beginBatch() { batching++; },
    endBatch() {
      batching--;
      if (batching === 0 && batchedNotify) { batchedNotify = false; cbs.onMutate?.(); }
    },
    withBatch(fn) {
      manager.beginBatch();
      try { fn(); } finally { manager.endBatch(); }
    },
    setVisualsVisible(visible) {
      photos.setVisualsVisible(visible);
      measurements.setVisualsVisible(visible);
    },
    setCallbacks(next) {
      cbs.onMutate = next.onMutate;
      cbs.onSelectionChange = next.onSelectionChange;
      cbs.onLightMutate = next.onLightMutate;
    },
  };
  return manager;
}
