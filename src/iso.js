// 2:1 isometric projection — must match tools/lib/render.mjs exactly.
//
//   screen.x = (x - y) * HW
//   screen.y = (x + y) * HH - z * ZPX        (y grows downward)
//
// The projection is parameterised because the game runs TWO scales: the outdoor
// world at 32x16 tiles (so a lot of it fits on screen) and interiors at 48x24
// (so a small room is actually readable). Switching is one call, and the asset
// sets are baked to match — see tools/build-assets.mjs.
//
// ---- why the state is an OBJECT and not five `let`s -------------------------
//
// These five numbers used to be `export let TILE_W/HH/ZPX`, mutated in place by
// setProjection(). That is a LIVE BINDING, and live bindings are exactly what a
// bundle built out of a module registry cannot give you: tools/build-single.mjs
// turns each module into a factory that RETURNS its exports
// (`return { HW, HH, ZPX, ... }`) and each importer into a destructure
// (`const { HW, HH, ZPX } = await __mod('src/iso.js')`). A destructure takes a
// COPY. So in the single-file build, main.js kept the OUTDOOR projection for
// ever: walking indoors ran the room at scale 1 while the sprites were drawn at
// scale 1.5.
//
// The symptom was not "the sprites are in the wrong place" — the draw side calls
// project(), which reads the module's own variables and was always right. The
// symptom was that the shader's INVERSE projection (the same formula, fed from
// u_iso) put every fragment 1.5x too far from the camera, so the interior
// transmittance volume, the indoor mask and the sun march were all sampled in
// the wrong place: sunlight flooded the room and the lit region read as a
// smaller, shifted box. Nothing in the dev server showed it, because real ESM
// imports are live.
//
// One mutable OBJECT is immune to that, in both worlds: the import copies the
// reference, and the fields are then read at use time. So: read `ISO.HW`, never
// a destructured copy of it.
export const ISO = {
  TILE_W: 32,
  TILE_H: 16,
  ZPX: 22,
  HW: 16,
  HH: 8,
};

/** switch to another pre-rendered scale (1 = world, 1.5 = interiors) */
export function setProjection(scale) {
  ISO.TILE_W = 32 * scale;
  ISO.TILE_H = 16 * scale;
  ISO.ZPX = 22 * scale;
  ISO.HW = ISO.TILE_W / 2;
  ISO.HH = ISO.TILE_H / 2;
}

/** screen position, y down, relative to the world origin */
export function project(x, y, z = 0) {
  return [(x - y) * ISO.HW, (x + y) * ISO.HH - z * ISO.ZPX];
}

/** inverse: which world (x, y) sits at this screen point for a known height */
export function unproject(sx, sy, z = 0) {
  const xmy = sx / ISO.HW;
  const xpy = (sy + z * ISO.ZPX) / ISO.HH;
  return [(xmy + xpy) / 2, (xpy - xmy) / 2];
}

/** pick the tile under a screen point, correcting for the topmost surface */
export function pickTile(sx, sy, heightAt) {
  // walk down from a generous height: the first surface whose world position
  // matches the projection is the one the user is pointing at
  let best = null;
  for (let z = 6; z >= -0.2; z -= 0.05) {
    const [x, y] = unproject(sx, sy, z);
    const gx = Math.floor(x), gy = Math.floor(y);
    const h = heightAt(gx, gy);
    if (z <= h + 0.06) { best = { gx, gy, z: h, x, y }; break; }
  }
  if (!best) { const [x, y] = unproject(sx, sy, 0); best = { gx: Math.floor(x), gy: Math.floor(y), z: 0, x, y }; }
  return best;
}

/**
 * Unit direction from a surface toward the camera (orthographic, constant).
 *
 * Scale-invariant on purpose: 2*HH/ZPX is 0.7273 at every scale the game uses
 * (2*8/22 outdoors, 2*12/33 indoors), so this may be computed once at load even
 * though the projection it is derived from is mutable.
 */
export const EYE = (() => {
  const v = [1, 1, (2 * ISO.HH) / ISO.ZPX];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
