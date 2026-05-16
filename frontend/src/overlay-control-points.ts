import type { CPLifespan, ControlPointView } from './types.js';

export interface AddControlPointPayload {
  readonly description: string;
  readonly estLat: number | null;
  readonly estLng: number | null;
  readonly estAlt: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly derivedStartedAtLower: string | null;
  readonly derivedStartedAtUpper: string | null;
  readonly derivedEndedAtLower: string | null;
  readonly derivedEndedAtUpper: string | null;
  readonly inconsistent: boolean;
}

export interface ControlPointEst {
  readonly lat: number | null;
  readonly lng: number | null;
  readonly alt: number | null;
}

export interface ControlPointRegistry {
  add(id: string, payload: AddControlPointPayload): void;
  list(): ControlPointView[];
  getById(id: string): ControlPointView | null;
  setEst(id: string, est: ControlPointEst): void;
  setDescription(id: string, description: string): void;
  setLifespan(id: string, span: CPLifespan): void;
  remove(id: string): void;
}

interface ControlPointEntry {
  id: string;
  description: string;
  estLat: number | null;
  estLng: number | null;
  estAlt: number | null;
  startedAt: string | null;
  endedAt: string | null;
  derivedStartedAtLower: string | null;
  derivedStartedAtUpper: string | null;
  derivedEndedAtLower: string | null;
  derivedEndedAtUpper: string | null;
  inconsistent: boolean;
}

export interface CreateControlPointRegistryOptions {
  notify: () => void;
  getSelectedControlPointId: () => string | null;
  // Mirrors the backend's ON DELETE SET NULL on image_measurements.control_point_id.
  clearControlPointLinks: (controlPointId: string) => void;
}

export function createControlPointRegistry(
  { notify, getSelectedControlPointId, clearControlPointLinks }: CreateControlPointRegistryOptions,
): ControlPointRegistry {
  const entries: ControlPointEntry[] = [];

  const toView = (cp: ControlPointEntry, selectedId: string | null): ControlPointView => ({
    id: cp.id,
    description: cp.description,
    estLat: cp.estLat,
    estLng: cp.estLng,
    estAlt: cp.estAlt,
    startedAt: cp.startedAt,
    endedAt: cp.endedAt,
    derivedStartedAtLower: cp.derivedStartedAtLower,
    derivedStartedAtUpper: cp.derivedStartedAtUpper,
    derivedEndedAtLower: cp.derivedEndedAtLower,
    derivedEndedAtUpper: cp.derivedEndedAtUpper,
    inconsistent: cp.inconsistent,
    selected: cp.id === selectedId,
  });

  return {
    add(id, payload) {
      entries.push({
        id,
        description: payload.description,
        estLat: payload.estLat,
        estLng: payload.estLng,
        estAlt: payload.estAlt,
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        derivedStartedAtLower: payload.derivedStartedAtLower,
        derivedStartedAtUpper: payload.derivedStartedAtUpper,
        derivedEndedAtLower: payload.derivedEndedAtLower,
        derivedEndedAtUpper: payload.derivedEndedAtUpper,
        inconsistent: payload.inconsistent,
      });
      notify();
    },
    list() {
      const selectedId = getSelectedControlPointId();
      return entries.map(cp => toView(cp, selectedId));
    },
    getById(id) {
      const cp = entries.find(c => c.id === id);
      if (!cp) return null;
      return toView(cp, getSelectedControlPointId());
    },
    setEst(id, est) {
      const cp = entries.find(c => c.id === id);
      if (!cp) return;
      if (cp.estLat === est.lat && cp.estLng === est.lng && cp.estAlt === est.alt) return;
      cp.estLat = est.lat;
      cp.estLng = est.lng;
      cp.estAlt = est.alt;
      notify();
    },
    setDescription(id, description) {
      const cp = entries.find(c => c.id === id);
      if (!cp || cp.description === description) return;
      cp.description = description;
      notify();
    },
    setLifespan(id, span) {
      const cp = entries.find(c => c.id === id);
      if (!cp) return;
      if (
        cp.startedAt === span.startedAt
        && cp.endedAt === span.endedAt
        && cp.derivedStartedAtLower === span.derivedStartedAtLower
        && cp.derivedStartedAtUpper === span.derivedStartedAtUpper
        && cp.derivedEndedAtLower === span.derivedEndedAtLower
        && cp.derivedEndedAtUpper === span.derivedEndedAtUpper
        && cp.inconsistent === span.inconsistent
      ) return;
      cp.startedAt = span.startedAt;
      cp.endedAt = span.endedAt;
      cp.derivedStartedAtLower = span.derivedStartedAtLower;
      cp.derivedStartedAtUpper = span.derivedStartedAtUpper;
      cp.derivedEndedAtLower = span.derivedEndedAtLower;
      cp.derivedEndedAtUpper = span.derivedEndedAtUpper;
      cp.inconsistent = span.inconsistent;
      notify();
    },
    remove(id) {
      const i = entries.findIndex(c => c.id === id);
      if (i < 0) return;
      entries.splice(i, 1);
      clearControlPointLinks(id);
      notify();
    },
  };
}
