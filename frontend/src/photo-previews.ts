// World-space photo planes anchored to a far station, used to pre-position
// the destination's image panes during a fly tween so they're already in
// place by the time the camera lands. update() per frame slides each pane
// along with the moving camera so the planes appear glued to their owning
// station; at touchdown the anchor offset goes to zero and the pose
// matches the regular overlay-photos placement, so the handoff to the
// post-fly hydrate is visually continuous.

import * as THREE from 'three';
import * as api from './api.js';
import { latLngToCameraRelativeMeters } from './geo.js';
import {
  dirFromAzAlt, getPlaceholderTexture, placeAt, widthFromSizeRad,
} from './overlay-photos.js';
import type { LatLng } from './types.js';

export interface PhotoPreview {
  readonly photoId: string;
  readonly blobPath: string | null;
  readonly fromLat: number;
  readonly fromLng: number;
  readonly fromAlt: number;
  readonly photoAz: number;
  readonly photoTilt: number;
  readonly photoRoll: number;
  readonly sizeRad: number;
  readonly aspect: number;
}

export interface PhotoPreviews {
  // Replaces the active set; group becomes visible whenever there's at
  // least one item and the bake isn't currently suppressing it.
  set(previews: readonly PhotoPreview[]): void;
  update(camLoc: LatLng | null, cameraMSL: number): void;
  // Bake's setVisualsVisible(false) flips this on; setVisualsVisible(true)
  // flips it off, restoring effective visibility derived from item count.
  setBakeHidden(hidden: boolean): void;
  clear(): void;
}

export interface CreatePhotoPreviewsOptions {
  scene: THREE.Scene;
  requestRender: () => void;
  getAnisotropy: () => number;
}

interface PreviewItem {
  readonly preview: PhotoPreview;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly dir: THREE.Vector3;
  loadedTexture: THREE.Texture | null;
}

const PREVIEW_GEOM = new THREE.PlaneGeometry(1, 1);
const _anchorScratch = new THREE.Vector3();

export function createPhotoPreviews(opts: CreatePhotoPreviewsOptions): PhotoPreviews {
  const { scene, requestRender, getAnisotropy } = opts;
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  let items: PreviewItem[] = [];
  let bakeHidden = false;

  function applyVisibility(): void {
    const next = items.length > 0 && !bakeHidden;
    if (group.visible === next) return;
    group.visible = next;
    requestRender();
  }

  function buildItem(preview: PhotoPreview): PreviewItem {
    const w = widthFromSizeRad(preview.sizeRad);
    const material = new THREE.MeshBasicMaterial({
      map: getPlaceholderTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(PREVIEW_GEOM, material);
    mesh.scale.set(w, w / preview.aspect, 1);
    group.add(mesh);

    const item: PreviewItem = {
      preview, mesh, material,
      dir: dirFromAzAlt(preview.photoAz, preview.photoTilt),
      loadedTexture: null,
    };
    new THREE.TextureLoader().load(
      api.photoBlobUrl({ id: preview.photoId, blob_path: preview.blobPath }),
      tex => {
        // Mesh removed (clear() called before load resolved) — drop the texture.
        if (!mesh.parent) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = getAnisotropy();
        material.map = tex;
        material.needsUpdate = true;
        item.loadedTexture = tex;
        requestRender();
      },
      undefined,
      err => { console.warn(`photo preview ${preview.photoId} load failed:`, err); },
    );
    return item;
  }

  function disposeItem(item: PreviewItem): void {
    group.remove(item.mesh);
    if (item.loadedTexture) item.loadedTexture.dispose();
    item.material.dispose();
  }

  return {
    set(previews) {
      for (const item of items) disposeItem(item);
      items = previews.map(buildItem);
      applyVisibility();
    },
    update(camLoc, cameraMSL) {
      if (camLoc === null || items.length === 0) return;
      for (const item of items) {
        const offset = latLngToCameraRelativeMeters(
          { lat: item.preview.fromLat, lng: item.preview.fromLng }, camLoc,
        );
        _anchorScratch.set(offset.x, item.preview.fromAlt - cameraMSL, offset.z);
        placeAt(item.mesh, item.dir, item.preview.photoRoll, _anchorScratch);
      }
    },
    setBakeHidden(hidden) {
      if (bakeHidden === hidden) return;
      bakeHidden = hidden;
      applyVisibility();
    },
    clear() {
      for (const item of items) disposeItem(item);
      items = [];
      applyVisibility();
    },
  };
}
