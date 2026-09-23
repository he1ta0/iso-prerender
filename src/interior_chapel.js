// THE CHAPEL —the third interior map, on the same engine as the other two.
//
// This is a NEW MAP, not a remake. src/interior.js (the ground floor) is not
// touched by it; src/interior_upper.js (the loft) is not touched by it either.
// All three share exactly one thing: `roomKit()` plus `finishRoom()` —the wall
// runs, the placement helpers, and the code that stamps architecture into the
// transmittance volume. Everything below is the plan, in the same sense that the
// ground floor's plan is the plan.
//
// WHAT IS ACTUALLY NEW HERE
//
//   15 x 11 tiles against 11 x 9 and 9 x 7, and 4.2 units to the wall top
//   against 2.2 —roughly four times the enclosed volume of the loft, and the
//   first room in the project whose walls are taller than the camera's own step
//   between floors. It is the honest test of whether "a room" is a data shape
//   here or whether 2.2 was baked into something.
//
//   A COLONNADE. Ten free-standing piers split the 15-tile width into a nave of
//   five tiles with two aisles either side. Piers are `cat: 'wall'`, so they are
//   stamped into the volume: sunlight walking in through the right-hand aisle
//   windows is interrupted by them and stripes the nave floor, which is the
//   single biggest reason the room reads as a building rather than as a mural.
//
//   STAINED GLASS. The five-colour windows in tools/models/chapel.mjs carry a
//   per-pane light tint, and the tint is what the light march multiplies into
//   the sun. This map is arranged so those colours land where the camera can see
//   them: every great window is on the +x or +y run, because the sun is on that
//   side all day (sunAzimuth) and a window on the far side is a window the sun
//   never reaches. The far runs still carry glass —a chapel has windows on four
//   walls —but what they contribute is the look of the thing, not the light.
//
//   A CHANCEL. The back third of the nave is paved in mosaic rather than marble,
//   with the altar, the two candelabra and the reading desk on it, and the rose
//   window over the altar. A chequer of pale and dark marble draws the nave; the
//   aisles are plain.
//
// ONE NUMBER IN HERE IS COUPLED TO THE MODELS, and it is worth being loud about:
//
//   CHAPEL_H must equal `CH` in tools/models/chapel.mjs.
//
// CHAPEL_H is where the ceiling is stamped; CH is how tall the wall pieces are
// drawn. If the ceiling is stamped below the top of the walls, the sun leaks in
// over them at a shallow angle and the room is lit like a barn. tools/check-
// interior.mjs now measures the placed wall pieces against this number and says
// so, because a comment is not a check.

import { roomKit, finishRoom } from './interior.js';

export const CHAPEL_W = 15;
export const CHAPEL_D = 11;
export const CHAPEL_H = 4.2;        // === CH in tools/models/chapel.mjs

/** the pier line, in world units: aisle | nave | aisle */
export const PIER_X = [4.5, 9.5];
/**
 * The rows the piers stand on. Pews go on the rows BETWEEN them, and the two
 * rows at either end of the colonnade are kept clear — those are the
 * cross-aisles, and they are the only way into the side aisles (see the pew
 * note in the plan below).
 *
 * It starts at row 3 rather than row 1 so that the chancel end of the room is
 * open: a pier in row 1 would stand beside the altar with a one-tile pocket on
 * each side of it, which is a corner nobody can walk into and every flood fill
 * reports as stranded floor.
 */
export const PIER_ROWS = [3, 5, 7, 9];
/** the west door, on the +y run */
export const DOOR_X = 7;   // 'door' is a TILE, not a world position: main.js tests it as d[0]+0.5

/**
 * @param atlas the INTERIOR atlas (48x24 tiles)
 * @returns {{w,h,ground,objects,door,marks,bounds,scale}}
 */
export function makeChapelInterior(atlas) {
  const K = roomKit(atlas, { w: CHAPEL_W, h: CHAPEL_D, seed: 31517 });
  if (!K) return null;
  const { w, h, ground, place, furn, under, over, wall, CAM_SIDE, atlas: A } = K;

  // ---- floor ---------------------------------------------------------------
  // Three pavings, laid as three statements about the plan:
  //
  //   the aisles   plain pale marble, because they are circulation
  //   the nave     a chequer of pale and dark, because it is the room
  //   the chancel  mosaic, because it is the end of the room
  //
  // A chequer needs no new asset: it is two floor tiles alternating, which is
  // how the ground floor's stone floor and the loft's boards already work.
  const marble = A.first('floor_marble');
  const marbleDk = A.first('floor_marble_dk');
  const mosaic = A.first('floor_mosaic');
  const stone = A.first('floor_stone');
  const isChancel = (x, y) => y <= 1 && x >= 5 && x <= 9;
  const isNave = (x) => x >= 5 && x <= 9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let g = marble || stone;
      if (isChancel(x, y) && mosaic) g = mosaic;
      else if (isNave(x) && marbleDk && (x + y) % 2 === 0) g = marbleDk;
      ground[y * w + x] = g;
    }
  }

  // ---- perimeter ------------------------------------------------------------
  //
  // The two runs the camera stands outside of (+x, +y) are the ones that can
  // catch the sun, so they get the GREAT windows —the wide three-light ones,
  // whose patch is three pencils of colour rather than one. The two backdrop
  // runs get lancets and, at the centre of the back wall, the rose.
  //
  //   -y  backdrop, seen head-on   lancet 1, 5, 9, 13 + ROSE at 7
  //   -x  backdrop, seen at angle  lancet at y = 2, 5, 8
  //   +y  light wall (ghosted)     GREAT at 3 and 11, the west door at 7
  //   +x  light wall (ghosted)     GREAT at y = 2, 5, 8
  const lancet = K.F('wall_stone_lancet');
  const great = K.F('wall_stone_great');
  const rose = K.F('wall_stone_rose');
  const solid = K.F('wall_stone');
  const doorW = K.F('wall_door_chapel');

  const backLancet = new Set([1, 5, 9, 13]);
  const backRow = (i) => (i === DOOR_X ? rose : (backLancet.has(i) ? lancet : solid));
  const frontGreat = new Set([3, 11]);
  const frontRow = (i) => (i === DOOR_X ? doorW : (frontGreat.has(i) ? great : solid));
  const sideLancet = new Set([2, 5, 8]);
  const sideGreat = new Set([2, 5, 8]);

  for (let i = 0; i < w; i++) {
    place(backRow(i), i, 0, 2);
    place(frontRow(i), i, h - 1, 0, null, 0, { cut: CAM_SIDE['+y'] });
  }
  for (let j = 0; j < h; j++) {
    place(sideLancet.has(j) ? lancet : solid, 0, j, 1);
    place(sideGreat.has(j) ? great : solid, w - 1, j, 3, null, 0, { cut: CAM_SIDE['+x'] });
  }

  // ---- the colonnade --------------------------------------------------------
  // Placed at a HALF-TILE x, on purpose: the pier line is the boundary between
  // the aisle and the nave, and a pier centred on tile 5 would stand inside the
  // nave and clip the end of every pew. `place` takes world units, so the
  // colonnade is written where it actually is.
  //
  // No cut flag: a pier is architecture, but it is not BETWEEN the camera and
  // the room the way a wall run is, and a colonnade that faded in and out as the
  // camera moved would be worse than one that occasionally overlaps a pew.
  const pier = K.F('wall_column');
  if (pier) for (const px of PIER_X) for (const py of PIER_ROWS) place(pier, px, py, 0);

  // ---- the plan -------------------------------------------------------------
  //
  //   back  y 0-1  the chancel   altar, candelabra, the rose over it, mosaic
  //   y 2          the desk      lectern + a bench, in front of the chancel
  //   y 3-9        the nave      four bays of pews, aisle down the middle (x = 7)
  //   aisles       the font, the stores, a bench by the door
  //
  // Two rules the other two plans already follow, for the same reasons:
  //
  //   1. NOTHING TALL STANDS IN FRONT OF AN APERTURE. The tiles in front of the
  //      great windows are left clear, because a window whose patch of light
  //      lands on the back of a wardrobe is a window that has been wasted.
  //   2. A hanging piece goes on a wall that can carry it.
  const altar = K.F('furn_altar');
  const candelabra = K.F('furn_candelabra');
  const lectern = K.F('furn_lectern');
  const font = K.F('furn_font');
  const pew = K.F('furn_pew');
  const banner = K.F('furn_banner');
  const bench = K.F('furn_bench');
  const plant = K.F('furn_plant');
  const crate = K.F('furn_crate');
  const chest = K.F('furn_chest');
  const candles = K.F('furn_candles');
  const lantern = K.F('furn_lantern');
  const rug = K.F('furn_rug_small');
  const sack = K.F('furn_sack', 'furn_plant');

  // ---- the chancel ----------------------------------------------------------
  // The altar is centred on the rose: the window is at tile 7, so its centre is
  // x = 7.5, and an altar placed at 6.5 with a footprint of 2 is centred on 7.5.
  furn(altar, 6.5, 0.7, 0);
  furn(candelabra, 3.4, 0.4, 0);
  furn(candelabra, 11.6, 0.4, 0);
  under(rug, 6, 1, 0);

  // ---- the desk -------------------------------------------------------------
  // Beside the altar, in the chancel, facing down the nave. It sits hard against
  // the pier line on purpose: the reading desk belongs to the priest's side of
  // the room, not out in the circulation.
  furn(lectern, 5.1, 0.4, 0);

  // ---- the nave: three bays of pews -----------------------------------------
  // Pews go on the rows the piers are NOT on, and — this is the part that took a
  // flood fill to find — the rows at either END of the bank are left clear.
  //
  // A nave 5 tiles wide with a 1-tile centre aisle leaves exactly 2 tiles each
  // side for a bench, so the pews touch the colonnade line on one side and the
  // aisle on the other, and a bank of them from row 4 to row 8 leaves the two
  // SIDE aisles reachable only by walking the length of the nave and back. The
  // first version of this plan did that, and `check-interior` reported 62 of 84
  // walkable tiles stranded behind the pews: the aisles existed, were floored,
  // were lit, and could not be reached.
  //
  // Rows 2 and 10 are therefore the cross-aisles — the way in and out of the
  // pews, and the reason the side aisles connect to the door at all. Nothing
  // that blocks a tile goes on either of them.
  for (const row of [4, 6, 8]) {
    furn(pew, 5, row, 0);
    furn(pew, 8, row, 0);
  }

  // ---- the aisles -----------------------------------------------------------
  // The tiles in front of the great windows (x = 14, y = 2, 5, 8 and x = 3 / 11,
  // y = 10) are deliberately empty, and the two cross-aisle rows are clear across
  // the full width.
  //
  // A word on where aisle furniture is allowed to stand. A nave 5 tiles wide
  // leaves exactly 2 tiles for a bench either side of a 1-tile centre aisle, so
  // the pews stop half a tile short of the pier line and leave a one-tile strip
  // (x = 4 and x = 10) running along the colonnade. On a pew row that strip is a
  // dead end unless the tile on the aisle side of it is free, so every piece in
  // the left aisle lives at x <= 2 and every piece in the right aisle at x >= 12.
  // Both aisles then keep a lane, and the strips are reached from it.
  furn(font, 1.9, 4.3, 0);
  furn(plant, 1.05, 3.2, 0);
  furn(sack, 1.1, 6.4, 0);
  furn(bench, 1.0, 7.4, 0);
  furn(plant, 12.6, 3.4, 0);
  furn(crate, 13.7, 4.6, 0);
  furn(chest, 12.7, 7.6, 0);
  furn(lantern, 13.4, 8.4, 0);
  // The loose candles go in the LEFT aisle, not the right: on the right they
  // blocked the only open column (x = 12) between the cross-aisle and the far
  // corner, and sealed seven tiles of aisle behind them.
  furn(candles, 1.4, 1.4, 0);

  // ---- windows dressed, and the backdrop hung -------------------------------
  // Banners hang high on the two solid tiles of the back wall, and on the left
  // aisle wall where the light from the right-hand windows rakes across them.
  // `back` is passed explicitly (0.44, the same convention roomkit uses for the
  // curtain) because a banner declares no volume marks of its own.
  if (banner) {
    wall(banner, 3, '-y', 0.44);
    wall(banner, 11, '-y', 0.44);
    wall(banner, 4, '-x', 0.44);
    wall(banner, 7, '-x', 0.44);
    wall(banner, 2, '+y', 0.44);
    wall(banner, 12, '+y', 0.44);
  }

  return finishRoom(K, { door: [DOOR_X, h - 1], wallH: CHAPEL_H });
}
