// The interior scene.
//
// Interiors are a SEPARATE MAP at a different scale, not a cutaway of the world
// map. That decision fixes three things at once:
//
//   * the outdoor composition is never compromised by a building that has to be
//     hollow — outside, a house is just a handsome house;
//   * a room is a small, close space, and at the world's 32 px per tile it was
//     genuinely unreadable. Here the same models are baked at 48 px per tile;
//   * nothing needs to be cut away *because the camera moved*.
//
// ---- what changed, and why ------------------------------------------------
// The room used to be an open-fronted dollhouse: a knee-high kerb along the wall
// run facing the camera, and a ceiling that stopped two thirds of the way back so
// sunlight could fall in over the top. Both were workarounds for a conflation
// running through the whole renderer — "this wall is in the way of the camera"
// and "this wall is in the way of the sun" were the same flag.
//
// They are not the same thing, and treating them as one produced the room's
// three visible symptoms at once: a hard grey slab of ceiling shadow across the
// middle of the floor, an unreadable wall of timber where the light should have
// been, and sun patches landing in exactly the strip of floor that the wall was
// hiding.
//
// Now the room is a REAL ROOM: four full-height walls, windows in all of them,
// a doorway, and a ceiling across the whole thing. Light behaves like light. The
// walls facing the camera are ghosted by the renderer's cutaway pass
// (see src/main.js) — a decision about the CAMERA that touches nothing else. The
// volume the sun marches through still has every wall standing exactly where it
// is, which is the whole point.

import { makeRng } from './rng.js';

export const ROOM_W = 11;
export const ROOM_D = 9;
export const WALL_H = 2.2;
export const CAP_H = 0.085;
/** top surface of the dining table, in world units — see `over(oil_lamp, ...)` */
export const TABLE_TOP = 0.88;

/**
 * The shared plumbing every storey of this house is built from.
 *
 * Splitting this out is what lets a SECOND floor exist without touching the
 * first: the ground plan below and src/interior_upper.js both call this, drive
 * it with their own window rhythm and furniture plan, and hand the result to
 * finishRoom(). Nothing about the renderer is storey-specific — a room is a
 * w x h floor, four wall runs, a ceiling, and the marks that let the sun decide
 * what it can reach.
 *
 * @param atlas the INTERIOR atlas (48x24 tiles)
 * @returns helpers + the arrays the plan fills in, or null if the atlas is unusable
 */
export function roomKit(atlas, { w, h, seed = 77123 }) {
  const rng = makeRng(seed);
  const ground = new Array(w * h).fill(null);
  const objects = [];
  const marks = [];

  const floors = ['floor_wood', 'floor_wood_b'].map((k) => atlas.first(k)).filter(Boolean);
  const stone = atlas.first('floor_stone');
  const tile = atlas.first('floor_tile');
  if (!floors.length || !atlas.has('wall_solid#0')) return null;

  /**
   * Place a piece at the top-left of its footprint AS IT APPEARS ON THE MAP.
   *
   * A rotated sprite still pivots about the centre of its UNROTATED footprint,
   * so a 2x1 bench turned 90 degrees lands half a tile off unless the anchor is
   * shifted back by half the difference. Doing that here means every placement
   * below can be read as "this piece occupies these tiles", which is the only
   * way a 40-piece plan stays checkable.
   *
   * `layer` is how the piece relates to the things around it:
   *   'under'  a floor decal — the rug a table stands on.
   *   'over'   standing or hanging ABOVE its own tile — the lamp on that table.
   * The ordering itself comes from the depth buffer; these only decide exact
   * ties, plus (for 'over') where a piece's real `lift` is stated.
   *
   * `lift` is the piece's real height above its tile, in world units: a table
   * lamp modelled from the ground up is placed 0.88 units higher, so its
   * geometry really is where it looks like it is.
   *
   * `opts.cut` says the piece stands between the fixed isometric camera and the
   * room. It is a statement about the ROOM, made by the code that laid the room
   * out — not something the renderer infers, and not something that can go
   * missing at runtime. See the note at the top of this file.
   */
  const place = (id, X, Y, rot = 0, layer = null, lift = 0, opts = {}) => {
    const sid = atlas.spriteId(id, rot);
    if (!sid) return null;
    const sp = atlas.get(sid);
    const [fw, fd] = sp.fp;
    const odd = (rot | 0) & 1;
    const gx = odd ? X + (fd - fw) / 2 : X;
    const gy = odd ? Y + (fw - fd) / 2 : Y;
    const o = { id, gx, gy, rot: sid.includes('#') ? (rot | 0) : 0 };
    // ±0.01 in a sort key whose magnitude is ~10: a tie-break, not a reorder.
    // Depth is what decides the stacking; this only picks a winner when two
    // pieces are genuinely at the same depth.
    if (layer === 'under') o.sort = -0.01;
    if (layer === 'over') o.sort = 0.01;
    if (lift) o.lift = lift;
    if (opts.cut) o.cut = 1;
    objects.push(o);
    return o;
  };
  const furn = place;
  const under = (id, X, Y, rot = 0) => place(id, X, Y, rot, 'under');
  const over = (id, X, Y, rot = 0, lift = 0) => place(id, X, Y, rot, 'over', lift);

  /**
   * Which wall runs the camera stands outside of.
   *
   * The projection is fixed — the eye is always up and to +x+y — so this is a
   * property of the ROOM, not of the camera or of what the player is looking at.
   * The two runs on this side are the ones that have to get out of the way; the
   * two on the far side are the backdrop and must never fade. It is written down
   * once, here, in the code that already knows which run is which.
   *
   * The version of this that inferred the answer per frame from a depth image
   * was fragile in the worst possible way: if the image came back empty — a
   * stale module, a driver quirk, a mid-rebuild reload — every wall silently
   * went solid and took the furniture behind it with it, with nothing in the
   * console to say so. A statement about the room cannot fail that way.
   */
  const CAM_SIDE = { '+x': true, '+y': true, '-x': false, '-y': false };

  /**
   * Mount a piece on one of the four wall runs.
   *
   * `back` is where the model's own back plane sits inside its tile, and it is
   * read straight out of the occupancy marks the model declares — the same
   * numbers the light volume is built from, so a hung clock cannot drift away
   * from the wall it hangs on. Only pass it explicitly when the marks describe
   * something other than the panel itself (see BACK_FIX).
   *
   * GETTING THIS WRONG IS NOW VISIBLE, and that is new. An offset too large
   * pushes the model's back INTO the wall slab. Under the painter's algorithm
   * that was invisible — the piece was simply drawn after the wall and painted
   * over it, which is exactly the kind of error a painter's order conceals.
   * Under a depth buffer the buried part loses to the wall and the piece looks
   * eaten. The bookshelf spent this whole project mounted with `back = 0.5`,
   * half a tile further out than its own back plane, and lost its entire body
   * to the wall the moment occlusion became geometric. The fix is the placement,
   * not the depth test.
   */
  const R = 0.16;
  const BACK_FIX = { furn_painting: 0.70, furn_curtain: 0.44 };
  const backOf = (id) => {
    if (BACK_FIX[id] !== undefined) return BACK_FIX[id];
    const v = (atlas.m.volumes || {})[id];
    if (!v || !v.length) return 0.5;
    return Math.min(...v.map((m) => m.y0));
  };
  const wall = (id, i, side, back = null) => {
    const rot = { '-y': 0, '+x': 1, '+y': 2, '-x': 3 }[side];
    const sid = atlas.spriteId(id, rot);
    if (!sid) return null;
    const fd = atlas.get(sid).fp[1];
    const B = back ?? backOf(id);
    const cut = { cut: CAM_SIDE[side] ? 1 : 0 };
    if (side === '-y') return place(id, i, R - B, rot, null, 0, cut);
    if (side === '+y') return place(id, i, h - R - fd + B, rot, null, 0, cut);
    if (side === '-x') return place(id, R - B, i, rot, null, 0, cut);
    return place(id, w - R - fd + B, i, rot, null, 0, cut);
  };

  /** first id in the list the atlas actually has — plans read as prose, not null checks */
  const F = (...n) => atlas.first(...n);

  return {
    atlas, w, h, rng, ground, objects, marks, floors, stone, tile,
    F, place, furn, under, over, wall, backOf, CAM_SIDE, R,
  };
}

/**
 * Turn a filled-in kit into a scene: stamp the ARCHITECTURE into the volume,
 * close the ceiling over the whole room, and describe the result.
 *
 * See the note at "occupancy volume" below for why furniture is not stamped.
 */
export function finishRoom(kit, { door, wallH = WALL_H, capH = CAP_H }) {
  const { atlas, w, h, objects, marks } = kit;

  // ---- occupancy volume -----------------------------------------------------
  // ARCHITECTURE ONLY. Walls, windows and the ceiling go in; furniture does not.
  //
  // Voxels are ~3 px at this scale, so a table leg or a chair frame simply does
  // not exist in the volume — marking a chair therefore stamps a solid blob the
  // size of the chair, and the result is shadows nobody can identify. Furniture
  // is grounded by its own baked per-pixel AO instead, which is exact, and the
  // shadow term is left to mean one thing only: what the ARCHITECTURE is doing
  // with the sunlight. That is also what makes a window patch read as a window
  // patch, because nothing else is drawing shadow shapes on the floor.
  for (const o of objects) {
    const sid = atlas.spriteId(o.id, o.rot);
    const sp = sid && atlas.get(sid);
    if (!sp || sp.cat !== 'wall') continue;      // ARCHITECTURE ONLY
    const vols = atlas.m.volumes ? atlas.m.volumes[o.id] : null;
    if (!vols || !vols.length) continue;
    for (const v of vols) {
      const C = [1, 0, -1, 0][o.rot], S = [0, 1, 0, -1][o.rot];
      const cx = sp.fp[0] / 2, cy = sp.fp[1] / 2;
      const X = (x, y) => cx + (x - cx) * C - (y - cy) * S + o.gx;
      const Y = (x, y) => cy + (x - cx) * S + (y - cy) * C + o.gy;
      const xs = [X(v.x0, v.y0), X(v.x1, v.y0), X(v.x0, v.y1), X(v.x1, v.y1)];
      const ys = [Y(v.x0, v.y0), Y(v.x1, v.y0), Y(v.x0, v.y1), Y(v.x1, v.y1)];
      // ---- overlapping marks, not abutting ones ------------------------------
      //
      // The volume stores per-voxel COVERAGE (see makeVolume in gl/renderer.js), so
      // two marks that meet edge to edge do not add up to a solid joint: a voxel
      // straddling the seam gets 40% from one and 60% from the other and stays 40%
      // transparent. A wall's mark ends at the wall top and the ceiling's begins
      // 0.085 above it, which is less than one voxel, so the seam fell inside a
      // single voxel — and the top of every wall in every interior was a slot that
      // let 12-16% of the sun through. It shows up as a row of bright edges on the
      // interior wall ABOVE the windows, which is a place no sunlight can reach.
      //
      // So every solid mark is extended upward by about a voxel and a half. It
      // costs nothing (the extra is inside the ceiling, or inside the course above)
      // and it also closes the seam between a wall's own two courses. Glass is left
      // exactly as authored: a pane's top edge is a real edge, and its transmittance
      // is quoted for the pane, not for a seam.
      const GROW = v.kind === 'glass' ? 0 : 0.12;
      marks.push({
        kind: v.kind, trans: v.trans, tint: v.tint,
        x0: Math.min(...xs), x1: Math.max(...xs),
        y0: Math.min(...ys), y1: Math.max(...ys),
        z0: v.z0, z1: v.z1 + GROW,
      });
    }
  }
  // The ceiling covers the WHOLE room. That is the point of the rewrite: with the
  // walls ghosted for the camera there is no longer any reason to leave the sky
  // open, and a room that is genuinely closed is the only way a window can read
  // as the source of the light in it.
  //
  // Its height is a parameter, because a room's height is a property of the ROOM
  // and not of the renderer: the cottage storeys are walled to WALL_H and the
  // chapel (src/interior_chapel.js) to 4.2, and both are stamped by this one
  // function. Every piece of architecture already declares its own height
  // through its volume marks, so the only thing the ceiling has to agree with is
  // the top of the walls it closes.
  marks.push({
    kind: 'solid',
    x0: -0.25, y0: -0.25, z0: wallH + capH,
    x1: w + 0.25, y1: h + 0.25, z1: wallH + 0.9,
  });

  return {
    w, h, ground: kit.ground, objects, marks, door,
    bounds: { min: [-0.55, -0.55, -0.3], max: [w + 0.55, h + 0.55, wallH + 0.95] },
    scale: atlas.m.scale || 1.5,
  };
}

/**
 * The GROUND floor: 11x9, hearth in the back-left corner, scullery along the
 * back wall, bed alcove on the left, table in the middle, stores on the right.
 *
 * This plan is unchanged by the addition of the upper floor — it is the same
 * room it has always been, and tools/check-interior.mjs plus a frame-for-frame
 * diff against the previous build are what keep it that way.
 *
 * @param atlas the INTERIOR atlas (48x24 tiles)
 * @returns {{w,h,ground,objects,door,marks,bounds,scale}}
 */
export function makeInterior(atlas) {
  const K = roomKit(atlas, { w: ROOM_W, h: ROOM_D });
  if (!K) return null;
  const { w, h, ground, floors, stone, tile, F, place, furn, under, over, wall, CAM_SIDE } = K;

  // ---- floor ---------------------------------------------------------------
  // Laid the way a building would be: boards through the living half, flagstone
  // around the hearth, tile in the scullery. The zones match the furniture plan
  // below, so a change of material tells you where you are.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let g = floors[(x + y) % 2];
      if (tile && x >= 4 && x <= 7 && y <= 1) g = tile;          // scullery
      if (stone && x <= 2 && y <= 2) g = stone;                  // in front of the hearth
      ground[y * w + x] = g;
    }
  }

  // ---- perimeter ------------------------------------------------------------
  //
  // Four full-height runs, all with windows, because the sun sweeps a quarter of
  // the compass between sunrise and sunset: +x takes the morning, +x+y the middle
  // of the day, +y and -x the evening. A wall left windowless is a wall that
  // leaves a third of the day dark.
  //
  // This round gives each run its own OPENING, so the four walls read as four
  // walls and the patches on the floor carry the shape of the hole they came
  // through. The two runs facing the camera (+x, +y) carry the light, so they get
  // the tall openings; the two backdrop runs get casements and one arch each.
  //
  //   -y  backdrop, seen head-on   casement x2 + the door
  //   -x  backdrop, seen at angle  casement + ARCH
  //   +y  light wall (ghosted)     FRENCH x2 + ARCH
  //   +x  light wall (ghosted)     FRENCH x2
  const DOOR_I = 6;
  const winBack = new Set([2, 9]);       // -y: casements
  const archBack = new Set([]);
  const winLeft = new Set([2, 5]);       // -x: casement + arch
  const archLeft = new Set([5]);
  const winFront = new Set([2, 8]);      // +y: French windows
  const archFront = new Set([5]);
  const winRight = new Set([2, 7]);      // +x: French windows
  const archRight = new Set([5]);        //     ...and an arch between them

  for (let i = 0; i < w; i++) {
    const back = i === DOOR_I ? 'wall_door'
      : winBack.has(i) ? 'wall_window'
        : archBack.has(i) ? 'wall_window_arch' : 'wall_solid';
    const front = winFront.has(i) ? 'wall_window_tall'
      : archFront.has(i) ? 'wall_window_arch' : 'wall_solid';
    // The two runs the camera stands outside of are marked `cut`; the two it
    // looks across are not. `furn` is `place` without a layer, so the cut flag
    // has to be passed explicitly here — these are the pieces the whole cut-away
    // exists for, and getting one of them wrong is the difference between a room
    // you can see and a closed box.
    place(back, i, 0, 2);
    place(front, i, h - 1, 0, null, 0, { cut: CAM_SIDE['+y'] });
  }
  for (let j = 0; j < h; j++) {
    const left = winLeft.has(j) ? (archLeft.has(j) ? 'wall_window_arch' : 'wall_window') : 'wall_solid';
    const right = winRight.has(j) ? 'wall_window_tall'
      : archRight.has(j) ? 'wall_window_arch' : 'wall_solid';
    place(left, 0, j, 1);
    place(right, w - 1, j, 3, null, 0, { cut: CAM_SIDE['+x'] });
  }

  // ---- furniture ------------------------------------------------------------
  //
  // A plan, not a scatter. Five zones, everything pushed against a wall or
  // gathered into a group, two clear lanes left open — the row y=2 and the
  // column x=6.
  //
  //   back-left    the hearth     — fire, cauldron, barrel, a chair pulled up
  //   back-centre  the scullery   — counter, churn, stove, preserves
  //   left         the bed alcove — bed, nightstand, chest
  //   centre       the table      — rug, table, three chairs, lamp overhead
  //   front-left   the reading    — bookshelf, rug, armchair, plant
  //   right        the stores     — wardrobe, dresser, bench
  //
  // Two of the three notes that used to be here are gone, because the depth
  // buffer made them unnecessary rather than because the problems went away:
  //
  //   * "sorting is by front edge" — there is no sort deciding anything now.
  //     A bed's foot next to a wall tile, a rug under a table, a chair pulled up
  //     to it: all of it is resolved per pixel, from the geometry, by the depth
  //     test. The scene no longer has to be authored around the renderer.
  //   * "layering is declared, not guessed" — `under` / `over` survive only as
  //     tie-breakers for exactly-coplanar pieces (a rug lying on the floor it
  //     covers) and as the place a piece's real `lift` is stated. They are no
  //     longer what makes the rug land under the table; the rug is under the
  //     table because it is on the floor and the table is not.
  //
  // The one that remains is a statement about the PLAN, not about rendering:
  //
  //   1. NOTHING TALL STANDS IN FRONT OF A WALL PIECE. Correct occlusion is not
  //      the same as a visible piece: the armchair parked squarely in front of
  //      the bookshelf occluded it perfectly and made both useless.
  //   2. HUNG THINGS GO ON A WALL THAT CAN CARRY THEM. A window is not a wall:
  //      a painting leaning over one, or a clock inside the bookshelf that
  //      stands against it, is the kind of mistake a top-down plan never shows.
  const fire = F('furn_fireplace');
  const counter = F('furn_counter');
  const stove = F('furn_stove');
  const shelf_jars = F('furn_shelf_jars');
  const plates = F('furn_shelf_plates');
  const table = F('furn_table');
  const chair = F('furn_chair');
  const armchair = F('furn_armchair');
  const rocker = F('furn_rocker');
  const bookshelf = F('furn_bookshelf');
  const rug_round = F('furn_rug_round');
  const rug_small = F('furn_rug_small');
  const oil_lamp = F('furn_oil_lamp');
  const candles = F('furn_candles');
  const chandelier = F('furn_chandelier');
  const plant = F('furn_plant');
  const chest = F('furn_chest');
  const stool = F('furn_stool');
  const cauldron = F('furn_cauldron');
  const veg_basket = F('furn_veg_basket');
  const painting = F('furn_painting');
  const clock = F('furn_clock');
  const curtain = F('furn_curtain');
  const barrel = F('furn_barrel');
  const crate = F('furn_crate');
  const coat = F('furn_coat_rack');
  const herbs = F('furn_herbs');
  const churn = F('furn_churn');
  const bed = F('furn_bed');
  const nightstand = F('furn_nightstand');
  const wardrobe = F('furn_wardrobe');
  const dresser = F('furn_dresser');
  const bench = F('furn_bench');
  const sack = F('furn_sack');
  const lantern = F('furn_lantern');

  // ---- the hearth, back-left ------------------------------------------------
  furn(fire, 0, 0, 0);                 // 2x1 in the corner: (0,0)-(1,0)
  furn(barrel, 0, 1, 0);
  furn(cauldron, 1, 1, 0);             // standing in front of the fire
  furn(rocker, 2, 1, 2);               // pulled up to the fire, facing it
  over(herbs, 2, 2, 0);                // dried bundles, hanging over the lane

  // ---- the scullery, back-centre --------------------------------------------
  furn(counter, 3, 0, 0);              // 2x1, occupies (3,0)-(4,0)
  furn(churn, 3, 1, 0);
  furn(lantern, 4, 1, 0);              // the light you carry in with you
  wall(painting, 5, '-y');             // leaning on the wall between counter and door
  furn(stove, 7, 0, 0);                // its flue goes up through the ceiling
  furn(coat, 7, 1, 0);                 // coats by the door
  wall(plates, 8, '-y');               // crockery beside the stove
  furn(veg_basket, 9, 1, 0);
  furn(shelf_jars, 10, 0, 0);          // preserves, in the back-right corner

  // ---- the bed alcove, left -------------------------------------------------
  // (0,5) and (0,2) stay clear: they are the two windows on the left wall.
  furn(bed, 0, 3, 0);                  // 1x2, headboard to the back: (0,3)-(0,4)
  furn(nightstand, 1, 3, 0);
  furn(chest, 1, 4, 0);
  furn(candles, 1, 5, 0);

  // ---- the table, centre ----------------------------------------------------
  under(rug_round, 4, 4, 0);           // declared under, so it cannot float
  furn(table, 4, 4, 0);                // 2x2: (4,4)-(5,5)
  furn(chair, 3, 4, 3);                // facing +x, into the table
  furn(chair, 6, 4, 1);                // facing -x, into the table
  furn(chair, 4, 6, 2);                // facing -y, from the front
  // The lamp goes ON the table. It is modelled from the ground up, so it is
  // placed at the tabletop's real height (boards at z=0.80, 0.075 thick) rather
  // than at floor level with a painter-order override — which is what let the
  // old renderer stack it correctly while every depth question about it was
  // still a lie.
  over(oil_lamp, 4, 4, 0, TABLE_TOP);
  over(chandelier, 4.5, 4.5, 0);       // hanging over its centre

  // ---- the reading corner, front-left ---------------------------------------
  // The bookshelf owns the x=0 column from y=6 down, and the tile in front of a
  // wall piece has to stay clear: a chair parked there is correct occlusion and
  // useless furniture. The armchair therefore sits two tiles out, where it can
  // be seen AND let the bookshelf be seen.
  wall(bookshelf, 6, '-x');            // 2x1 on the left wall: (0,6)-(0,7)
  under(rug_small, 1, 6, 0);
  furn(armchair, 2, 6, 3);             // facing +x, into the room
  furn(plant, 3, 7, 0);
  furn(crate, 10, 1, 0);
  furn(sack, 9, 1, 0);
  furn(candles, 9, 2, 0);

  // ---- the stores along the right-hand wall ---------------------------------
  furn(wardrobe, 10, 2, 0);
  furn(dresser, 10, 4, 0);
  furn(bench, 9, 5, 1);                // 2x1 turned to run along the right wall
  furn(plant, 10, 7, 0);
  furn(stool, 8, 1, 0);

  // ---- windows dressed, and the backdrop hung -------------------------------
  //
  // Every wall piece below sits on a tile that carries neither a window nor the
  // door, and has clear floor in front of it. `check-interior.mjs` enforces both.
  wall(curtain, 2, '-y');
  wall(curtain, 9, '-y');
  wall(curtain, 2, '+y');
  wall(curtain, 8, '+y');
  wall(curtain, 5, '+y');
  wall(clock, 1, '-x');
  wall(painting, 8, '-x');

  return finishRoom(K, { door: [DOOR_I, 0.8] });   // just inside the front door
}

/** interior point lights, driven by the same rules as the outdoors */
export const INTERIOR_LIGHTS = [
  { match: 'chandelier', at: [0.5, 0.5, 2.15], color: [1.0, 0.80, 0.50], radius: 6.5, intensity: 1.25, flicker: 0.02, night: true },
  // The chapel's two: a candelabra and an altar. Both are written for the height
  // of their own flames rather than for a lamp standing on the floor, which is
  // the whole reason this table is a list of rules and not a per-room constant.
  // The altar's rule is what lights the chancel at night; without it the two
  // candles on the mensa are geometry with a fire sprite and no light in it.
  { match: 'candelabra', at: [0.5, 0.5, 1.70], color: [1.0, 0.74, 0.40], radius: 5.8, intensity: 1.00, flicker: 0.10, night: true },
  { match: 'altar', at: [0.5, 0.5, 1.60], color: [1.0, 0.78, 0.44], radius: 5.2, intensity: 0.82, flicker: 0.09, night: true },
  // the oil lamp stands ON the table (TABLE_TOP), so its flame is at 1.45 —
  // the light has to be lifted with it, or the table's own lamp lights the
  // floor under the table and leaves the tabletop dark
  { match: 'oil_lamp', at: [0.5, 0.5, 1.22], color: [1.0, 0.76, 0.42], radius: 5.2, intensity: 0.90, flicker: 0.05, night: true },
  { match: 'candle', at: [0.5, 0.5, 0.95], color: [1.0, 0.72, 0.38], radius: 3.8, intensity: 0.62, flicker: 0.11, night: true },
  { match: 'lantern', at: [0.5, 0.5, 1.10], color: [1.0, 0.78, 0.45], radius: 4.4, intensity: 0.70, flicker: 0.04, night: true },
  { match: 'fireplace', at: [0.5, 0.5, 0.60], color: [1.0, 0.50, 0.19], radius: 7.0, intensity: 1.70, flicker: 0.20, night: false },
  { match: 'stove', at: [0.5, 0.4, 0.85], color: [1.0, 0.54, 0.22], radius: 5.4, intensity: 1.15, flicker: 0.14, night: false },
];
