// Cartesian linear-algebra and angle primitives used across the frontend.
//
// Lat/lng-specific math (great-circle bearing, tangent-plane projection) lives
// in geo.ts; THREE.Vector*/Matrix4 helpers stay in their owning files. This
// module is the home for the small scalar/vector primitives that were
// otherwise inlined at many call sites.
//
// Functions take loose scalar args rather than typed point objects so call
// sites don't need to allocate a wrapper around two/three locals.

export const norm2 = (x: number, y: number): number => Math.hypot(x, y);

export const dist2 = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

export const norm3 = (x: number, y: number, z: number): number => Math.hypot(x, y, z);

export const dot3 = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number => ax * bx + ay * by + az * bz;

// Clamp v into [lo, hi]. The single source for the project — THREE.MathUtils
// has the same function, but using one helper everywhere keeps the convention
// uniform across files that don't otherwise need THREE.
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const degToRad = (deg: number): number => deg * (Math.PI / 180);
export const radToDeg = (rad: number): number => rad * (180 / Math.PI);

// Wrap radians into [0, 2π).
export const wrap2Pi = (a: number): number => {
  const r = a % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
};

// Wrap radians into (-π, π]. Useful for shortest-arc angle deltas.
export const wrapPi = (a: number): number => wrap2Pi(a + Math.PI) - Math.PI;
