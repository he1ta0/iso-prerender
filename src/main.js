// Game shell: boot, scenes, camera, day cycle, input, main loop.
//
// The game runs THREE scenes at TWO scales and swaps between them:
//
//   outdoor  64x64 tiles at 32x16 px 鈥?a wide valley, the farm, the woods
//   indoor   11x9 tiles at 48x24 px  鈥?the ground floor, close and detailed
//   upstairs 9x7 tiles at 48x24 px   鈥?the loft above it, same scale, own plan
//
// They are separate maps with separate atlases, so neither has to compromise for
// the other: the world keeps its composition (outside, the farmhouse is just a
// house), and each room gets the pixel budget it needs to be readable. Everything
// downstream 鈥?projection, atlas, height field, occupancy volume, camera 鈥?is
// swapped in one place, `enter()`.
//
// A STOREY IS A SCENE, not a second slab of geometry. That is the honest shape
// for this renderer: the cut-away, the focus volume and the light volume are all
// statements about ONE room read from ONE fixed camera, and stacking two rooms
// in one scene would mean every one of those had to learn about floors. Two
// scenes cost a `enter()` and nothing else 鈥?and each keeps its own GPU volume,
// so walking up the stairs cannot disturb the room you left (see makeVolume in
// src/gl/renderer.js).

import { loadAtlas } from './atlas.js';
import { Renderer, FLAG_WATER, FLAG_FOLIAGE } from './gl/renderer.js';
import { makeScene, makeAgents, stepAgent, collectLights } from './world.js';
import { makeInterior, INTERIOR_LIGHTS, WALL_H } from './interior.js';
import { makeUpperInterior } from './interior_upper.js';
import { makeChapelInterior } from './interior_chapel.js';
import { daylightAt, clockLabel } from './daylight.js';
// NOTE the projection numbers come from the ISO object and are read AT USE TIME
// (`ISO.HW`), never destructured into locals: the projection is switched to the
// 1.5x interior scale on the way through a door, and a destructured copy is a
// snapshot that a bundled build cannot update 鈥?see the note in iso.js.
import { project, unproject, pickTile, setProjection, EYE, ISO } from './iso.js';
import { HUD } from './ui.js';

// ---- internal render resolution. Everything is authored at this size and
// integer-scaled to the window, so pixels stay square and crisp.
const ZOOMS = [[640, 360, 'WIDE'], [480, 270, 'MID'], [320, 180, 'CLOSE']];
export const RES = [ZOOMS[0][0], ZOOMS[0][1]];
let zoomIdx = 0;
const DAY_SECONDS = 480;          // a full day at 1x

const canvas = document.getElementById('gl');
const uiCanvas = document.getElementById('ui');
canvas.width = RES[0]; canvas.height = RES[1];
uiCanvas.width = RES[0]; uiCanvas.height = RES[1];

// ---------------------------------------------------------------- boot
setProjection(1);
const [atlasWorld, atlasInt] = await Promise.all([
  loadAtlas('assets', 'outdoor'),
  loadAtlas('assets/int', 'interior'),
]);

const gl = canvas.getContext('webgl2', {
  alpha: false, antialias: false, depth: false, stencil: false,
  preserveDrawingBuffer: true, powerPreference: 'high-performance',
});
if (!gl) {
  document.body.innerHTML = '<div style="color:#e8e0d0;font:14px monospace;padding:24px">'
    + 'THIS GAME NEEDS WEBGL2.<br>Your browser or GPU did not provide a context.</div>';
  throw new Error('no webgl2');
}

const renderer = new Renderer(gl, { width: RES[0], height: RES[1], zScale: atlasWorld.zScale });
renderer.setAtlases(atlasWorld.images);
renderer.setStampImage(atlasWorld.images.stamp);

/**
 * Painter's-order key: the depth of the sprite's front-most geometry.
 *
 * This is now a FALLBACK, not the mechanism. Occlusion is resolved by a real
 * depth buffer (see SPRITE_FS), so nothing here decides who covers whom. What
 * the sort still buys is a deterministic back-to-front ordering 鈥?useful for
 * exact depth ties, where "last drawn wins" should mean "nearest drawn last" 鈥? * and a stable order for the blended cut-away layer.
 *
 * `bb` is the world-space XY bound baked alongside the sprite (build-assets),
 * expressed in the sprite's own tile frame, so world front corner = gx+bb[2],
 * gy+bb[3]. Falls back to the footprint for anything without bounds.
 */
function frontDepth(sp, gx, gy) {
  const bb = sp.bb;
  if (!bb) return gx + sp.fp[0] / 2 + gy + sp.fp[1] / 2;
  return (gx + bb[2]) + (gy + bb[3]);
}
const SORT_UNDER = -1e4;    // floor decals: always painted first
const SORT_OVER = 1e4;      // ceiling-hung pieces: always painted last

/**
 * Tie-break margins for the scene's explicit stacking statements, in depth
 * units 鈥?and they are deliberately BOTH FORWARD (positive).
 *
 * `under` / `over` used to be sort keys with the values 卤1e4: "paint this first
 * / last, regardless". With a depth buffer there is no first or last to control,
 * so what is left is a hundredth of a tile of margin and a draw-order nudge.
 *
 * The reason neither is negative is worth stating, because "-0.01 for `under`"
 * is the obvious thing to write and it is a trap: a floor decal that is exactly
 * coplanar with the floor has a depth difference of zero, so a negative margin
 * would hand the win to the FLOOR and the rug would vanish. A rug lying on
 * boards should win against the boards 鈥?that is what "on" means 鈥?and lose to
 * the table standing on it, which it does by a whole 0.9 units of geometry
 * rather than by any margin.
 */
const TIE_UNDER = 0.01;
const TIE_OVER = 0.01;

/**
 * Flatten a scene into a painter-ordered draw list and its occupancy volume.
 *
 * Flat ground is always behind everything so it goes first wholesale. Everything
 * standing on it is sorted by the depth of its **front-most geometry**, not of
 * its footprint centre.
 *
 * The centre is the obvious key and it is wrong for anything bigger than a tile.
 * A bed occupies two tiles of depth; half of it is nearer the camera than its
 * centre claims, so the wall tile beside its foot sorted in FRONT of the bed and
 * painted over it 鈥?the bed looked like it had been cut in half by the wall. The
 * bounds baked into the manifest (see build-assets) give the real front corner,
 * which is the correct key for an isometric painter's algorithm.
 */
function prepare(atlas, scene, { volume = false, pad = 0.6, zTop = 4.35 } = {}) {
  const groundList = [];
  const objList = [];
  for (let y = 0; y < scene.h; y++) {
    for (let x = 0; x < scene.w; x++) {
      const id = scene.ground[y * scene.w + x];
      if (!id) continue;
      const sp = atlas.get(id);
      if (!sp) continue;
      groundList.push({
        sp, gx: x, gy: y, depth: x + y, flags: sp.cat === 'water' ? FLAG_WATER : 0,
        bias: renderer.categoryBias(sp.cat),
      });
    }
  }
  for (const o of scene.objects) {
    const sid = atlas.spriteId(o.id, o.rot);
    const sp = sid && atlas.get(sid);
    if (!sp) continue;
    const flags = sp.cat === 'water' ? FLAG_WATER
      : (sp.cat === 'tree' || sp.cat === 'crop') ? FLAG_FOLIAGE : 0;
    // The scene's explicit stacking statements become a small forward margin
    // plus a draw-order nudge (see TIE_UNDER / TIE_OVER), and a piece that
    // stands on another carries a real world-space `lift`.
    const tie = o.sort > 0 ? TIE_OVER : (o.sort < 0 ? TIE_UNDER : 0);
    objList.push({
      sp, gx: o.gx, gy: o.gy, depth: frontDepth(sp, o.gx, o.gy) + (o.sort || 0),
      flags, id: sid, lift: o.lift || 0,
      role: sp.role || null,
      // Two independent reasons a piece may have to get out of the camera's way,
      // and they are not the same thing:
      //
      //   declared  the SCENE says so 鈥?the two wall runs the camera stands
      //             outside of, and whatever hangs on them. Static, exact, and
      //             it cannot fail at runtime.
      //   auto      the manifest's category says the piece MAY be cut, and
      //             something the camera cares about is behind it this frame.
      //             That is the outdoor case, and it is decided per frame.
      declared: o.cut ? 1 : 0,
      auto: sp.cut ? 1 : 0,
      bias: renderer.categoryBias(sp.cat) + tie,
    });
  }
  objList.sort((a, b) => a.depth - b.depth);

  const out = { atlas, scene, groundList, objList, marks: scene.marks || null, volume: null, height: null };

  // height field (outdoors only 鈥?an interior is lit by its volume)
  const place = objList.map((o) => ({ sprite: o.sp, gx: o.gx, gy: o.gy }));
  if (place.length && atlas.ppc) out.height = renderer.buildHeightmap(scene.w, scene.h, place, atlas.ppc);

  if (volume) {
    const b = scene.bounds;
    // volumeSet is what enter() re-binds (textures and all); volume is its
    // summary 鈥?the numbers the boot log prints and worldAt's inside test reads.
    const vol = renderer.buildVolume({ min: b.min, max: b.max }, out.marks || []);
    out.volumeSet = vol;
    out.volume = vol.summary;
  }
  return out;
}

// ---------------------------------------------------------------- scenes
const worldAtlas = atlasWorld;
const scene = makeScene(worldAtlas);
const OUT = prepare(worldAtlas, scene, { volume: false });
OUT.agents = makeAgents(scene);

setProjection(atlasInt.m.scale || 1.5);
renderer.setAtlases(atlasInt.images);
const room = makeInterior(atlasInt);
const roomUp = makeUpperInterior(atlasInt);
const chapel = makeChapelInterior(atlasInt);
const IN = room ? prepare(atlasInt, room, { volume: true }) : null;
const UP = roomUp ? prepare(atlasInt, roomUp, { volume: true }) : null;
const CHAP = chapel ? prepare(atlasInt, chapel, { volume: true }) : null;
/**
 * The flats. Every storey wants the same three things, and none of them is
 * obvious enough to be worth writing twice:
 *
 *   * a FLAT height field. An interior is lit by its volume, not by an outdoor
 *     height field 鈥?but the field is also how a moving character casts a
 *     contact shadow, and indoors that is the ONLY shadow a villager has (the
 *     volume holds architecture, never furniture or people).
 *   * its own occupancy volume, built here and made current by enter().
 *   * villagers. Nobody walks a route upstairs: the loft has one lane and a
 *     stairwell to fall down, so its villager stands and looks out of the
 *     window 鈥?which is also the cheapest proof that a new interior does not
 *     need agents, routes or doors to be a scene. The chapel follows the same
 *     reasoning: one figure, walking the aisle the plan leaves open.
 */
const flats = [
  {
    mode: 'indoor', room, set: IN,
    agents: room ? [{
      name: 'MOSS', x: room.w / 2 + 0.5, y: room.h / 2 + 0.5, dir: 0, action: 'idle', frame: 0, ft: 0,
      speed: 0, pause: 0.8, actTimer: 1.0, actCycle: ['idle', 'harvest', 'idle'], actAt: 0, wp: 0,
      // an L-shaped beat through the two lanes the furniture plan leaves open
      route: [[4.5, 2.5], [2.5, 2.5], [2.5, 5.5], [6.5, 6.5], [6.5, 2.5]],
    }, {
      name: 'PIP', x: 3.5, y: 6.0, dir: 3, action: 'idle', frame: 0, ft: 0,
      speed: 0, pause: 1.4, actTimer: 2.0, actCycle: ['idle', 'water'], actAt: 0, wp: 0, route: null,
    }] : [],
  },
  {
    mode: 'upstairs', room: roomUp, set: UP,
    agents: roomUp ? [{
      name: 'TILDA', x: 4.5, y: 5.5, dir: 2, action: 'idle', frame: 0, ft: 0,
      speed: 0, pause: 1.1, actTimer: 1.6, actCycle: ['idle', 'harvest', 'idle'], actAt: 0, wp: 0, route: null,
    }] : [],
  },
  {
    // The chapel gets a route rather than a pose, because unlike the loft it has
    // a lane worth walking: the centre aisle, from the west door to the chancel
    // step. The waypoints are the four corners of the aisle the pews leave open
    // (x = 7, rows 2..9), which is also the cheapest possible check that the
    // plan's circulation is real 鈥?a villager that walks it cannot clip a pew.
    mode: 'chapel', room: chapel, set: CHAP,
    agents: chapel ? [{
      name: 'WREN', x: 7.5, y: 8.5, dir: 0, action: 'idle', frame: 0, ft: 0,
      speed: 0.55, pause: 1.2, actTimer: 1.2, actCycle: ['idle', 'water', 'idle'], actAt: 0, wp: 0,
      route: [[7.5, 8.5], [7.5, 3.5], [7.5, 9.2]],
    }] : [],
  },
];
for (const f of flats) {
  if (!f.set) continue;
  f.set.height = renderer.buildHeightmap(f.room.w, f.room.h, [], 20, { install: false });
  f.set.agents = f.agents;
  const v = f.set.volume;
  console.log(`${f.mode}: ${f.room.w}x${f.room.h} tiles at ${atlasInt.m.tile.w}x${atlasInt.m.tile.h} px, `
    + `volume ${v.dim.join('x')} (${(v.voxels / 1000).toFixed(0)}k voxels, `
    + `${v.solidVox} solid, ${v.glassVox} glass), ${(f.room.marks || []).length} marks`);
}
console.log(`world: ${scene.w}x${scene.h}, ${OUT.groundList.length} ground + ${OUT.objList.length} objects, `
  + `heightmap ${OUT.height ? `${OUT.height.W}x${OUT.height.H}` : 'n/a'}`);

// Building the interiors left the interior projection, atlas and ONE OF THEIR
// volumes bound. Put the world back 鈥?the very first frame is an outdoor one,
// and if these are not restored the world renders with the wrong sprites and the
// wrong pixel grid. enter() re-binds the right volume on the way in.
setProjection(1);
renderer.setAtlases(worldAtlas.images);
renderer.setStampImage(worldAtlas.images.stamp);
renderer.activateHeight(OUT.height);
renderer.useVolume(null);

// ---------------------------------------------------------------- mode
let mode = 'outdoor';
let lightDebug = 0;                // see LIGHT_FS: 1 = the sun-occlusion term
let shaftAmountOverride = null;    // QA override for the air glow; see game.shaftAmount
let shaftJitterOverride = null;    // QA override for the shaft de-banding noise
// EXPERIMENT knobs (see game.fogBlur / game.shadowTaps). window.__EXP__ sets the
// starting values; an experimental build injects it, the normal build does not.
const EXP = (typeof window !== "undefined" && window.__EXP__) || {};
let fogBlurOverride = EXP.fogBlur ?? 1;
let shadowTapsOverride = EXP.shadowTaps ?? 3;
let shadowSoftOverride = EXP.shadowSoft ?? null;
let S = OUT;                       // the active scene set
const camWorld = { x: scene.w / 2 - 1, y: scene.h / 2 + 5 };
// NB: an interior reports its depth as `h`, matching the map convention used
// everywhere else (w = x extent, h = y extent). Reaching for `room.d` yields
// undefined, which turns the camera into NaN and projects the whole scene to
// infinity 鈥?the screen just goes black with no error anywhere.
const camRoom = { x: room ? room.w / 2 : 5.5, y: room ? room.h / 2 : 4.5 };
const camUp = { x: roomUp ? roomUp.w / 2 : 4.5, y: roomUp ? roomUp.h / 2 : 3.5 };
// The chapel is 15x11 and its floor alone is 312 px tall on screen at the WIDE
// resolution, so the camera cannot hold all of it and the wall tops at once. It
// is framed one tile forward of the room's centre, which is the only band that
// works out: the floor's own diagonal needs the camera within a whisker of
// (7.5, 5.5) to fit horizontally, and one unit forward of that is what brings
// the top of the far wall 鈥?the rose window over the altar 鈥?down inside the
// canvas. The player can pan (clampCam gives a 15x11 room four units of travel
// instead of the cottage's two); this is only where it starts.
const camChapel = { x: chapel ? chapel.w / 2 : 7.5, y: chapel ? chapel.h / 2 - 1 : 4.5 };
let cam = camWorld;
let camPx = [0, 0];
const zoom = { scale: 3 };
const fade = { t: 0, dir: 0, to: null, hold: 0 };   // scene transition

/**
 * Every scene, by name. `enter` is a lookup and five swap calls 鈥?that is the
 * whole cost of a storey, because everything scene-specific (projection, atlas,
 * height field, occupancy volume, camera) is already swapped here and nothing
 * else in the frame loop knows which map it is drawing.
 */
const SCENES = {
  outdoor: { set: OUT, cam: camWorld },
  indoor: { set: IN, cam: camRoom },
  upstairs: { set: UP, cam: camUp },
  chapel: { set: CHAP, cam: camChapel },
};
/** the interiors, in the order the floor key walks them */
const STOREYS = ['indoor', 'upstairs', 'chapel'];

function enter(next) {
  if (next === mode) return;
  const to = SCENES[next];
  if (!to || !to.set) return;
  mode = next;
  S = to.set;
  cam = to.cam;
  setProjection(S.atlas.m.scale || 1);
  renderer.setAtlases(S.atlas.images);
  renderer.activateHeight(S.height);
  if (S.atlas.m.atlas.stamp) renderer.setStampImage(S.atlas.images.stamp);
  // One volume per storey, made current here. Nothing is rebuilt: walking
  // downstairs again must not re-rasterise 900k voxels, and must not touch the
  // volume the floor above is standing on.
  renderer.useVolume(S.volumeSet || null);
  updateCamPx();
}

/** the flat you are in, or null outdoors */
const storey = () => (mode === 'outdoor' ? null : mode);

/**
 * Step through the floors. Outdoors this is the way in (a front door is a door
 * whichever key opens it); indoors it alternates ground floor and loft.
 */
function cycleStorey() {
  if (mode === 'outdoor') { enter('indoor'); return; }
  const i = STOREYS.indexOf(mode);
  enter(STOREYS[(i + 1) % STOREYS.length]);
}

/** the tile that puts you in front of / inside a door */
function onDoorTile(a) {
  if (mode === 'outdoor' && scene.house) {
    const d = scene.house.door;
    return Math.abs(a.x - (d[0] + 0.5)) < 0.7 && Math.abs(a.y - (d[1] + 0.5)) < 0.7;
  }
  if (mode !== 'outdoor') {
    const r = SCENES[mode].set.scene;
    const d = r.door;
    return !!d && Math.abs(a.x - (d[0] + 0.5)) < 0.7 && Math.abs(a.y - (d[1] + 0.5)) < 0.7;
  }
  return false;
}

// ---------------------------------------------------------------- camera
function camMargin() { return (RES[0] / 2 / ISO.HW + RES[1] / 2 / ISO.HH) / 2 + 1; }
function clampCam() {
  if (mode !== 'outdoor') {
    // A room is usually smaller than the view, so the camera stays near the
    // middle and only nudges a little: enough to inspect a corner, never enough
    // to slide the room off screen.
    //
    // The chapel is the first room that is BIGGER than the view 鈥?15x11 at 24 px
    // per tile is 624 px wide against a 640 px canvas, and 4.2 units of wall on
    // top of it 鈥?and a flat 卤2 nudge left two thirds of it permanently out of
    // reach. The allowance therefore grows with the room: the cottage keeps the
    // nudge it has always had, and a room that is 4 tiles wider gets 2 units more
    // travel per axis. Anything simpler (pinning big rooms to the centre, or
    // letting the camera roam the whole floor) either hides the chancel or lets
    // the player lose the room entirely.
    const r = S.scene;                     // the ACTIVE room, not the ground floor
    const limX = 2.0 + Math.max(0, r.w - 11) * 0.5;
    const limY = 2.0 + Math.max(0, r.h - 9) * 0.5;
    cam.x = Math.max(r.w / 2 - limX, Math.min(r.w / 2 + limX, cam.x));
    cam.y = Math.max(r.h / 2 - limY, Math.min(r.h / 2 + limY, cam.y));
    return;
  }
  const mx = Math.min(camMargin(), S.scene.w / 2);
  const my = Math.min(camMargin(), S.scene.h / 2);
  cam.x = Math.max(mx, Math.min(S.scene.w - mx, cam.x));
  cam.y = Math.max(my, Math.min(S.scene.h - my, cam.y));
}

function updateCamPx() {
  clampCam();
  const p = project(cam.x, cam.y, 0);
  camPx = [RES[0] / 2 - p[0], RES[1] / 2 - p[1]];
}

// ---------------------------------------------------------------- scaling
function applyZoom() {
  const [w, h] = ZOOMS[zoomIdx];
  RES[0] = w; RES[1] = h;
  canvas.width = w; canvas.height = h;
  uiCanvas.width = w; uiCanvas.height = h;
  renderer.setSize(w, h);
  hud.setSize(w, h);
  fit(); updateCamPx();
}

function fit() {
  const s = Math.max(1, Math.min(
    Math.floor(window.innerWidth / RES[0]),
    Math.floor(window.innerHeight / RES[1]),
  ));
  zoom.scale = s;
  for (const c of [canvas, uiCanvas]) {
    c.style.width = `${RES[0] * s}px`;
    c.style.height = `${RES[1] * s}px`;
  }
  const wrap = document.getElementById('wrap');
  wrap.style.width = `${RES[0] * s}px`;
  wrap.style.height = `${RES[1] * s}px`;
  wrap.style.left = `${Math.floor((window.innerWidth - RES[0] * s) / 2)}px`;
  wrap.style.top = `${Math.floor((window.innerHeight - RES[1] * s) / 2)}px`;
}
window.addEventListener('resize', fit);

// ---------------------------------------------------------------- state
const state = {
  time: 0.34,
  paused: false,
  speed: 1,
  hud: {
    weather: 'CLEAR', weatherMix: 0,
    showHelp: true, showStats: false,
  },
  /**
   * Pieces the player has switched OFF, by role.
   *
   * Roles are baked per sprite (see ROLE_BY_ID in tools/build-assets.mjs) and
   * are deliberately about what a thing IS rather than how it renders, because
   * that is the vocabulary a switch wants: "the windows in the walls" and "the
   * table lamp" are things a person points at, and neither of them is a
   * category 鈥?a window and a wall are both `wall`, a lamp and a table are both
   * `furn`.
   *
   * NOTE this is a per-CLASS switch, not the cut-away switch. `hide.window`
   * takes the windows out of all four walls including the two you are looking
   * across; what you usually want for an unobstructed view of a room is
   * `cutaway`, below. This one is for "show me the room with the apertures
   * closed" and "show me the room without the thing doing all the lighting".
   */
  hide: {
    window: false, door: false, wall: false, roof: false,
    curtain: false, hang: false, lamp: false,
  },

  /**
   * What to do with the wall runs the camera stands outside of.
   *
   *   'ghost'  default 鈥?fade to 24 % with a hairline edge. You can see the
   *            room through them and still read where the walls are.
   *   'hide'   do not draw them at all 鈥?the near walls, the windows and doors
   *            in them, and the curtains and pictures hung on them. An open
   *            doll's-house view of the room, with nothing between you and it.
   *   'off'    draw everything solid. The walls are walls again.
   *
   * This is about the CAMERA and nothing else. The near walls still stand in the
   * interior transmittance volume, so the sun still cannot get through them, the
   * window apertures still shape the patches on the floor to the exact shape of
   * the hole they came through, and hiding a wall from your eye does not open it
   * to the sun.
   *
   * ONE EXCEPTION, and it is a live one: the air-glow scale below is chosen FROM
   * this switch (`shaftAmount`, 0.28 ghost / 0.18 hide路off), so switching modes
   * does change the light in the strip the walls were covering 鈥?17 % of those
   * pixels move by ~15 levels. That is the only place in the renderer where a
   * camera decision reaches the lighting, it contradicts the paragraph above, and
   * it is why two frames taken across this switch are NOT directly comparable
   * unless `game.shaftAmount` is pinned. See README 搂1 and 搂13.
   */
  cutaway: 'ghost',
};

/**
 * Contact-shadow stamp for a moving character.
 *
 * A character is 1.25 units tall, so a "faithful" height stamp is a tall narrow
 * spike 鈥?and a spike marched by a height field at a low sun smears into a long
 * dissolving streak, which is exactly what it looked like. A wide, low dome
 * instead reads as the contact darkening under the feet, can never come apart,
 * and is what a 27 px sprite actually wants.
 */
const AGENT_SHADOW = { r: 0.40, h: 0.30 };

// ---
// ---- the cutaway -----------------------------------------------------------
//
// One rule, and it is a rule about the CAMERA: a sprite that stands between the
// viewer and what they are looking at is ghosted. Nothing else changes. It keeps
// both its geometry and its place in the world, so the sun, the shadow march and
// the interior transmittance volume all still see a solid wall standing exactly
// where it was. That separation is the whole point 鈥?the previous version let one
// flag mean both "remove from the picture" and "remove from the world", which is
// why dawn light came through solid walls and why the room had to be built with
// a missing roof and a knee-high front wall to be visible at all.
//
// WHO is occluded is no longer decided here at all. This function publishes the
// FOCUS 鈥?the volumes the camera must be able to see through 鈥?and the depth
// buffer decides the rest, per pixel, in SPRITE_FS. That is the upgrade: the old
// version tested screen RECTANGLES on the CPU, so a building whose bounding box
// merely overlapped a villager's faded whole, and a wall standing half in front
// of the room and half behind it had to be classified as one or the other.
//
// The focus is deliberately cheap to state and generous in spirit:
//
//   outdoor  every villager (a box as tall as they are, not a flat tile) plus
//            the plot under the cursor
//   indoor   the room's INTERIOR VOLUME, not its floor 鈥?see the note at the
//            call site, because a floor slab is the natural answer and it is
//            wrong in a way that only shows up on the back wall
//
// Empty focus pixels are cleared to the far end of the depth range, so a box
// that covers nothing ghosts nothing: a villager out in the open makes no
// building fade, and a building nobody is behind stays solid.
const CUT_ALPHA = { indoor: 0.24, outdoor: 0.28 };

/** world-space boxes the camera must be able to see through, rebuilt each frame */
const focusBoxes = [];
function addFocus(x, y, r, z0 = -0.2, z1 = 1.3) {
  focusBoxes.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r, z0, z1 });
}
function addFocusBox(x0, y0, x1, y1, z0, z1) {
  focusBoxes.push({ x0, y0, x1, y1, z0, z1 });
}
/** QA switch: publish no focus at all, so nothing can be ghosted */
let focusOff = false;

/**
 * How far inside the walls the room's focus volume starts, in tiles.
 *
 * It has to clear the wall bodies: a focus box whose own face is coplanar with
 * the inside of the far wall would report that wall as being in the way of the
 * box's face at one-pixel scale, and the backdrop would flicker. The walls are
 * ~0.2 thick, so 0.3 is comfortably inside the room and comfortably outside the
 * wall's inner surface.
 */
const WALL_R = 0.3;

// ---------------------------------------------------------------- input
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  switch (e.code) {
    case 'Space': state.paused = !state.paused; e.preventDefault(); break;
    case 'Digit1': state.time = 0.27; break;
    case 'Digit2': state.time = 0.50; break;
    case 'Digit3': state.time = 0.74; break;
    case 'Digit4': state.time = 0.80; break;
    case 'Digit5': state.time = 0.94; break;
    case 'Digit6': state.time = 0.32; break;
    case 'Digit7': state.time = 0.38; break;
    case 'Digit8': state.time = 0.66; break;
    case 'BracketLeft': state.time -= 0.005; break;
    case 'BracketRight': state.time += 0.005; break;
    case 'KeyZ': zoomIdx = (zoomIdx + 1) % ZOOMS.length; applyZoom(); break;
    case 'KeyE': enter(mode === 'outdoor' ? 'indoor' : 'outdoor'); break;
    // U walks the floors: outdoors it is the front door, indoors it is the
    // stairs. PageUp/PageDown do the same thing for anyone who expects them.
    case 'KeyU': case 'PageUp': case 'PageDown': cycleStorey(); e.preventDefault(); break;
    case 'KeyH': state.hud.showHelp = !state.hud.showHelp; break;
    case 'KeyG': state.hud.showStats = !state.hud.showStats; break;
    case 'KeyR': state.hud.weather = state.hud.weather === 'CLEAR' ? 'RAIN' : 'CLEAR'; break;
    case 'KeyF': state.hud.weather = state.hud.weather === 'CLEAR' ? 'FOG' : 'CLEAR'; break;
    case 'Equal': state.speed = Math.min(8, state.speed * 2); break;
    case 'Minus': state.speed = Math.max(0.25, state.speed / 2); break;
    // hide switches 鈥?what a thing IS, not how it renders (see state.hide)
    case 'KeyL': state.hide.lamp = !state.hide.lamp; break;
    case 'KeyN': state.hide.window = !state.hide.window; break;
    case 'KeyM': state.hide.curtain = !state.hide.curtain; break;
    case 'KeyJ': state.hide.hang = !state.hide.hang; break;
    // K cycles how the camera-side walls are treated: fade / remove / solid
    case 'KeyK': {
      const order = ['ghost', 'hide', 'off'];
      state.cutaway = order[(order.indexOf(state.cutaway) + 1) % order.length];
      break;
    }
    default: break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let dragging = false, lastMouse = [0, 0];
const hover = { gx: -1, gy: -1, ok: false };

function toInternal(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / zoom.scale, (e.clientY - r.top) / zoom.scale];
}
uiCanvas.addEventListener('mousedown', (e) => { dragging = true; lastMouse = toInternal(e); uiCanvas.style.cursor = 'grabbing'; });
window.addEventListener('mouseup', () => { dragging = false; uiCanvas.style.cursor = 'default'; });
window.addEventListener('mousemove', (e) => {
  const [mx, my] = toInternal(e);
  if (dragging) {
    const dx = mx - lastMouse[0], dy = my - lastMouse[1];
    const wx = (dx / ISO.HW + dy / ISO.HH) / 2;
    const wy = (dy / ISO.HH - dx / ISO.HW) / 2;
    cam.x -= wx; cam.y -= wy;
    lastMouse = [mx, my];
  } else {
    const rel = [mx - camPx[0], my - camPx[1]];
    const t = pickTile(rel[0], rel[1], (gx, gy) => heightAt(gx, gy));
    hover.gx = t.gx; hover.gy = t.gy;
    hover.ok = t.gx >= 0 && t.gy >= 0 && t.gx < S.scene.w && t.gy < S.scene.h;
  }
});
uiCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.time += e.deltaY * 0.0004;
}, { passive: false });

const heightGrid = new Float32Array(scene.w * scene.h);
for (const o of OUT.objList) {
  const h = o.sp.cap ?? 0.2;
  const [fw, fd] = o.sp.fp;
  for (let y = o.gy; y < o.gy + fd; y++) {
    for (let x = o.gx; x < o.gx + fw; x++) {
      if (x < 0 || y < 0 || x >= scene.w || y >= scene.h) continue;
      const i = y * scene.w + x;
      if (h > heightGrid[i]) heightGrid[i] = h;
    }
  }
}
function heightAt(gx, gy) {
  if (mode !== 'outdoor') return 0;
  if (gx < 0 || gy < 0 || gx >= scene.w || gy >= scene.h) return 0;
  return heightGrid[gy * scene.w + gx];
}

const hud = new HUD(uiCanvas, RES[0], RES[1]);

// ---------------------------------------------------------------- loop
let last = performance.now();
let clockT = 0;
const drawList = [];
const ghostList = [];
const agentDraw = [];
let ghostIds = [];
let lastLights = 0;
let lastPortals = 0;
let shaftTick = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  clockT += dt;

  if (!state.paused) state.time += (dt / DAY_SECONDS) * state.speed;
  state.time = ((state.time % 1) + 1) % 1;

  // ---- keyboard camera
  const sp = 9 * dt * (keys.has('ShiftLeft') ? 2.5 : 1);
  if (keys.has('KeyW') || keys.has('ArrowUp')) { cam.x -= sp; cam.y -= sp; }
  if (keys.has('KeyS') || keys.has('ArrowDown')) { cam.x += sp; cam.y += sp; }
  if (keys.has('KeyA') || keys.has('ArrowLeft')) { cam.x -= sp; cam.y += sp; }
  if (keys.has('KeyD') || keys.has('ArrowRight')) { cam.x += sp; cam.y -= sp; }
  updateCamPx();

  // ---- transition
  if (fade.dir !== 0) {
    fade.t += dt * fade.dir * 3.4;
    if (fade.dir > 0 && fade.t >= 1) { fade.t = 1; enter(fade.to); fade.dir = -1; }
    else if (fade.dir < 0 && fade.t <= 0) { fade.t = 0; fade.dir = 0; }
  }

  // ---- weather
  const target = state.hud.weather === 'CLEAR' ? 0 : state.hud.weather === 'RAIN' ? 1 : 0.55;
  state.hud.weatherMix += (target - state.hud.weatherMix) * Math.min(1, dt * 0.8);

  const dl = daylightAt(state.time);
  const rain = state.hud.weather === 'RAIN' ? state.hud.weatherMix : 0;
  const fogW = state.hud.weather === 'FOG' ? state.hud.weatherMix : 0;

  // ---- characters. Walking onto a doorway moves you between the two maps.
  if (agentDraw.length !== S.agents.length) {
    agentDraw.length = 0;
    for (let i = 0; i < S.agents.length; i++) {
      agentDraw.push({ sp: null, gx: 0, gy: 0, depth: 0, flags: 0, bias: renderer.categoryBias('char') });
    }
  }
  const blobs = [];
  let wantsDoor = null;
  for (let i = 0; i < S.agents.length; i++) {
    const a = S.agents[i];
    stepAgent(a, dt, 0);
    if (a.name === 'WREN' && onDoorTile(a) && fade.dir === 0) wantsDoor = mode === 'outdoor' ? 'indoor' : 'outdoor';
    const probe = S.atlas.get(`char_${a.action}_00#${a.dir}`) || S.atlas.get('char_idle_00#0');
    const fps = probe?.fps || 8;
    const frames = probe?.frames || 1;
    const f = frames > 1 ? Math.floor(a.ft * fps) % frames : 0;
    const sp2 = S.atlas.get(`char_${a.action}_${String(f).padStart(2, '0')}#${a.dir}`) || probe;
    const d = agentDraw[i];
    d.sp = sp2; d.gx = a.x - (sp2 ? sp2.fp[0] / 2 : 0.5); d.gy = a.y - (sp2 ? sp2.fp[1] / 2 : 0.5);
    d.depth = sp2 ? frontDepth(sp2, d.gx, d.gy) : a.x + a.y;
    d.flags = 0;
    blobs.push({ x: a.x, y: a.y, r: AGENT_SHADOW.r, h: AGENT_SHADOW.h });
  }
  if (wantsDoor) { fade.dir = 1; fade.to = wantsDoor; }
  renderer.stampDynamic(blobs);

  // ---- lights
  const sky = {
    sunDir: dl.sunDir, skyColor: dl.skyColor, sunColor: dl.sunColor,
    sunGain: dl.sunGain, ambGain: dl.ambGain,
  };
  const lights = mode !== 'outdoor'
    ? collectLights(S.scene, dl.nightFactor, clockT, sky, INTERIOR_LIGHTS)
    : collectLights(S.scene, dl.nightFactor, clockT, sky);
  lastLights = lights.length;
  lastPortals = 0;
  for (const l of lights) if (l.kind === 'portal') lastPortals++;

  // ---- instances
  //
  // Two lists, not one: everything opaque goes into the main G-buffer, and the
  // handful of ghosted occluders go into the transparent layer. Painter order is
  // preserved inside each list, which is all that is needed 鈥?a ghost wall is by
  // definition nearer the camera than whatever it is standing in front of.
  drawList.length = 0;
  ghostList.length = 0;
  focusBoxes.length = 0;
  const pushSprite = (sp, gx, gy, flags, alpha, id, bias = 0, lift = 0) => {
    // `lift` is the piece's real height above its tile: the screen origin moves
    // up by lift*ZPX and the height range moves with it, so the sprite, its
    // depth and the light it catches all agree about where the piece is.
    const p = project(gx + sp.fp[0] / 2, gy + sp.fp[1] / 2, lift);
    const ox = p[0] - sp.ax, oy = p[1] - sp.ay;
    if (ox + camPx[0] + sp.w < -8 || oy + camPx[1] + sp.h < -8) return;
    if (ox + camPx[0] > RES[0] + 8 || oy + camPx[1] > RES[1] + 8) return;
    const a = sp.a;
    const item = {
      id: id || '',
      org: [ox, oy], size: [sp.w, sp.h],
      uv: [a[0] / S.atlas.size[0], a[1] / S.atlas.size[1]],
      uvSize: [a[2] / S.atlas.size[0], a[3] / S.atlas.size[1]],
      z: [sp.z0 + lift, sp.z1 + lift], flags, alpha, bias,
    };
    (alpha < 0.999 ? ghostList : drawList).push(item);
    return item;
  };

  // ---- what the camera must be able to see --------------------------------
  //
  // OUTDOORS the focus is what somebody is standing behind: a villager, or the
  // plot under the cursor. It is published as world-space boxes and rasterised
  // into a depth image so the fade can follow a silhouette instead of a
  // bounding rectangle.
  //
  // INDOORS there is no focus at all, and that is deliberate. The cut-away
  // there is a DECLARED property of the room 鈥?the two wall runs the camera
  // stands outside of are marked `cut` where the room is laid out 鈥?so it needs
  // no image, no per-frame decision, and nothing that can come back empty. The
  // shader sees no focus, takes the whole-piece branch, and the walls fade
  // exactly as they always did. That path cannot fail.
  if (!focusOff && mode === 'outdoor') {
    // Villagers who are inside a building are not look-at targets: outdoors they
    // are behind a solid wall anyway, and letting them drive the cutaway left the
    // farmhouse permanently ghosted 鈥?the one building you actually want to see.
    for (const a of S.agents) if (!a.indoor) addFocus(a.x, a.y, 0.85, -0.2, 1.25);
    if (hover.ok) addFocus(hover.gx + 0.5, hover.gy + 0.5, 0.7, -0.2, 0.06);
  }
  renderer.setFocus(focusBoxes);

  // The CPU-side prefilter: an `auto` piece is only a candidate if its screen
  // rectangle overlaps a focus box's. This is the cheap half of the test that
  // decides what goes into the cut-away layer at all; the shader then decides
  // which of its PIXELS actually fade. Without it every building on the map
  // would be a candidate every frame.
  const focusRects = focusBoxes.map((b) => {
    const c = [project(b.x0, b.y0, 0), project(b.x1, b.y0, 0), project(b.x0, b.y1, 0), project(b.x1, b.y1, 0)];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of c) {
      if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
    }
    return { x0, y0, x1, y1 };
  });
  const nearFocus = (sp, gx, gy) => {
    if (!focusRects.length) return false;
    const p = project(gx + sp.fp[0] / 2, gy + sp.fp[1] / 2, 0);
    const x0 = p[0] - sp.ax, y0 = p[1] - sp.ay;
    const x1 = x0 + sp.w, y1 = y0 + sp.h;
    for (const f of focusRects) {
      if (x0 > f.x1 || x1 < f.x0 || y0 > f.y1 || y1 < f.y0) continue;
      return true;
    }
    return false;
  };

  /** how a placed piece relates to the cut-away this frame */
  const ghostAlpha = (o) => {
    if (focusOff || state.cutaway === 'off') return 1;
    if (o.declared) {
      // The room's own camera-side runs. 'hide' takes them out of the picture
      // entirely 鈥?not a fade, not drawn at all 鈥?which is what an unobstructed
      // view of the room means.
      return state.cutaway === 'hide' ? 0 : CUT_ALPHA[mode === 'outdoor' ? 'outdoor' : 'indoor'];
    }
    if (o.auto && nearFocus(o.sp, o.gx, o.gy)) {
      return CUT_ALPHA[mode === 'outdoor' ? 'outdoor' : 'indoor'];
    }
    return 1;
  };

  /** pieces the player has switched off are not submitted at all */
  const hidden = (role) => role != null && state.hide[role] === true;

  for (const it of S.groundList) pushSprite(it.sp, it.gx, it.gy, it.flags, 1, it.sp.id, it.bias);
  let oi = 0, ai = 0;
  const sortedAgents = agentDraw.slice().sort((p, q) => p.depth - q.depth);
  while (oi < S.objList.length || ai < sortedAgents.length) {
    const o = S.objList[oi], g = sortedAgents[ai];
    if (g && (!o || g.depth <= o.depth)) { if (g.sp) pushSprite(g.sp, g.gx, g.gy, g.flags, 1, g.id, g.bias); ai++; }
    else {
      const a = hidden(o.role) ? 0 : ghostAlpha(o);
      // alpha 0 means "not in the picture": not drawn in either layer, so it
      // cannot occlude, cannot be lit, and costs nothing.
      if (a > 0.0001) pushSprite(o.sp, o.gx, o.gy, o.flags, a, o.id, o.bias, o.lift);
      oi++;
    }
  }
  renderer.setInstances(drawList, false);
  renderer.setInstances(ghostList, true);
  ghostIds = ghostList.map((i) => i.id);

  // ---- shafts: refill the sun-visibility volume when the sun has actually
  // moved, and at most every few frames. It is the only per-sun-direction cost
  // in the renderer (a few million voxel walks), the sun drifts slowly, and a
  // paused clock 鈥?which is every QA screenshot 鈥?pays it exactly once.
  if (mode !== 'outdoor') {
    const si = renderer.shaftInfo;
    const s = dl.sunDir;
    shaftTick++;
    const moved = !si || !si.sun || Math.abs(si.sun[0] - s[0]) + Math.abs(si.sun[1] - s[1])
      + Math.abs(si.sun[2] - s[2]) > 0.0015;
    if (moved && (shaftTick % 3 === 0 || !si || !si.sun)) {
      renderer.updateShaftVolume({ room: true, sunDir: dl.sunDir });
    }
  }

  // ---- render
  const wet = rain * 0.6;
  const indoor = mode !== 'outdoor';
  renderer.render({
    camPx, camWorld: [cam.x, cam.y], iso: [ISO.HW, ISO.HH, ISO.ZPX], eye: EYE,
    room: indoor,
    // Depth is x + y + K*z, so the map's diagonal bounds it: w + h tiles plus
    // the height term, with headroom for sprites that overhang their footprint
    // (roofs, tree canopies). `depthOrigin` is subtracted before that span is
    // encoded, because depth is NEGATIVE behind the map's near corner and a
    // focus box is allowed to hang off the map 鈥?see FOCUS_FS.
    depthRange: indoor ? 64 : 160,
    depthOrigin: indoor ? 24 : 16,
    debug: lightDebug,    // A roof keeps nearly all of the sky out. What survives is the diffuse light
    // that actually does come in through the windows plus a warm bounce off the
    // boards and plaster. The direct term is pushed harder than life indoors: a
    // sunbeam that has crossed a window is the brightest thing in the room by a
    // wide margin, and the tonemap would otherwise flatten that away.
    indoorAmbient: 0.45,
    indoorBounce: [0.055, 0.044, 0.032],
    indoorSun: 3.0,
    // Penumbra of the room's sun march, in world units. The interior volume
    // resolves a voxel at 1/14 of a tile, so a shade under two voxels is enough
    // to hide the stair-stepping without moving where the light lands. See
    // roomMarch in src/gl/shaders.js for why a knife edge indoors reads as a
    // lit surface rather than as a shadow.
    //
    // Tried 0.30 against the last remaining slivers (light slipping through the
    // half-covered voxel at a sill's edge) and it changed nothing: those slivers
    // are one voxel wide, so three taps 4 voxels apart all land in the same state.
    // Widening the penumbra only softens edges that are already wide, so it is
    // back at the value that hides the stair-stepping and no more.
    sunSoftIndoor: 0.12,
    // ---- the air glow belongs to the walls that admit it ---------------------
    //
    // In-scattered sunlight is the one lighting term whose SOURCE is a wall. The
    // sun patches on the floor come from the window aperture and survive the
    // cut-away untouched 鈥?that is the window-frame light split, and it stays in
    // all three modes. The GLOW IN THE AIR is different: it is the beam the wall
    // let in, and once the wall is not drawn there is nothing on screen that
    // explains a bright, flat, hard-edged wash lying across the near floor. It
    // reads as a lit surface rather than as light, which is the exact complaint
    // this whole section exists to answer.
    //
    // So the glow follows the cut-away, gently. 'ghost' keeps the full beam (the
    // wall is still there, faintly, and so is its beam); 'hide' and 'off' take a
    // third off. Measured at 16:03 the air glow on the near floor reads 83/56/48
    // against 1.4 in the middle of the room, so it is worth tempering 鈥?but it is
    // NOT what makes the open view look like a separate space, and it should not
    // be flattened to nothing. `game.shaftAmount` overrides it either way.
    shaftAmount: shaftAmountOverride ?? (state.cutaway === 'ghost' ? 0.28 : 0.18),
    shaftJitter: shaftJitterOverride ?? 0.55,
    fogBlur: fogBlurOverride,
    shadowTaps: shadowTapsOverride,
    shadowSoftIndoor: shadowSoftOverride ?? 0.12,
    shaftSteps: 24,
    ghostVeil: indoor ? 0.38 : 0.85,
    sunDir: dl.sunDir,
    sunColor: mixRain(dl.sunColor, rain),
    skyColor: mixRain(dl.skyColor, rain * 0.8),
    groundColor: mixRain(dl.groundColor, rain * 0.9),
    // a roof keeps most of the sky out; the window portals supply the fill, and
    // keeping the ambient low is what lets a sun patch read as the brightest
    // thing in the room
    sunGain: dl.sunGain * (1 - rain * 0.55),
    ambGain: dl.ambGain * (1 - rain * 0.14),
    shadowStep: dl.shadowStep, shadowSoft: dl.shadowSoft,
    ambShadow: dl.ambShadow,
    fogColor: dl.fogColor,
    fogNear: dl.fogNear, fogFar: dl.fogFar,
    fogAmount: Math.min(0.62, dl.fogAmount * (1 - wet * 0.4) + rain * 0.22 + fogW * 0.30),
    mistHeight: dl.mistHeight + fogW * 0.45,
    mistAmount: Math.min(0.48, dl.mistAmount + fogW * 0.26),
    exposure: dl.exposure * (1 - rain * 0.13) * (indoor ? 1.5 : 1),
    saturation: dl.saturation * (1 - rain * 0.22),
    lights,
  }, {
    bloom: dl.bloom + rain * 0.1,
    bloomThreshold: 0.62,
    vignette: 0.30,
    grain: 0.016 + rain * 0.012,
    time: clockT,
    dither: 0, posterize: 0, scanline: 0,
    lift: [0.004, 0.005, 0.010],
    gain: [1.01, 1.0, 0.99],
  });

  hud.draw({
    clock: clockLabel(state.time), time01: state.time, label: dl.label,
    paused: state.paused, speed: state.speed, weather: state.hud.weather,
    showHelp: state.hud.showHelp, showStats: state.hud.showStats,
    sprites: S.groundList.length + S.objList.length,
    drawn: drawList.length + ghostList.length, lights: lights.length,
    night: dl.nightFactor, weatherMix: state.hud.weatherMix,
    hover, camPx, iso: { HW: ISO.HW, HH: ISO.HH, ZPX: ISO.ZPX },
    mode, zoom: ZOOMS[zoomIdx][2], fade: fade.t,
  });

  requestAnimationFrame(frame);
}

/** rain desaturates and cools every light source */
function mixRain(c, k) {
  if (k <= 0.001) return c;
  const l = c[0] * 0.30 + c[1] * 0.59 + c[2] * 0.11;
  return [
    (c[0] * (1 - 0.3 * k) + l * 0.3 * k) * (1 - 0.10 * k),
    (c[1] * (1 - 0.3 * k) + l * 0.3 * k) * (1 - 0.06 * k),
    (c[2] * (1 - 0.3 * k) + l * 0.3 * k) * (1 + 0.02 * k),
  ];
}

fit();
updateCamPx();
requestAnimationFrame(frame);

window.game = {
  state, get cam() { return cam; }, renderer, scene, room, roomUp, chapel, atlas: worldAtlas, atlasInt,
  daylightAt, clockLabel, RES, OUT, IN, UP, CHAP, SCENES, STOREYS,
  get mode() { return mode; },
  get current() { return S; },
  get lightDebug() { return lightDebug; },
  set lightDebug(v) { lightDebug = v | 0; },
  enter,
  /** U / PageUp / PageDown: outdoor -> ground floor -> loft -> chapel -> ground floor */
  cycleStorey,
  get storey() { return storey(); },
  get agents() { return S.agents; },
  get house() { return scene.house; },
  setZoom(i) { zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, i | 0)); applyZoom(); },
  get zoom() { return ZOOMS[zoomIdx][2]; },
  get camPx() { return camPx; },
  /** sprite ids currently in the transparent cutaway layer (QA / debug) */
  get ghostIds() { return ghostIds; },
  /**
   * QA switch: publish no focus at all. With this on, nothing anywhere can be
   * ghosted, which is what makes "this building faded for no reason" a
   * measurable claim rather than an opinion 鈥?render the same frame with the
   * focus on and off and diff them (tools/verify.mjs does exactly that).
   */
  get focusOff() { return focusOff; },
  set focusOff(v) { focusOff = !!v; },
  /** QA: draw with no depth test at all 鈥?the pre-depth-buffer behaviour */
  get depthOff() { return renderer.depthOff; },
  set depthOff(v) { renderer.depthOff = !!v; },
  /**
   * QA: which outdoor shadow march runs. `true` (default) walks the max pyramid
   * over the height field, which cannot step over a caster; `false` is the old
   * geometric-step march, kept so the two can be diffed on the same frame 鈥?   * `game.shadowMarch = false` is the "before" picture.
   */
  get shadowMarch() { return renderer.maxMipOn; },
  set shadowMarch(v) { renderer.maxMipOn = !!v; },
  /**
   * Per-role hide switches. `game.hide.lamp = true` hides every lamp-class
   * piece; the roles are baked per sprite and listed in tools/build-assets.mjs.
   */
  hide: state.hide,
  /**
   * How the camera-side walls are treated: 'ghost' (fade, default), 'hide'
   * (gone 鈥?an open doll's-house view), 'off' (solid). Everything except the air
   * glow is identical across the three; see the note on state.cutaway for that
   * one exception and what it means for diffing two modes.
   */
  get cutaway() { return state.cutaway; },
  set cutaway(v) { state.cutaway = ['ghost', 'hide', 'off'].includes(v) ? v : 'ghost'; },
  /** in-scattered sunlight in the air 鈥?0 turns the beams off entirely */
  get shaftAmount() { return shaftAmountOverride ?? (state.cutaway === 'ghost' ? 0.28 : 0.18); },
  set shaftAmount(v) { shaftAmountOverride = v === null ? null : Math.max(0, Number(v) || 0); },
  /** how much white noise the shaft march uses to hide its own banding (0..1) */
  /** EXPERIMENT: extra 3x3x3 blur passes over the air (fog) volume, 0..4 */
  get fogBlur() { return fogBlurOverride; },
  set fogBlur(v) { fogBlurOverride = Math.max(0, Math.min(4, v | 0)); renderer.fogBlurPasses = fogBlurOverride; },
  /** EXPERIMENT: rays across the sun disc in the room march, 3 or 5 */
  get shadowTaps() { return shadowTapsOverride; },
  set shadowTaps(v) { const n = v | 0; shadowTapsOverride = n >= 9 ? 9 : (n >= 5 ? 5 : 3); },
  /** EXPERIMENT: penumbra width of the room march, world units */
  get shadowSoft() { return shadowSoftOverride ?? 0.12; },
  set shadowSoft(v) { shadowSoftOverride = v === null ? null : Math.max(0, Number(v) || 0); },
  get shaftJitter() { return shaftJitterOverride ?? 0.55; },
  set shaftJitter(v) { shaftJitterOverride = v === null ? null : Math.max(0, Math.min(1, Number(v) || 0)); },
  /** role of every piece currently on screen 鈥?for finding out what to hide */
  get roles() {
    const out = {};
    for (const o of S.objList) if (o.role) out[o.role] = (out[o.role] || 0) + 1;
    return out;
  },
  /**
   * Screen pixel -> the world point the projection says is there, at a given
   * surface height (0 = the floor plane). The inverse of what the sprite
   * shader does with gl_FragCoord, so "is this pixel inside the room" and
   * "which tile is this" can be answered without guessing from a screenshot.
   * Returns inside: null when the current scene has no volume.
   */
  worldAt(px, py, z = 0) {
    const rel = [px + 0.5 - camPx[0], (RES[1] - py - 0.5) - camPx[1]];
    const xmy = rel[0] / ISO.HW;
    const xpy = (rel[1] + z * ISO.ZPX) / ISO.HH;
    const x = (xmy + xpy) * 0.5, y = (xpy - xmy) * 0.5;
    const vol = S.volume;
    let inside = null;
    if (vol) {
      const b = vol.bounds;
      inside = x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1]
        && z >= b.min[2] && z <= b.max[2];
    }
    return { x, y, z, tile: [Math.floor(x), Math.floor(y)], inside };
  },
  /** every sprite the last frame submitted whose screen rectangle covers one
   * pixel, in painter order, with the alpha and height range it was submitted
   * with. This is the answer to "what is actually drawn here" 鈥?the question
   * you otherwise try to settle by hiding things one at a time and squinting.
   * `game.pick(760, 520)`.
   */
  pick(px, py) {
    const out = [];
    const scan = (list, layer) => list.forEach((it, i) => {
      const x = it.org[0] + camPx[0], y = it.org[1] + camPx[1];
      if (px < x || py < y || px >= x + it.size[0] || py >= y + it.size[1]) return;
      out.push({
        layer, order: i, id: it.id, alpha: Number(it.alpha.toFixed(3)),
        z: [Number(it.z[0].toFixed(3)), Number(it.z[1].toFixed(3))],
        screen: [Math.round(x), Math.round(y), it.size[0], it.size[1]],
      });
    });
    scan(drawList, 'opaque');
    scan(ghostList, 'ghost');
    return out;
  },
  /** point lights emitted on the last frame (QA / debug) */
  get lastLights() { return lastLights; },
  /** how many of those were window/door daylight portals */
  get lastPortals() { return lastPortals; },
};
