// Translucent polygon meshes that visualize CP surfaces in the world view.
// Each surface is a triangle (3 CPs) or quad (4 CPs in cyclic order). The
// opacity is controlled by a single global slider — the materials are shared
// across all rendered surfaces so a slider drag is one mutation.
//
// Surfaces whose anchoring CPs lack an estimated 3D location are skipped
// (same rule used by cp-constraint-lines).

import * as THREE from 'three';
import type { ControlPointView, CPSurfaceView, LatLng } from './types.js';
import { controlPointVertex } from './camera-anchored.js';
import { subscribeCurvatureChange } from './curvature.js';
import { OVERLAY_RENDER_ORDER } from './dot-layer.js';

const SURFACE_COLOR = 0x33aaff;
const SURFACE_COLOR_SELECTED = 0xff8844;
export const DEFAULT_SURFACE_OPACITY = 0.35;

export interface CPSurfaces {
  update(
    camLoc: LatLng | null,
    cameraMSL: number,
    cps: readonly ControlPointView[],
    surfaces: readonly CPSurfaceView[],
    selectedId: string | null,
  ): void;
  // Hit-test in NDC space. Projects each drawn polygon and reports the first
  // one the cursor sits inside. Polygons are convex (3 or 4 verts in cyclic
  // order) so a single sign-of-cross test against each edge suffices.
  findHit(
    ndc: { x: number; y: number },
    camera: THREE.Camera,
  ): { surfaceId: string } | null;
  setOpacity(opacity: number): void;
  setVisible(visible: boolean): void;
}

export interface CreateCPSurfacesOptions {
  scene: THREE.Scene;
  requestRender: () => void;
}

interface DrawnSurface {
  readonly id: string;
  readonly vertices: readonly THREE.Vector3[]; // length 3 or 4
}

function makeMaterial(hex: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: hex,
    transparent: true,
    opacity: DEFAULT_SURFACE_OPACITY,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
}

export function createCPSurfaces(opts: CreateCPSurfacesOptions): CPSurfaces {
  const { scene, requestRender } = opts;

  const matDefault = makeMaterial(SURFACE_COLOR);
  const matSelected = makeMaterial(SURFACE_COLOR_SELECTED);

  const group = new THREE.Group();
  scene.add(group);

  let drawn: DrawnSurface[] = [];

  // Cached last-update args so a curvature toggle can rebuild without
  // waiting for the next data refresh from main.
  let lastCamLoc: LatLng | null = null;
  let lastCameraMSL = 0;
  let lastCps: readonly ControlPointView[] = [];
  let lastSurfaces: readonly CPSurfaceView[] = [];
  let lastSelectedId: string | null = null;

  function clearGroup(): void {
    for (const child of group.children) {
      if (child instanceof THREE.Mesh) {
        (child.geometry as THREE.BufferGeometry).dispose();
      }
    }
    group.clear();
  }

  function buildMesh(vertices: readonly THREE.Vector3[], mat: THREE.MeshBasicMaterial): THREE.Mesh {
    // Triangle: 1 triangle (3 verts). Quad: 2 triangles sharing edge 0-2
    // (verts a,b,c,d → triangles (a,b,c) and (a,c,d)).
    const positions: number[] = [];
    if (vertices.length === 3) {
      for (const v of vertices) positions.push(v.x, v.y, v.z);
    } else {
      const a = vertices[0]!, b = vertices[1]!, c = vertices[2]!, d = vertices[3]!;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geom, mat);
    // One below the line overlays so constraint lines and CP markers stay
    // readable on top of the fill.
    mesh.renderOrder = OVERLAY_RENDER_ORDER - 1;
    mesh.frustumCulled = false;
    return mesh;
  }

  function rebuild(): void {
    clearGroup();
    drawn = [];
    if (lastCamLoc === null) {
      requestRender();
      return;
    }
    const cpById = new Map<string, ControlPointView>(lastCps.map(cp => [cp.id, cp] as const));
    for (const sf of lastSurfaces) {
      const verts: THREE.Vector3[] = [];
      let abort = false;
      for (const cpId of sf.cpIds) {
        const cp = cpById.get(cpId);
        if (!cp) { abort = true; break; }
        const v = controlPointVertex(cp, lastCamLoc, lastCameraMSL);
        if (!v) { abort = true; break; }
        verts.push(v);
      }
      if (abort) continue;
      const mat = sf.id === lastSelectedId ? matSelected : matDefault;
      group.add(buildMesh(verts, mat));
      drawn.push({ id: sf.id, vertices: verts });
    }
    requestRender();
  }

  subscribeCurvatureChange(rebuild);

  // Convex-polygon point-in-poly in NDC. The polygon is convex because we
  // emit verts in cyclic order; sign-of-cross is constant for all edges when
  // the point is inside.
  function ndcContains(ndc: { x: number; y: number }, pts: readonly THREE.Vector3[]): boolean {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const cross = (b.x - a.x) * (ndc.y - a.y) - (b.y - a.y) * (ndc.x - a.x);
      if (cross === 0) continue;
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
    return true;
  }

  return {
    setVisible(visible) { group.visible = visible; },
    setOpacity(opacity) {
      matDefault.opacity = opacity;
      matSelected.opacity = opacity;
      requestRender();
    },
    update(camLoc, cameraMSL, cps, surfaces, selectedId) {
      if (camLoc === lastCamLoc && cameraMSL === lastCameraMSL
        && cps === lastCps && surfaces === lastSurfaces
        && selectedId === lastSelectedId) return;
      lastCamLoc = camLoc;
      lastCameraMSL = cameraMSL;
      lastCps = cps;
      lastSurfaces = surfaces;
      lastSelectedId = selectedId;
      rebuild();
    },
    findHit(ndc, camera) {
      // Walk in reverse render order so a surface drawn over another is
      // picked first. Skip surfaces with any vertex behind the near plane.
      for (let i = drawn.length - 1; i >= 0; i--) {
        const d = drawn[i]!;
        const projected = d.vertices.map(v => v.clone().project(camera));
        if (projected.some(p => p.z > 1)) continue;
        if (ndcContains(ndc, projected)) return { surfaceId: d.id };
      }
      return null;
    },
  };
}
