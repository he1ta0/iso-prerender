// The UPPER floor — a second interior scene, on the same engine as the first.
//
// This is a NEW MAP, not a remake: the ground floor (src/interior.js) is
// untouched by it, and the two share only the plumbing in roomKit() — the wall
// runs, the placement helpers, and the code that stamps architecture into the
// light volume. Everything below is the plan, the way the ground floor's plan is
// the plan.
//
// Deliberately unlike the ground floor, because a second storey that rhymes too
// closely proves nothing about whether the renderer generalises:
//
//   * 9x7 instead of 11x9. A different footprint is the cheapest way to find a
//     hard-coded 11 or 9 anywhere in the camera, the volume or the cut-away.
//   * a stairwell — two tiles with NO floor sprite at all. A hole is the
//     sharpest depth test this renderer has: nothing there writes depth, the
//     light pass has no surface to shade, and the ghost/opaque split has to
//     stay correct around its edges.
//   * open ground. The ground floor answers a fixed camera with a plan that
//     keeps everything low and out of the way; this one is a loft, so the room
//     is mostly air and the furniture gathers around the walls the way it does
//     in a real attic.
//   * floor material that changes use: dark boards through the sleeping third,
//     light boards over the living half, flagstone at the head of the stairs.
//
// The one piece of new architecture is `wall_stub` — a 0.46-high knee wall used
// as the stair rail. It is placed WITHOUT the camera-side `cut` flag that the
// four runs carry (see the note at the rail, below): a rail is knee-high, it
// hides nothing, and a rail that vanishes when the walls are cut away would be
// the room quietly telling you it does not understand its own cutaway.

import { roomKit, finishRoom } from './interior.js';

export const UPPER_W = 9;
export const UPPER_D = 7;

/** where the stairs come up: two tiles with no floor at all */
export const STAIRWELL = [[3, 4], [4, 4]];

/**
 * @param atlas the INTERIOR atlas (48x24 tiles)
 * @returns {{w,h,ground,objects,door,marks,bounds,scale}}
 */
export function makeUpperInterior(atlas) {
  const K = roomKit(atlas, { w: UPPER_W, h: UPPER_D, seed: 24417 });
  if (!K) return null;
  const { w, h, ground, floors, stone, F, place, furn, under, over, wall, CAM_SIDE } = K;

  // ---- floor ---------------------------------------------------------------
  // Boards, but not the ground floor's checker: the sleeping third is laid in
  // the darker board and the living half in the lighter one, so the change of
  // material draws the line between "where you sleep" and "where you are".
  //
  // The stairwell is OUT IN THE ROOM, not tucked against a wall. It started
  // against the -x wall and was invisible: a wall piece is drawn as a sprite
  // 2.2 units tall whose bottom edge covers its own tile AND the first few
  // pixels of the next one, so a hole at the wall's foot is painted over by the
  // wall. Two tiles of floor with nothing in them, a ring of flagstone and a
  // knee wall are what a stair opening looks like from above.
  const hole = new Set(STAIRWELL.map(([x, y]) => `${x},${y}`));
  const isStone = (x, y) => (y === 3 && x >= 2 && x <= 4)      // the landing behind
    || (x === 2 && y >= 3 && y <= 5)                            // ...and down its left
    || (y === 5 && x >= 3 && x <= 4);                           // ...and in front
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (hole.has(`${x},${y}`)) continue;             // the stairwell: no floor
      let g = x <= 2 ? floors[1] : floors[0];
      if (stone && isStone(x, y)) g = stone;
      ground[y * w + x] = g;
    }
  }

  // ---- perimeter ------------------------------------------------------------
  //
  // Same convention as downstairs, and for the same reason: the runs the camera
  // stands outside of (+x, +y) are the ones that carry the tall openings, so the
  // light that reaches the floor arrives through the walls that are ghosted
  // rather than through walls you cannot see. Here it is a LOFT, so there are
  // fewer and smaller openings than downstairs: the back run gets two casements
  // and the left run a casement plus an arch — and that arch is deliberately the
  // one over the stairwell, so the light comes down the stairs.
  //
  //   -y  backdrop, seen head-on   casement x2 at 1 and 7
  //   -x  backdrop, seen at angle  casement at y=2, ARCH at y=4 (over the well)
  //   +y  light wall (ghosted)     FRENCH at 2 + ARCH at 5
  //   +x  light wall (ghosted)     FRENCH at y=0 and y=4
  const winBack = new Set([1, 7]);
  const winLeft = new Set([2]);
  const archLeft = new Set([4]);
  const winFront = new Set([2]);
  const archFront = new Set([5]);
  const winRight = new Set([0, 4]);

  for (let i = 0; i < w; i++) {
    const back = winBack.has(i) ? 'wall_window' : 'wall_solid';
    const front = winFront.has(i) ? 'wall_window_tall'
      : archFront.has(i) ? 'wall_window_arch' : 'wall_solid';
    place(back, i, 0, 2);
    place(front, i, h - 1, 0, null, 0, { cut: CAM_SIDE['+y'] });
  }
  for (let j = 0; j < h; j++) {
    const left = winLeft.has(j) ? 'wall_window'
      : archLeft.has(j) ? 'wall_window_arch' : 'wall_solid';
    const right = winRight.has(j) ? 'wall_window_tall' : 'wall_solid';
    place(left, 0, j, 1);
    place(right, w - 1, j, 3, null, 0, { cut: CAM_SIDE['+x'] });
  }

  // ---- the stair rail -------------------------------------------------------
  // `wall_stub` is a knee wall (0.46 high, and its volume mark is a 0.36-high
  // slab, so sunlight still pours over it into the well). It is placed with NO
  // cut flag on purpose: the four runs are declared cut because they are
  // full-height walls standing between the camera and the room, and a rail that
  // disappeared in the cut-away modes would leave the stairwell unguarded with no
  // way to tell that anything had been removed.
  //
  // rot 2 puts the rail's body on the FAR edge of its tile (the same orientation
  // the back wall run uses), so it stands at the top of the opening and is not
  // drawn across the hole it is guarding.
  const stub = F('wall_stub');
  if (stub) {
    place(stub, 3, 3, 2);
    place(stub, 4, 3, 2);
  }

  // ---- the plan -------------------------------------------------------------
  //
  //   back-left    the bed nook    — cot, chest, nightstand, rug, clock above
  //   back-centre  the desk        — desk, chair, stool, a painting overhead
  //   back-right   the little one  — cradle, rocker, wardrobe, dresser, plant
  //   centre       the worktable   — round rug, table, two chairs, lamp and
  //                                  chandelier over it
  //   front-left   the stair head  — rail, lantern, flagstone
  //
  // The two rules the ground floor's plan follows apply here too, and for the
  // same reasons (a top-down plan hides both):
  //
  //   1. NOTHING TALL STANDS IN FRONT OF A WALL PIECE — the column in front of
  //      the bookshelf and the row in front of the back windows are left clear.
  //   2. HUNG THINGS GO ON A WALL THAT CAN CARRY THEM — the clock and the
  //      painting hang on solid tiles, and every curtain hangs on a window.
  const cot = F('furn_bed_cot');  const chest = F('furn_chest');
  const nightstand = F('furn_nightstand');
  const rug_small = F('furn_rug_small');
  const rug_round = F('furn_rug_round');
  const bookshelf = F('furn_bookshelf');
  const desk = F('furn_desk');
  const chair = F('furn_chair');
  const stool = F('furn_stool');
  const cradle = F('furn_cradle');
  const rocker = F('furn_rocker');
  const wardrobe = F('furn_wardrobe');
  const dresser = F('furn_dresser');
  const table = F('furn_table');
  const plant = F('furn_plant');
  const lantern = F('furn_lantern');
  const candles = F('furn_candles');
  const oil_lamp = F('furn_oil_lamp');
  const chandelier = F('furn_chandelier');
  const crate = F('furn_crate');
  const sack = F('furn_sack');
  const painting = F('furn_painting');
  const clock = F('furn_clock');
  const curtain = F('furn_curtain');
  const bench = F('furn_bench');

  // ---- the bed nook, back-left ---------------------------------------------
  furn(chest, 0, 0, 0);
  furn(cot, 0, 1, 0);                  // 1x2, head to the wall: (0,1)-(0,2)
  furn(nightstand, 1, 1, 0);
  under(rug_small, 1, 2, 0);
  wall(clock, 1, '-x');                // above the cot, on solid wall

  // ---- the desk, back-centre -----------------------------------------------
  wall(bookshelf, 2, '-y');            // 2x1: (2,0)-(3,0); row 1 in front stays clear
  furn(desk, 5, 0, 0);                 // 2x1: (5,0)-(6,0)
  furn(chair, 5, 1, 2);                // pulled up to it, facing -y
  wall(painting, 4, '-y');             // the one solid tile between desk and shelf
  furn(stool, 4, 1, 0);                // under the painting: low enough to sit under it

  // ---- the little one's corner, back-right ---------------------------------
  // Cradle and rocker, pulled up together. They started on the far side of the
  // stool and the wardrobe, which walled off the back corner (7,0) — the flood
  // fill in check-interior named it, and this is the layout that answers it.
  furn(crate, 8, 0, 0);
  furn(cradle, 7, 2, 0);
  furn(wardrobe, 8, 1, 0);
  furn(plant, 8, 2, 0);
  furn(rocker, 6, 4, 2);               // facing -y, looking down the loft
  furn(dresser, 8, 3, 0);
  furn(plant, 8, 4, 0);                // standing in the tall window
  furn(sack, 8, 5, 0);

  // ---- the worktable, centre -----------------------------------------------
  under(rug_round, 4, 2, 0);           // declared under, so it cannot float
  furn(table, 4, 2, 0);                // 2x2: (4,2)-(5,3)
  furn(chair, 3, 2, 3);                // facing +x, into the table
  // The second chair sits on the NEAR side of the table. Pulled up to its right
  // instead, it closed a ring with the stool, the rocker and the dresser and left
  // four tiles the flood fill could not reach from the stair head — which is
  // exactly the kind of thing a plan drawn on paper never shows.
  furn(chair, 5, 4, 2);                // facing -y, into the table
  // The lamp goes ON the table, at the tabletop's real height — the same
  // statement the ground floor makes, and the reason its light rule (which is
  // written for a lamp at floor level + TABLE_TOP) is correct on both floors.
  over(oil_lamp, 4, 2, 0, 0.88);
  over(chandelier, 4.5, 2.5, 0);

  // ---- the stair head, centre-front ----------------------------------------
  // The way down is at (3,4)-(4,4) with its rail behind it; the flagstone ring
  // and the lantern are what make it read as an opening rather than as a hole in
  // the renderer. `door` is the stair head, because upstairs that IS the door.
  furn(lantern, 2, 4, 0);              // the light you carried up
  furn(candles, 2, 5, 0);
  furn(bench, 2, 6, 0);                // 2x1 under the tall window
  furn(candles, 1, 6, 0);

  // ---- windows dressed ------------------------------------------------------
  wall(curtain, 1, '-y');
  wall(curtain, 7, '-y');
  wall(curtain, 2, '-x');
  wall(curtain, 2, '+y');
  wall(curtain, 5, '+y');

  return finishRoom(K, { door: [3, 4] });   // the stair head is this floor's door
}

