// Build a square CanvasTexture from a 2D drawing callback. Sets sRGB color
// space so the texture renders identically to other sRGB inputs in the scene
// (photo overlays, terrain). Used for small UI icons (CP markers, photo
// drag/rotate/FOV handles) where a canvas is the most ergonomic source.
//
// Lives in its own module so types.ts can stay THREE-free at runtime —
// the CP page (cp.html) imports types.js for DOM helpers and must not
// transitively pull in THREE, which is only registered in the importmap
// on the panorama page.

import * as THREE from 'three';

export function makeCanvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
