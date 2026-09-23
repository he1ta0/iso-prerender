// The vertical-slice scene.
//
// Everything here is deterministic: a seeded RNG lays out the terrain, then a
// handful of explicit placements compose the actual picture (cottage + garden,
// barn cluster, crop field, pond, lamp-lined path, forest edge). The result is
// stable frame to frame and byte-identical between runs, which is what makes
// the QA screenshots comparable.

import { makeRng } from './rng.js';

// The composed farm occupies COMP x COMP; it is blitted into the middle of a
// larger MAP x MAP world. The padding matters: at 640x360 with 32x16 tiles the
// visible diamond is ~42.5 tiles across, so a map barely bigger than the
// composition would let the camera expose the void beyond the edge.
export const COMP_W = 44;
export const COMP_H = 44;
export const MAP_W = 64;
export const MAP_H = 64;
/** where the walk-in house sits inside the authored composition */
export const HOUSE_AT = [18, 24];
/** wall height from the kit, needed to size the interior volume */
export const ROOM_H = 2.2;

// ---------------------------------------------------------------- helpers
function fill(ground, w, h, fn) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ground[y * w + x] = fn(x, y);
}
function disc(cx, cy, rx, ry, fn) {
  return (x, y) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };
}
function pathLine(x0, y0, x1, y1, width, fn) {
  return (x, y) => {
    const vx = x1 - x0, vy = y1 - y0;
    const wx = x - x0, wy = y - y0;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    const px = x0 + vx * t, py = y0 + vy * t;
    const d = Math.hypot(x - px, y - py);
    return d <= width ? fn(t, d) : null;
  };
}

/**
 * The authored farm: a 44x44 composition of paths, pond, fields and buildings.
 * @returns {{w,h,ground:(string|null)[],objects:Array<{id,gx,gy,flags?}>}}
 */
function buildComposition(atlas) {
  const w = COMP_W, h = COMP_H;
  const rng = makeRng(20240918);
  const ground = new Array(w * h).fill(null);
  const objects = [];
  const used = new Uint8Array(w * h);

  const G = {
    grass: atlas.byCat('ground').filter((k) => k.startsWith('g_grass') && !k.includes('tall') && !k.includes('dry') && !k.includes('flower')),
    grassFlower: atlas.first('g_grass_flower'),
    grassTall: atlas.first('g_grass_tall'),
    dry: atlas.first('g_grass_dry'),
    dirt: atlas.byCat('ground').filter((k) => k.startsWith('g_dirt')),
    tilled: atlas.byCat('ground').filter((k) => k.startsWith('g_tilled') && !k.includes('wet')),
    tilledWet: atlas.byCat('ground').filter((k) => k.startsWith('g_tilled_wet')),
    path: atlas.byCat('ground').filter((k) => k.startsWith('g_path')),
    flag: atlas.byCat('ground').filter((k) => k.startsWith('g_flagstone')),
    gravel: atlas.first('g_gravel'),
    sand: atlas.first('g_sand'),
    water: atlas.byCat('water').filter((k) => k.startsWith('g_water')),
  };
  const pick = (arr, x, y) => atlas.variant(arr.length ? arr : [null], x, y);

  // All four grass variants share ONE material now — the tonal variation comes
  // from the world-space `patch()` field inside the pattern, which flows across
  // tile borders. Variants only differ in noise phase and tuft placement, so the
  // weights are near-even and nothing lines up with the tile grid.
  const grassIds = [
    atlas.first('g_grass'),
    atlas.first('g_grass_b'),
    atlas.first('g_grass_c'),
    atlas.first('g_grass_d'),
  ].filter(Boolean);
  const grassW = [0.28, 0.27, 0.23, 0.22];

  // ---- base terrain: grass, with the far edges turning to rougher ground ---
  fill(ground, w, h, (x, y) => {
    const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
    const n = rng();
    if (edge >= 6 && n < 0.045 && G.grassFlower) return G.grassFlower;
    if (edge < 4 && G.grassTall) return atlas.variant([G.grassTall, G.grassTall, atlas.first('g_grass_b') || G.grassTall], x, y);
    if (n < 0.10 && G.grassTall) return G.grassTall;
    return atlas.variantW(grassIds, grassW, x, y);
  });

  // ---- pond (upper right) --------------------------------------------------
  const pond = disc(35.0, 8.0, 5.6, 4.2);
  const pondInner = disc(35.0, 8.0, 4.6, 3.3);
  const shoreTiles = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pond(x, y)) {
        if (pondInner(x, y)) { ground[y * w + x] = pick(G.water, x, y); used[y * w + x] = 1; }
        else {
          // shoreline: pick the shore variant whose cut edge faces the water
          const side = !pond(x, y - 1) ? 'n' : !pond(x, y + 1) ? 's' : !pond(x - 1, y) ? 'w' : 'e';
          const id = atlas.first(`g_shore_${side}`);
          ground[y * w + x] = id || atlas.first('g_sand') || pick(G.grass, x, y);
          used[y * w + x] = 1;
          shoreTiles.push([x, y]);
        }
      }
    }
  }

  // ---- fields: tilled soil with crop rows ---------------------------------
  const cropTable = cropIds(atlas);
  const cropNames = [...cropTable.keys()];
  const fieldRect = { x: 6, y: 22, w: 9, h: 11 };
  const waterable = [];
  for (let y = fieldRect.y; y < fieldRect.y + fieldRect.h; y++) {
    for (let x = fieldRect.x; x < fieldRect.x + fieldRect.w; x++) {
      const row = Math.floor((y - fieldRect.y) / 2);
      const isPath = (y - fieldRect.y) % 2 === 1;
      if (isPath) {
        ground[y * w + x] = pick(G.dirt, x, y);
        used[y * w + x] = 1;
        continue;
      }
      const wet = row % 3 === 1;
      ground[y * w + x] = pick(wet ? G.tilledWet : G.tilled, x, y);
      used[y * w + x] = 1;
      if (cropNames.length) {
        const name = cropNames[row % cropNames.length];
        // stage varies along the row so the field shows the whole life cycle
        const k = (x - fieldRect.x) / (fieldRect.w - 1);
        const stage = Math.min(4, Math.floor(k * 5 + (row % 2 ? 0.4 : 0)));
        const id = cropTable.get(name)[stage];
        if (id) { objects.push({ id, gx: x, gy: y, flags: 0 }); used[y * w + x] = 1; }
      }
    }
  }
  waterable.push(fieldRect);

  // ---- kitchen garden next to the cottage ---------------------------------
  const gardenRect = { x: 18, y: 20, w: 4, h: 4 };
  for (let y = gardenRect.y; y < gardenRect.y + gardenRect.h; y++) {
    for (let x = gardenRect.x; x < gardenRect.x + gardenRect.w; x++) {
      ground[y * w + x] = pick(G.tilledWet, x, y);
      const name = cropNames.length ? cropNames[(x + y) % cropNames.length] : null;
      if (name) {
        const id = cropTable.get(name)[4];
        if (id) objects.push({ id, gx: x, gy: y });
      }
    }
  }

  // ---- paths ---------------------------------------------------------------
  const paths = [
    pathLine(2, 40, 15, 33, 1.4, () => pick(G.path, 0, 0)),
    pathLine(15, 33, 22, 31, 1.2, () => pick(G.path, 1, 0)),
    pathLine(15, 33, 29, 27, 1.1, () => pick(G.path, 0, 1)),
    pathLine(29, 27, 34, 20, 1.1, () => pick(G.path, 1, 1)),
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (used[y * w + x]) continue;
      for (const p of paths) {
        const r = p(x, y);
        if (r !== null && r !== undefined) {
          if (rng() < 0.82) { ground[y * w + x] = pick(G.path, x, y); used[y * w + x] = 1; }
          break;
        }
      }
    }
  }

  // ---- buildings -----------------------------------------------------------
  let house = null;
  const put = (id, gx, gy, rot = 0) => {
    const spriteId = rot ? `${id}#${rot}` : id;
    const sp = atlas.get(spriteId);
    if (!sp) return null;
    objects.push({ id, gx, gy, rot });
    const [fw, fd] = sp.fp;
    for (let y = gy; y < gy + fd; y++) for (let x = gx; x < gx + fw; x++) {
      if (x >= 0 && y >= 0 && x < w && y < h) used[y * w + x] = 1;
    }
    return { id, gx, gy, rot, fp: sp.fp };
  };

  // ---- the farmhouse -------------------------------------------------------
  // Outdoors a house is just a house: one handsome monolithic sprite. The
  // interior is a SEPARATE MAP at a different scale (see src/interior.js) — the
  // earlier attempt at tiling the walls out here so they could be cut away ended
  // up wrecking the composition and still could not make a room readable at
  // 32 px per tile.
  const hb = put(atlas.first('bld_farmhouse', 'bld_cottage'), 20, 24);
  house = hb ? {
    id: hb.id, x0: hb.gx, y0: hb.gy, w: hb.fp[0], d: hb.fp[1],
    // the farmhouse model puts its front door on the +x face, halfway along it
    door: [hb.gx + hb.fp[0], hb.gy + Math.floor(hb.fp[1] / 2)],
  } : null;

  put(atlas.first('bld_barn', 'bld_shed'), 30, 27);
  put(atlas.first('bld_greenhouse'), 26, 31);
  put(atlas.first('bld_coop'), 35, 33);
  put(atlas.first('bld_shed', 'bld_coop'), 17, 30);
  // flagstone path up to the front door
  if (house) {
    for (let i = 0; i < 3; i++) {
      const x = house.door[0], y = house.door[1] + 1 + i;
      if (x < w && y < h) ground[y * w + x] = pick(G.flag, x, y);
    }
  }

  // ---- fences around the field and the garden ------------------------------
  const fence = atlas.first('fence_wood');
  const gate = atlas.first('fence_gate');
  if (fence) {
    const rect = { x: fieldRect.x - 1, y: fieldRect.y - 1, w: fieldRect.w + 2, h: fieldRect.h + 2 };
    const putMaybe = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const g = ground[y * w + x];
      if (g && g.startsWith('g_tilled')) return;      // never fence over a crop row
      // leave a gateway on the bottom edge
      const isGate = gate && y === rect.y + rect.h - 1 && x === rect.x + Math.floor(rect.w / 2);
      objects.push({ id: isGate ? gate : fence, gx: x, gy: y });
    };
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      putMaybe(x, rect.y);
      putMaybe(x, rect.y + rect.h - 1);
    }
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      putMaybe(rect.x, y);
      putMaybe(rect.x + rect.w - 1, y);
    }
  }

  // ---- trees, bushes, rocks ------------------------------------------------
  const oaks = atlas.byCat('tree').filter((k) => k.includes('oak'));
  const pines = atlas.byCat('tree').filter((k) => k.includes('pine'));
  const cherry = atlas.first('tree_cherry', 'prop_tree_cherry');
  const autumn = atlas.first('tree_autumn', 'prop_tree_autumn');
  const bush = atlas.byCat('tree').filter((k) => k.includes('bush'));
  const rock = atlas.byCat('tree').filter((k) => k.includes('rock') || k.includes('boulder'));
  const stump = atlas.first('tree_stump', 'prop_tree_stump');

  const placeRandom = (id, n, test) => {
    if (!id) return;
    let tries = 0, placed = 0;
    while (placed < n && tries < n * 60) {
      tries++;
      const x = 2 + Math.floor(rng() * (w - 4));
      const y = 2 + Math.floor(rng() * (h - 4));
      if (used[y * w + x]) continue;
      if (!test(x, y)) continue;
      const g = ground[y * w + x];
      if (!g || !g.startsWith('g_grass')) continue;
      objects.push({ id, gx: x, gy: y });
      used[y * w + x] = 1;
      placed++;
    }
  };

  // forest edge: denser toward the borders
  const edgeDist = (x, y) => Math.min(x, y, w - 1 - x, h - 1 - y);
  placeRandom(pick(pines.length ? pines : oaks, 1, 1), 26, (x, y) => edgeDist(x, y) < 7);
  placeRandom(pick(oaks, 2, 2), 22, (x, y) => edgeDist(x, y) < 9);
  placeRandom(cherry, 5, (x, y) => edgeDist(x, y) < 12);
  placeRandom(autumn, 6, (x, y) => edgeDist(x, y) < 10);
  placeRandom(pick(bush, 3, 3), 30, () => true);
  placeRandom(pick(rock, 4, 4), 16, () => true);
  placeRandom(stump, 4, () => true);
  // a couple of trees right by the cottage for framing
  const oaksAny = oaks.length ? oaks : pines;
  if (oaksAny.length) {
    objects.push({ id: atlas.variant(oaksAny, 5, 5), gx: 19, gy: 21 });
    objects.push({ id: atlas.variant(oaksAny, 9, 3), gx: 27, gy: 23 });
    objects.push({ id: atlas.variant(oaksAny, 2, 8), gx: 16, gy: 33 });
  }

  // ---- props ---------------------------------------------------------------
  const lamp = atlas.first('lamp_post', 'lantern_hanging');
  const campfire = atlas.first('campfire');
  const well = atlas.first('well_stone');
  const scarecrow = atlas.first('scarecrow');
  const hay = atlas.first('hay_bale');
  const barrel = atlas.first('barrel');
  const crate = atlas.first('crate');
  const mailbox = atlas.first('mailbox');
  const sign = atlas.first('signpost');
  const logpile = atlas.first('log_pile');
  const flowers = atlas.first('flower_pot');
  const wheelbarrow = atlas.first('wheelbarrow');
  const beehive = atlas.first('beehive');
  const trough = atlas.first('water_trough');

  const prop = (id, gx, gy) => { if (id) { objects.push({ id, gx, gy }); } };

  prop(well, 15, 27);
  prop(scarecrow, 10, 26);
  prop(scarecrow, 12, 30);
  prop(hay, 34, 30);
  prop(hay, 33, 31);
  prop(barrel, 28, 30);
  prop(crate, 29, 30);
  prop(mailbox, 24, 22);
  prop(sign, 26, 19);
  prop(logpile, 18, 35);
  prop(campfire, 20, 32);
  prop(trough, 27, 30);
  prop(beehive, 15, 29);
  prop(wheelbarrow, 16, 27);
  prop(flowers, 16, 22);
  prop(flowers, 17, 22);
  prop(flowers, 22, 30);
  // lamps lining the path down to the farm
  for (const [lx, ly] of [[18, 29], [22, 22], [27, 18], [30, 22], [12, 36]]) prop(lamp, lx, ly);

  return { w, h, ground, objects, house };
}

// (the tile-kit house builder that used to live here was removed: interiors are
//  now a separate scene at their own scale — see src/interior.js)

/** Full world: a procedurally wooded hinterland with the authored farm dropped
 *  into the middle. Everything stays deterministic — same atlas, same scene. */
export function makeScene(atlas) {
  const inner = buildComposition(atlas);
  let house = inner.house;
  const w = MAP_W, h = MAP_H;
  const ox = Math.floor((w - inner.w) / 2);
  const oy = Math.floor((h - inner.h) / 2);
  const rng = makeRng(90210);

  const grassIds = ['g_grass', 'g_grass_b', 'g_grass_c', 'g_grass_d']
    .map((k) => atlas.first(k)).filter(Boolean);
  const tall = atlas.first('g_grass_tall');
  const flower = atlas.first('g_grass_flower');

  const ground = new Array(w * h).fill(null);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = rng();
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (edge < 5) ground[y * w + x] = tall || atlas.variantW(grassIds, [0.25, 0.25, 0.25, 0.25], x, y);
      else if (n < 0.11 && tall) ground[y * w + x] = tall;
      else if (n < 0.15 && flower) ground[y * w + x] = flower;
      else ground[y * w + x] = atlas.variantW(grassIds, [0.28, 0.27, 0.23, 0.22], x, y);
    }
  }

  // blit the authored farm over the hinterland
  const objects = [];
  for (let y = 0; y < inner.h; y++) {
    for (let x = 0; x < inner.w; x++) {
      const g = inner.ground[y * inner.w + x];
      if (g) ground[(y + oy) * w + (x + ox)] = g;
    }
  }
  for (const o of inner.objects) objects.push({ ...o, gx: o.gx + ox, gy: o.gy + oy });

  // ---- wooded ring: denser toward the outside so the horizon reads as forest,
  //      with a clearing around the farm so it never feels hemmed in
  const oaks = atlas.byCat('tree').filter((k) => k.includes('oak'));
  const pines = atlas.byCat('tree').filter((k) => k.includes('pine'));
  const birch = atlas.byCat('tree').filter((k) => k.includes('birch'));
  const bush = atlas.byCat('tree').filter((k) => k.includes('bush'));
  const rock = atlas.byCat('tree').filter((k) => k.includes('rock') || k.includes('boulder'));
  const autumn = atlas.first('tree_autumn');
  const stump = atlas.first('tree_stump');

  const occupied = new Uint8Array(w * h);
  for (const o of objects) {
    const sp = atlas.get(o.id);
    if (!sp) continue;
    for (let y = o.gy; y < o.gy + sp.fp[1]; y++) {
      for (let x = o.gx; x < o.gx + sp.fp[0]; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h) occupied[y * w + x] = 1;
      }
    }
  }
  const inClearing = (x, y) => {
    const dx = x - (ox + inner.w / 2), dy = y - (oy + inner.h / 2);
    return Math.hypot(dx, dy * 1.15) < inner.w * 0.62;
  };
  const scatter = (ids, n, test) => {
    if (!ids.length) return;
    let placed = 0, tries = 0;
    while (placed < n && tries < n * 80) {
      tries++;
      const x = 2 + Math.floor(rng() * (w - 4));
      const y = 2 + Math.floor(rng() * (h - 4));
      if (occupied[y * w + x]) continue;
      if (!test(x, y)) continue;
      const g = ground[y * w + x];
      if (!g || !g.startsWith('g_grass')) continue;
      objects.push({ id: atlas.variant(ids, x, y), gx: x, gy: y });
      occupied[y * w + x] = 1;
      placed++;
    }
  };

  const outer = (x, y) => !inClearing(x, y);
  scatter(pines, 130, outer);
  scatter(oaks, 90, outer);
  scatter(birch, 45, outer);
  scatter(pines, 26, (x, y) => !inClearing(x, y) && Math.min(x, y, w - 1 - x, h - 1 - y) < 12);
  if (autumn) scatter([autumn], 22, outer);
  scatter(bush, 70, (x, y) => !occupied[y * w + x]);
  scatter(rock, 34, () => true);
  if (stump) scatter([stump], 12, outer);

  // dirt trails leading away from the farm toward the map edges, so the world
  // reads as connected to somewhere else rather than as an island
  const pathId = atlas.first('g_path_sand', 'g_path_sand_b');
  if (pathId) {
    const trail = (x0, y0, dx, dy, len) => {
      for (let s = 0; s < len; s++) {
        const tx = Math.round(x0 + dx * s), ty = Math.round(y0 + dy * s);
        if (tx >= 0 && ty >= 0 && tx < w && ty < h) ground[ty * w + tx] = pathId;
        const bx = tx + (dx ? 0 : 1), by = ty + (dx ? 1 : 0);
        if (bx >= 0 && by >= 0 && bx < w && by < h) ground[by * w + bx] = pathId;
      }
    };
    trail(ox + 1, oy + 30, -1, -1, 11);
    trail(ox + inner.w - 2, oy + inner.h - 3, 1, 1, 11);
  }

  // move the house record into world space so the runtime can build its volume
  if (house) {
    house = {
      ...house,
      x0: house.x0 + ox, y0: house.y0 + oy,
      door: [house.door[0] + ox, house.door[1] + oy],
      bounds: [house.x0 + ox, house.y0 + oy, house.x0 + ox + house.w, house.y0 + oy + house.d],
    };
    delete house.walls;
    delete house.roof;
  }

  return { w, h, ground, objects, house };
}

/** group crop sprite ids by base name: crop_turnip -> [stage0..stage4] */
function cropIds(atlas) {
  const byName = new Map();
  for (const id of atlas.byCat('crop')) {
    const m = /^(.*?)_(\d)$/.exec(id);
    if (!m) continue;
    if (!byName.has(m[1])) byName.set(m[1], []);
    byName.get(m[1])[+m[2]] = id;
  }
  for (const [k, v] of [...byName]) {
    if (v.filter(Boolean).length < 5) byName.delete(k);
  }
  return byName;
}

// ---------------------------------------------------------------- agents
/**
 * Characters. `dir` is one of 4 baked facings and maps straight onto the world
 * axes: 0 = +x, 1 = +y, 2 = -x, 3 = -y (the character module yaws the mesh by
 * dir * 90 degrees about the anchor, which is exactly what the offline
 * renderer's rotMesh does, so the atlas slots line up).
 */
export function makeAgents(scene) {
  const h = scene && scene.house;
  const agents = [
    {
      name: 'WREN', x: 22.6, y: 19.4, dir: 1, action: 'walk', frame: 0, ft: 0,
      speed: 1.7, pause: 0,
      route: [[22.6, 19.4], [30.2, 19.4], [30.2, 25.6], [24.6, 25.6], [24.6, 21.6], [22.6, 21.6]],
      wp: 0,
    },
    {
      name: 'ILSA', x: 20.2, y: 24.6, dir: 3, action: 'idle', frame: 0, ft: 0,
      speed: 0, pause: 1.0, actTimer: 2.4,
      actCycle: ['idle', 'water'], actAt: 0,
      route: null, wp: 0,
    },
    {
      name: 'ODA', x: 9.6, y: 26.4, dir: 0, action: 'hoe', frame: 0, ft: 0,
      speed: 0, pause: 0.6, actTimer: 1.6,
      actCycle: ['hoe', 'harvest', 'idle'], actAt: 0,
      route: null, wp: 0,
    },
    {
      name: 'PIP', x: 27.4, y: 30.2, dir: 2, action: 'walk', frame: 0, ft: 0,
      speed: 1.25, pause: 0,
      route: [[27.4, 30.2], [33.4, 30.2], [33.4, 34.6], [27.4, 34.6]],
      wp: 0,
    },
  ];
  // someone pottering about inside, so the lit room has a life in it
  if (h) {
    const cx = h.x0 + 2.5, cy = h.y0 + 3.5;
    agents.push({
      name: 'MOSS', x: cx, y: cy, dir: 0, action: 'idle', frame: 0, ft: 0,
      speed: 0, pause: 0.8, actTimer: 1.2, indoor: true,
      actCycle: ['idle', 'harvest', 'idle', 'water'], actAt: 0,
      route: [
        [h.x0 + 1.4, h.y0 + 3.4], [h.x0 + 3.4, h.y0 + 3.4],
        [h.x0 + 3.6, h.y0 + 1.4], [h.x0 + 1.4, h.y0 + 1.4],
      ],
      wp: 0,
    });
  }
  return agents;
}

/** advance one agent; returns nothing, mutates in place */
export function stepAgent(a, dt, fps) {
  if (a.route && a.route.length) {
    if (a.pause > 0) { a.pause -= dt; a.action = 'idle'; a.ft += dt; return; }
    const tgt = a.route[a.wp];
    const dx = tgt[0] - a.x, dy = tgt[1] - a.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.06) {
      a.wp = (a.wp + 1) % a.route.length;
      a.pause = 0.35 + ((a.wp * 37) % 11) * 0.09;   // deterministic little beat
      return;
    }
    const step = Math.min(d, a.speed * dt);
    a.x += (dx / d) * step;
    a.y += (dy / d) * step;
    a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
    a.action = 'walk';
    a.ft += dt;
    return;
  }
  // stationary: cycle through a short list of actions with pauses in between
  a.actTimer -= dt;
  a.ft += dt;
  if (a.actTimer <= 0) {
    a.actAt = (a.actAt + 1) % (a.actCycle?.length ?? 1);
    a.action = a.actCycle ? a.actCycle[a.actAt] : (a.action ?? 'idle');
    a.actTimer = a.action === 'idle' ? 2.2 + (a.x % 3) * 0.4 : 1.4;
  }
  if (!a.actCycle) a.action = a.action || 'idle';
}

// ---------------------------------------------------------------- lights
// Point lights attached to placed objects. Matching is by id substring and the
// list is ORDERED: the first rule that matches wins, so the specific interior
// fixtures have to come before the generic `lamp`.
const LIGHT_RULES = [
  { match: 'chandelier', at: [0.5, 0.5, 2.15], color: [1.0, 0.80, 0.50], radius: 7.5, intensity: 1.25, flicker: 0.02, night: true },
  { match: 'hanging_lamp', at: [0.5, 0.5, 2.05], color: [1.0, 0.80, 0.50], radius: 7.0, intensity: 1.20, flicker: 0.02, night: true },
  { match: 'oil_lamp', at: [0.5, 0.5, 0.95], color: [1.0, 0.76, 0.42], radius: 5.5, intensity: 0.85, flicker: 0.05, night: true },
  { match: 'candle', at: [0.5, 0.5, 0.95], color: [1.0, 0.72, 0.38], radius: 4.0, intensity: 0.60, flicker: 0.11, night: true },
  { match: 'fireplace', at: [0.5, 0.5, 0.60], color: [1.0, 0.50, 0.19], radius: 8.0, intensity: 1.75, flicker: 0.20, night: false },
  { match: 'stove', at: [0.5, 0.4, 0.85], color: [1.0, 0.54, 0.22], radius: 6.0, intensity: 1.20, flicker: 0.14, night: false },
  { match: 'lantern', at: [0.5, 0.5, 1.6], color: [1.0, 0.78, 0.45], radius: 6.0, intensity: 0.9, flicker: 0.03, night: true },
  { match: 'lamp_post', at: [0.5, 0.5, 2.05], color: [1.0, 0.80, 0.48], radius: 8.0, intensity: 1.15, flicker: 0.02, night: true },
  { match: 'campfire', at: [0.5, 0.5, 0.35], color: [1.0, 0.52, 0.20], radius: 7.0, intensity: 1.5, flicker: 0.22, night: true },
  { match: 'greenhouse', at: [1.5, 2.0, 1.7], color: [1.0, 0.62, 0.32], radius: 9.0, intensity: 1.1, flicker: 0.0, night: true },
  { match: 'farmhouse', at: [2.4, 2.0, 1.4], color: [1.0, 0.72, 0.40], radius: 7.0, intensity: 0.8, flicker: 0.0, night: true },
  // the house itself glows through its own windows after dark
  { match: '__house_window_w', at: [0.5, 0.5, 1.3], color: [1.0, 0.74, 0.42], radius: 4.5, intensity: 0.55, flicker: 0.0, night: true },
];

/**
 * Build the point-light list for a scene.
 *
 * Besides the lamps attached to props, this emits a **portal light** just inside
 * every window and doorway. A window is a hole in a wall, and the deferred
 * lighting has no idea that the daylit world outside should be pouring through
 * it; without these the interior is a black box with one bright sliver. Each
 * portal is scaled by how squarely its opening faces the sun, so the fill in a
 * room tracks the time of day exactly like the sun patch does.
 *
 * @param night 0..1 — how "on" the artificial lights are
 * @param time  seconds, drives flicker
 * @param sky   { sunDir, skyColor, sunColor, sunGain, ambGain }
 */
export function collectLights(scene, night, time, sky, rules = LIGHT_RULES) {
  const out = [];
  for (const o of scene.objects) {
    for (const r of rules) {
      if (!o.id.includes(r.match)) continue;
      const k = r.night ? night : 1;
      if (k < 0.02) break;
      const fl = r.flicker > 0
        ? 1 + r.flicker * (Math.sin(time * 9.1 + o.gx * 3.7) * 0.6 + Math.sin(time * 23.7 + o.gy * 2.3) * 0.4)
        : 1;
      out.push({
        kind: 'fixture',
        x: o.gx + r.at[0], y: o.gy + r.at[1], z: r.at[2],
        r: r.color[0], g: r.color[1], b: r.color[2],
        radius: r.radius, intensity: r.intensity * k * fl,
      });
      break;
    }
  }

  // ---- window / doorway portals
  if (sky && scene.portals !== false) {
    const s = sky.sunDir;
    const sl = Math.hypot(s[0], s[1]) || 1;
    const sx = s[0] / sl, sy = s[1] / sl;
    const open = 1 - night;                   // how much daylight is available
    for (const o of scene.objects) {
      const isWin = o.id === 'wall_window' || o.id === 'wall_window_tall';
      const isDoor = o.id === 'wall_door' || o.id === 'wall_int_door';
      if (!isWin && !isDoor) continue;
      const rot = o.rot || 0;
      // outward normal of the wall edge this piece sits on
      const outN = rot === 0 ? [0, 1] : rot === 2 ? [0, -1] : rot === 3 ? [1, 0] : [-1, 0];
      // A window admits the whole sky hemisphere, not just the sun disc, so the
      // fill has a large floor that does not depend on where the sun is; the
      // sun-facing term is a bonus on top. Making it purely sun-facing left
      // every window that faces away from the sun contributing exactly nothing,
      // which is why the room went black on one side of noon.
      //
      // `facing` is how squarely the opening looks AT the sun, so it is the dot
      // product of the outward normal with the sun's horizontal direction — NOT
      // its negation, which is what it used to be. With the sign flipped the
      // bonus went to the windows in shadow and the sunlit wall got the floor
      // value, which is why the fill always felt like it came from the wrong
      // side of the room.
      const facing = Math.max(0, outN[0] * sx + outN[1] * sy);
      // NB: this was called `sky`, which shadowed the sky COLOUR passed in — so
      // every portal in the game came out white. One word, and the whole room
      // lost its time of day.
      const admit = 0.55 + 0.45 * facing * Math.max(0, s[2]);
      const gain = isDoor ? 1.7 : 1.0;
      const strength = admit * open * gain;
      if (strength < 0.015) continue;
      // the portal sits a little way into the room so it does not light the
      // outside of its own wall
      const inx = -outN[0] * 0.55, iny = -outN[1] * 0.55;
      const col = sky.skyColor || [1, 1, 1];
      const warm = sky.sunColor || [1, 1, 1];
      const mixK = isDoor ? 0.35 : 0.15;
      out.push({
        kind: 'portal',
        x: o.gx + 0.5 + inx, y: o.gy + 0.5 + iny, z: isDoor ? 0.9 : 1.30,
        r: col[0] * (1 - mixK) + warm[0] * mixK,
        g: col[1] * (1 - mixK) + warm[1] * mixK,
        b: col[2] * (1 - mixK) + warm[2] * mixK,
        // a wide, soft fill: a tight one would read as a lamp sitting in the
        // window frame rather than as daylight arriving through it
        radius: isDoor ? 8.0 : 7.4,
        intensity: strength * 4.6,
      });
    }
  }
  return out;
}
