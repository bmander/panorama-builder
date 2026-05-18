// Sundial: the gnomon / shadow picker workflow and the camera-anchored
// marker dot + line that visualizes the picked points. Wraps the
// sundialModal: owns the activePicker mode, the per-pick marker-dot list,
// and the onPicksChange subscriber-fan-out the pose pump uses to re-render.

import * as THREE from 'three';
import { createSundialModal } from '../sundial-modal.js';
import type { ShadowLocation, SundialPickField } from '../sundial-modal.js';
import type { Dot } from '../dot-layer.js';
import { getElement } from '../types.js';
import type { ControlPointView } from '../types.js';

const SUNDIAL_SHADOW_COLOR = new THREE.Color(0xffaa44);

export interface SundialController {
  open(): void;
  reset(): void;
  // Sundial picker mode. interactions reads this to route the next CP/surface
  // click to onGnomonPicked / onShadowPicked instead of opening a context
  // menu.
  getActivePicker(): SundialPickField | null;
  onGnomonPicked(cpId: string): void;
  onShadowPicked(surfaceId: string, loc: ShadowLocation): void;
  // Pose-snapshot accessors.
  getMarkerDots(): readonly Dot[];
  getGnomonCpId(): string | null;
  getShadowLocation(): ShadowLocation | null;
  // Fires when picks change; caller typically re-applies pose so the new
  // dot/line geometry paints.
  onPicksChange(cb: () => void): () => void;
}

export interface CreateSundialControllerOptions {
  readonly getControlPoint: (id: string) => ControlPointView | null;
  readonly getCapturedAtYear: () => number | null;
}

export function createSundialController(opts: CreateSundialControllerOptions): SundialController {
  let activePicker: SundialPickField | null = null;
  let markerDots: readonly Dot[] = [];
  const subscribers = new Set<() => void>();

  const modal = createSundialModal({
    getControlPoint: opts.getControlPoint,
    getCapturedAtYear: opts.getCapturedAtYear,
    onPickStart: (field) => { activePicker = field; },
    onPicksChange: () => {
      const loc = modal.getShadowLocation();
      markerDots = loc === null
        ? []
        : [{ anchor: loc.latlng, altitude: loc.altitude, color: SUNDIAL_SHADOW_COLOR }];
      for (const cb of subscribers) cb();
    },
  });

  getElement<HTMLButtonElement>('sun-dial-btn').addEventListener('click', () => {
    modal.open();
  });

  return {
    open: () => { modal.open(); },
    reset: () => {
      activePicker = null;
      modal.reset();
      markerDots = [];
    },
    getActivePicker: () => activePicker,
    onGnomonPicked: (cpId) => {
      activePicker = null;
      modal.onGnomonPicked(cpId);
    },
    onShadowPicked: (surfaceId, latlng) => {
      activePicker = null;
      modal.onShadowPicked(surfaceId, latlng);
    },
    getMarkerDots: () => markerDots,
    getGnomonCpId: () => modal.getGnomonCpId(),
    getShadowLocation: () => modal.getShadowLocation(),
    onPicksChange: (cb) => {
      subscribers.add(cb);
      return () => { subscribers.delete(cb); };
    },
  };
}
