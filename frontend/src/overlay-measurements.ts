import * as THREE from 'three';
import type { ImageMeasurementBearing, Role } from './types.js';
import { overlayData, poiData } from './types.js';
import { DEFAULT_SIZE_RAD, azFromLocal, widthFromSizeRad } from './overlay-photos.js';

export const ROLE_POI = 'poi' satisfies Role;

const POI_COLOR = 0xff5050;
const POI_COLOR_SELECTED = 0xffff66;
// POI radius = this fraction of a *reference* photo width — POIs stay the
// same on-screen size regardless of the host photo's individual size_rad.
const POI_WIDTH_FRACTION = 0.054;
const POI_REFERENCE_WIDTH = widthFromSizeRad(DEFAULT_SIZE_RAD);

const POI_GEOM = new THREE.PlaneGeometry(2, 2);

function makePoiMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(POI_COLOR) } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 color;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float ring = 1.0 - smoothstep(0.04, 0.06, abs(r - 0.7));
        float chh = (1.0 - smoothstep(0.03, 0.05, abs(p.y))) * step(0.10, abs(p.x)) * step(abs(p.x), 0.85);
        float chv = (1.0 - smoothstep(0.03, 0.05, abs(p.x))) * step(0.10, abs(p.y)) * step(abs(p.y), 0.85);
        float a = max(ring, max(chh, chv));
        if (a < 0.01) discard;
        gl_FragColor = vec4(color, a);
      }
    `,
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  material.customProgramCacheKey = (): string => 'poi-reticle';
  return material;
}

function setPoiColor(poi: THREE.Mesh, hex: number): void {
  const mat = poi.material as THREE.ShaderMaterial;
  (mat.uniforms.color!.value as THREE.Color).setHex(hex);
}

export interface AddImageMeasurementOptions {
  readonly id: string;
  readonly controlPointId?: string | null;
}

export interface MeasurementStore {
  add(o: THREE.Group, u: number, v: number, opts: AddImageMeasurementOptions): THREE.Mesh;
  move(measurement: THREE.Mesh, u: number, v: number): void;
  setControlPoint(measurement: THREE.Mesh, controlPointId: string | null): void;
  deleteSelected(): void;
  list(): ImageMeasurementBearing[];
  getById(id: string): THREE.Mesh | null;
  findOnOverlayByCpId(overlay: THREE.Group, controlPointId: string): THREE.Mesh | null;
  getSelected(): THREE.Mesh | null;
  setSelected(measurement: THREE.Mesh | null): void;
  setHovered(measurement: THREE.Mesh | null): boolean;
  setFovScale(scale: number): void;
  setVisualsVisible(visible: boolean): void;
}

// Cross-store hooks consumed only by the overlay façade when wiring photo
// store + control point registry. Not exposed on OverlayManager.measurements.
export interface MeasurementStoreHooks {
  layoutPoisOn(o: THREE.Group, w: number, h: number): void;
  disposePoisOn(o: THREE.Group): void;
  clearControlPointLinks(controlPointId: string): void;
  clearSelectionForOverlay(o: THREE.Group): void;
  getSelectedControlPointId(): string | null;
}

export interface CreateMeasurementStoreOptions {
  overlaysGroup: THREE.Group;
  notify: () => void;
  notifySelection: () => void;
}

export function createMeasurementStore(
  { overlaysGroup, notify, notifySelection }: CreateMeasurementStoreOptions,
): MeasurementStore & MeasurementStoreHooks {
  let selected: THREE.Mesh | null = null;
  let hovered: THREE.Mesh | null = null;
  // Multiplier on POI world-size so on-screen pixel size stays roughly
  // constant as FOV changes. 1.0 = default FOV; the host updates this on
  // every camera FOV change.
  let poiFovScale = 1;

  // The selected CP is derived from the selected measurement, so a selection
  // lights up every other measurement referencing the same CP.
  const selectedControlPointId = (): string | null =>
    selected ? poiData(selected).controlPointId : null;

  const hoveredControlPointId = (): string | null =>
    hovered ? poiData(hovered).controlPointId : null;

  // A POI is "selected" if the user clicked it directly OR if it shares a
  // control point with the currently selected POI — so all reticules for
  // one landmark highlight as a group.
  const isSelected = (poi: THREE.Mesh, controlPointId: string | null): boolean => {
    if (poi === selected) return true;
    return controlPointId !== null && controlPointId === selectedControlPointId();
  };

  // Hover follows the same group rule as selection. Visually selected and
  // hovered share one yellow color, so isHighlighted = isSelected ∨ isHovered.
  const isHighlighted = (poi: THREE.Mesh, controlPointId: string | null): boolean => {
    if (isSelected(poi, controlPointId)) return true;
    if (poi === hovered) return true;
    return controlPointId !== null && controlPointId === hoveredControlPointId();
  };

  const currentPoiRadius = (): number =>
    POI_REFERENCE_WIDTH * POI_WIDTH_FRACTION * poiFovScale;

  const placePoi = (poi: THREE.Mesh, u: number, v: number, w: number, h: number): void => {
    poi.position.set((u - 0.5) * w, (v - 0.5) * h, 0);
    poi.scale.setScalar(currentPoiRadius());
  };

  function applyPOIColors(): void {
    for (const child of overlaysGroup.children) {
      const data = overlayData(child as THREE.Group);
      if (!data.pois) continue;
      for (const poi of data.pois) {
        const pData = poiData(poi);
        setPoiColor(poi, isHighlighted(poi, pData.controlPointId) ? POI_COLOR_SELECTED : POI_COLOR);
      }
    }
  }

  const store: MeasurementStore & MeasurementStoreHooks = {
    add(o, u, v, opts) {
      const measurement = new THREE.Mesh(POI_GEOM, makePoiMaterial());
      const pData = poiData(measurement);
      pData.id = opts.id;
      pData.role = ROLE_POI;
      pData.uv = { u, v };
      pData.parentOverlay = o;
      pData.controlPointId = opts.controlPointId ?? null;
      measurement.renderOrder = 3;
      o.add(measurement);
      const data = overlayData(o);
      const pois = data.pois ?? (data.pois = []);
      pois.push(measurement);
      placePoi(measurement, u, v, data.body.scale.x, data.body.scale.y);
      store.setSelected(measurement);
      notify();
      return measurement;
    },
    move(measurement, u, v) {
      const pData = poiData(measurement);
      pData.uv.u = u;
      pData.uv.v = v;
      const data = overlayData(pData.parentOverlay);
      placePoi(measurement, u, v, data.body.scale.x, data.body.scale.y);
      notify();
    },
    setControlPoint(measurement, controlPointId) {
      poiData(measurement).controlPointId = controlPointId;
      notify();
    },
    deleteSelected() {
      if (!selected) return;
      const measurement = selected;
      store.setSelected(null);
      if (hovered === measurement) hovered = null;
      const parent = poiData(measurement).parentOverlay;
      parent.remove(measurement);
      const arr = overlayData(parent).pois;
      if (arr) {
        const i = arr.indexOf(measurement);
        if (i >= 0) arr.splice(i, 1);
      }
      (measurement.material as THREE.Material).dispose();
      notify();
    },
    list() {
      const result: ImageMeasurementBearing[] = [];
      for (const child of overlaysGroup.children) {
        const o = child as THREE.Group;
        const data = overlayData(o);
        if (!data.pois) continue;
        for (const poi of data.pois) {
          const pData = poiData(poi);
          result.push({
            id: pData.id,
            handle: poi,
            az: azFromLocal(o, poi.position.x, poi.position.y, poi.position.z),
            uv: { ...pData.uv },
            controlPointId: pData.controlPointId,
            selected: isSelected(poi, pData.controlPointId),
          });
        }
      }
      return result;
    },
    getById(id) {
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const p of data.pois) {
          if (poiData(p).id === id) return p;
        }
      }
      return null;
    },
    findOnOverlayByCpId(overlay, controlPointId) {
      const data = overlayData(overlay);
      if (!data.pois) return null;
      for (const p of data.pois) {
        if (poiData(p).controlPointId === controlPointId) return p;
      }
      return null;
    },
    getSelected: () => selected,
    setSelected(measurement) {
      if (selected === measurement) return;
      selected = measurement;
      applyPOIColors();
      notifySelection();
    },
    setHovered(measurement) {
      if (hovered === measurement) return false;
      hovered = measurement;
      applyPOIColors();
      return true;
    },
    setFovScale(scale) {
      if (poiFovScale === scale) return;
      poiFovScale = scale;
      const r = currentPoiRadius();
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois || data.pois.length === 0) continue;
        for (const poi of data.pois) poi.scale.setScalar(r);
      }
    },
    setVisualsVisible(visible) {
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const poi of data.pois) poi.visible = visible;
      }
    },
    layoutPoisOn(o, w, h) {
      const data = overlayData(o);
      if (!data.pois) return;
      for (const poi of data.pois) {
        const { u, v } = poiData(poi).uv;
        placePoi(poi, u, v, w, h);
      }
    },
    disposePoisOn(o) {
      const data = overlayData(o);
      if (!data.pois) return;
      for (const p of data.pois) {
        (p.material as THREE.Material).dispose();
      }
    },
    clearControlPointLinks(controlPointId) {
      for (const child of overlaysGroup.children) {
        const data = overlayData(child as THREE.Group);
        if (!data.pois) continue;
        for (const poi of data.pois) {
          const pd = poiData(poi);
          if (pd.controlPointId === controlPointId) pd.controlPointId = null;
        }
      }
    },
    clearSelectionForOverlay(o) {
      if (selected && poiData(selected).parentOverlay === o) {
        selected = null;
      }
      if (hovered && poiData(hovered).parentOverlay === o) {
        hovered = null;
      }
    },
    getSelectedControlPointId: selectedControlPointId,
  };
  return store;
}
