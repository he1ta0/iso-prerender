// Material table for the offline pre-renderer.
//
//   [ name, hex, pattern, specular, emissive, bump ]
//
// * `pattern`  procedural world-space surface detail (see patterns.mjs)
// * `specular` 0..1, drives the runtime Blinn highlight (metal, glass, wet)
// * `emissive` 0..1, drives the runtime window/lamp glow (baked as an AOV
//              channel, so a lit window keeps glowing no matter the hour)
// * `bump`     0..1 strength of the *detail normal* derived from the gradient of
//              the procedural pattern. This is the single most important column
//              in this file: it is what stops a pre-rendered wall from going
//              flat the moment a lantern is carried past it.
//
// Colours are authored in display space (what you would pick in a paint
// program). The runtime squares them to get linear light, lights in linear,
// then converts back — so this table is the whole art direction.

import { PAT } from './patterns.mjs';

const DEFS = [
  // ---- wood ---------------------------------------------------------------
  ['woodPlank',     'a57a45', PAT.PLANK,      0.02, 0,    0.75],
  ['woodPlankDk',   '7d5a33', PAT.PLANK,      0.02, 0,    0.75],
  ['woodPlankLt',   'bf9560', PAT.PLANK,      0.02, 0,    0.75],
  ['woodRed',       '9c4b38', PAT.PLANK,      0.03, 0,    0.70],
  ['woodBlue',      '5d7794', PAT.PLANK,      0.03, 0,    0.70],
  ['woodSage',      '8a9670', PAT.PLANK,      0.03, 0,    0.70],
  ['woodWhite',     'ded6c4', PAT.PLANK,      0.03, 0,    0.65],
  ['woodWeathered', '95897a', PAT.PLANK,      0.02, 0,    0.80],
  ['beam',          '5f4527', PAT.NONE,       0.02, 0,    0.30],
  ['beamDk',        '42301b', PAT.NONE,       0.02, 0,    0.30],
  ['log',           '8b6539', PAT.LOG,        0.02, 0,    1.00],
  ['logDk',         '6a4a29', PAT.LOG,        0.02, 0,    1.00],
  ['bark',          '5b4530', PAT.BARK,       0.02, 0,    0.85],
  ['barkDk',        '3f2f20', PAT.BARK,       0.02, 0,    0.85],
  ['deck',          '9a7346', PAT.DECK,       0.03, 0,    0.80],
  ['deckDk',        '75563a', PAT.DECK,       0.03, 0,    0.80],

  // ---- plaster / render / masonry ------------------------------------------
  ['plaster',       'e6d9bd', PAT.STUCCO,     0.02, 0,    0.32],
  ['plasterWhite',  'f2ece0', PAT.STUCCO,     0.02, 0,    0.30],
  ['plasterWarm',   'ddc49c', PAT.STUCCO,     0.02, 0,    0.32],
  ['plasterSage',   'b7c2a1', PAT.STUCCO,     0.02, 0,    0.32],
  ['plasterBlue',   'bacfda', PAT.STUCCO,     0.02, 0,    0.32],
  ['plasterRose',   'dcb3a4', PAT.STUCCO,     0.02, 0,    0.32],
  ['brick',         'a9603f', PAT.BRICK,      0.03, 0,    0.80],
  ['brickDk',       '8a4b32', PAT.BRICK,      0.03, 0,    0.80],
  ['brickPale',     'c4835e', PAT.BRICK,      0.03, 0,    0.80],
  ['stone',         '9d9a90', PAT.STONE,      0.03, 0,    0.95],
  ['stoneDk',       '7b7870', PAT.STONE,      0.03, 0,    0.95],
  ['stoneWarm',     'a89a83', PAT.STONE,      0.03, 0,    0.95],
  ['cobble',        '8e8b82', PAT.COBBLE,     0.04, 0,    0.90],
  ['cobbleDk',      '6f6c65', PAT.COBBLE,     0.04, 0,    0.90],
  ['concrete',      'b0ada2', PAT.CONCRETE,   0.03, 0,    0.45],
  ['concreteDk',    '8b887e', PAT.CONCRETE,   0.03, 0,    0.45],

  // ---- roofs ---------------------------------------------------------------
  ['roofTile',      'b5603f', PAT.TILE_ROOF,  0.03, 0,    0.90],
  ['roofTileDk',    '8f4630', PAT.TILE_ROOF,  0.03, 0,    0.90],
  ['roofTilePale',  'c97a55', PAT.TILE_ROOF,  0.03, 0,    0.90],
  ['roofSlate',     '5f6b78', PAT.SLATE,      0.06, 0,    0.80],
  ['roofSlateDk',   '4a545f', PAT.SLATE,      0.06, 0,    0.80],
  ['roofSlateBlue', '56707f', PAT.SLATE,      0.06, 0,    0.80],
  ['roofShingle',   '8a6242', PAT.SHINGLE,    0.03, 0,    0.85],
  ['roofShingleDk', '6d4a31', PAT.SHINGLE,    0.03, 0,    0.85],
  ['roofThatch',    'c3a05c', PAT.THATCH,     0.02, 0,    1.00],
  ['roofThatchDk',  'a3823f', PAT.THATCH,     0.02, 0,    1.00],
  ['roofGreen',     '5d7a52', PAT.SHINGLE,    0.03, 0,    0.75],
  ['roofTeal',      '4a7b7a', PAT.SHINGLE,    0.04, 0,    0.75],
  ['roofMetal',     '8d9299', PAT.METAL,      0.30, 0,    0.50],
  ['roofRust',      '9c6a42', PAT.METAL,      0.18, 0,    0.60],

  // ---- trim / structure ----------------------------------------------------
  ['trim',          'f0e8d8', PAT.NONE,       0.03, 0,    0.20],
  ['trimDark',      '4a3a28', PAT.NONE,       0.03, 0,    0.20],
  ['trimRed',       'a8473a', PAT.NONE,       0.03, 0,    0.20],
  ['trimBlue',      '48688c', PAT.NONE,       0.03, 0,    0.20],
  ['stoneTrim',     'c2beb2', PAT.NONE,       0.04, 0,    0.25],
  ['metal',         '8f959c', PAT.METAL,      0.45, 0,    0.40],
  ['metalDark',     '5d646c', PAT.METAL,      0.40, 0,    0.40],
  ['ironBlack',     '3a3630', PAT.METAL,      0.32, 0,    0.40],
  ['copper',        '9c7048', PAT.METAL,      0.38, 0,    0.45],
  ['rust',          '9c6238', PAT.METAL,      0.15, 0,    0.55],

  // ---- ground --------------------------------------------------------------
  ['grass',         '6a9e4a', PAT.GRASS,      0.01, 0,    0.30],
  ['grassDk',       '55823c', PAT.GRASS,      0.01, 0,    0.30],
  ['grassLt',       '82b45c', PAT.GRASS,      0.01, 0,    0.30],
  ['grassDry',      'a8a862', PAT.GRASS,      0.01, 0,    0.30],
  ['grassTall',     '5c8f42', PAT.GRASS_TALL, 0.01, 0,    0.42],
  ['soil',          '6b4d33', PAT.SOIL,       0.01, 0,    0.45],
  ['soilDk',        '523a25', PAT.SOIL,       0.01, 0,    0.45],
  ['soilWet',       '422c1b', PAT.SOIL,       0.14, 0,    0.40],
  ['tilled',        '5f4229', PAT.TILLED,     0.01, 0,    1.00],
  ['tilledWet',     '402a18', PAT.TILLED,     0.16, 0,    0.95],
  ['sandPath',      'c9b189', PAT.SAND,       0.02, 0,    0.35],
  ['sand',          'd8c49c', PAT.SAND,       0.02, 0,    0.35],
  ['gravel',        'a49a88', PAT.GRAVEL,     0.03, 0,    0.70],
  ['flagstone',     'b0aa9c', PAT.STONE_PATH, 0.04, 0,    0.75],
  ['flagstoneDk',   '948e82', PAT.STONE_PATH, 0.04, 0,    0.75],
  ['water',         '3d7ba8', PAT.WATER,      0.55, 0,    0.00],
  ['waterShallow',  '5b98bc', PAT.WATER,      0.55, 0,    0.00],
  ['waterDeep',     '2a5c86', PAT.WATER,      0.55, 0,    0.00],
  ['mud',           '4e3a28', PAT.SOIL,       0.20, 0,    0.40],

  // ---- foliage -------------------------------------------------------------
  ['leaf',          '4f7f3a', PAT.LEAF,       0.01, 0,    0.55],
  ['leafDk',        '3b6330', PAT.LEAF,       0.01, 0,    0.55],
  ['leafLt',        '6d9c46', PAT.LEAF,       0.01, 0,    0.55],
  ['leafAutumn',    'c8802f', PAT.LEAF,       0.01, 0,    0.55],
  ['leafAutumnDk',  'a85f24', PAT.LEAF,       0.01, 0,    0.55],
  ['leafBlossom',   'e0a8bc', PAT.LEAF,       0.01, 0,    0.55],
  ['leafBlossomLt', 'efc6d4', PAT.LEAF,       0.01, 0,    0.55],
  ['conifer',       '33582f', PAT.LEAF,       0.01, 0,    0.60],
  ['coniferDk',     '264423', PAT.LEAF,       0.01, 0,    0.60],
  ['hedge',         '4a7a38', PAT.HEDGE,      0.01, 0,    0.60],
  ['cropLeaf',      '5f9a3e', PAT.CROP_LEAF,  0.01, 0,    0.50],
  ['cropLeafDk',    '4a7d31', PAT.CROP_LEAF,  0.01, 0,    0.50],
  ['hay',           'c8ac6a', PAT.HAY,        0.02, 0,    0.85],
  ['hayDk',         'a88c4e', PAT.HAY,        0.02, 0,    0.85],

  // ---- crops (fruit / produce) ---------------------------------------------
  ['cropWheat',     'd8b74e', PAT.CROP_LEAF,  0.03, 0,    0.45],
  ['cropTomato',    'cf4a3a', PAT.NONE,       0.14, 0,    0.15],
  ['cropPumpkin',   'dd7f2c', PAT.NONE,       0.12, 0,    0.20],
  ['cropEggplant',  '7a4a9c', PAT.NONE,       0.16, 0,    0.15],
  ['cropCorn',      'e0c452', PAT.CROP_LEAF,  0.04, 0,    0.45],
  ['cropBerry',     'b83a52', PAT.NONE,       0.16, 0,    0.15],
  ['cropMelon',     '8cae52', PAT.NONE,       0.14, 0,    0.18],
  ['cropCarrot',    'd97a2c', PAT.NONE,       0.12, 0,    0.20],
  ['flowerRed',     'dd5a4c', PAT.NONE,       0.05, 0,    0.15],
  ['flowerYellow',  'ecd25c', PAT.NONE,       0.05, 0,    0.15],
  ['flowerPurple',  'b184d4', PAT.NONE,       0.05, 0,    0.15],
  ['flowerWhite',   'f2f0e2', PAT.NONE,       0.05, 0,    0.15],
  ['flowerBlue',    '6a8fd0', PAT.NONE,       0.05, 0,    0.15],

  // ---- glass / light -------------------------------------------------------
  ['glass',         '4a7d96', PAT.GLASS,      0.80, 0,    0.00],
  ['glassDark',     '33586d', PAT.GLASS,      0.70, 0,    0.00],
  ['glassSky',      '7fb0c6', PAT.GLASS,      0.85, 0,    0.00],
  ['glassLit',      'f0c86a', PAT.GLASS,      0.18, 0.95, 0.00],
  ['glassLitWarm',  'e8a34e', PAT.GLASS,      0.18, 0.85, 0.00],
  ['lampGlass',     'f5dc9a', PAT.NONE,       0.20, 1.00, 0.00],
  ['lanternPaper',  'f2dca8', PAT.FABRIC,     0.10, 0.85, 0.20],
  ['fireGlow',      'ff9a3c', PAT.NONE,       0.05, 1.00, 0.00],
  ['coal',          '4a2a20', PAT.NOISE,      0.05, 0.30, 0.40],

  // ---- cloth / soft goods --------------------------------------------------
  ['clothRed',      'ba4f42', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothBlue',     '4d76a4', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothCream',    'e6dcc2', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothGreen',    '5f8250', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothYellow',   'dcbe62', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothPink',     'dba0ac', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothTeal',     '4e8480', PAT.FABRIC,     0.03, 0,    0.40],
  ['clothPurple',   '7a628f', PAT.FABRIC,     0.03, 0,    0.40],
  ['rugRed',        '9c4038', PAT.FABRIC,     0.02, 0,    0.35],
  ['rugBlue',       '3f5f86', PAT.FABRIC,     0.02, 0,    0.35],

  // ---- character -----------------------------------------------------------
  ['skin',          'e8b48c', PAT.NONE,       0.06, 0,    0.10],
  ['skinDk',        'c48f68', PAT.NONE,       0.06, 0,    0.10],
  ['skinPale',      'f2ccae', PAT.NONE,       0.06, 0,    0.10],
  ['hairBrown',     '6b4326', PAT.NONE,       0.10, 0,    0.20],
  ['hairBlack',     '332a26', PAT.NONE,       0.14, 0,    0.20],
  ['hairBlond',     'c9a153', PAT.NONE,       0.10, 0,    0.20],
  ['hairAuburn',    '94472a', PAT.NONE,       0.10, 0,    0.20],
  ['shirtRed',      'b8503f', PAT.FABRIC,     0.03, 0,    0.30],
  ['shirtBlue',     '4a6f9c', PAT.FABRIC,     0.03, 0,    0.30],
  ['shirtGreen',    '5e8a4c', PAT.FABRIC,     0.03, 0,    0.30],
  ['shirtCream',    'ddd0b4', PAT.FABRIC,     0.03, 0,    0.30],
  ['pantsBrown',    '6a5236', PAT.FABRIC,     0.03, 0,    0.30],
  ['pantsBlue',     '40587a', PAT.FABRIC,     0.03, 0,    0.30],
  ['pantsDark',     '3f3a36', PAT.FABRIC,     0.03, 0,    0.30],
  ['boots',         '5a4530', PAT.NONE,       0.10, 0,    0.15],
  ['hatStraw',      'd4b46a', PAT.FABRIC,     0.04, 0,    0.45],
  ['apron',         'c9bda2', PAT.FABRIC,     0.03, 0,    0.35],

  // ---- misc props ----------------------------------------------------------
  ['paper',         'f0ece0', PAT.NONE,       0.04, 0,    0.10],
  ['wax',           'e8dcc0', PAT.NONE,       0.20, 0,    0.15],
  ['ceramic',       'ded8cc', PAT.NONE,       0.30, 0,    0.10],
  ['ceramicBlue',   '7d9cc0', PAT.NONE,       0.30, 0,    0.10],
  ['terracottaPot', 'b06a45', PAT.NONE,       0.05, 0,    0.25],
  ['plankCrate',    'a07846', PAT.DECK,       0.03, 0,    0.80],
  ['sack',          'c2b08a', PAT.FABRIC,     0.03, 0,    0.45],
  ['snow',          'eef4fa', PAT.NOISE,      0.12, 0,    0.35],
  ['ice',           'b8dcec', PAT.NONE,       0.70, 0,    0.05],
  ['black',         '241f1b', PAT.NONE,       0.05, 0,    0.10],
  ['white',         'f8f6ee', PAT.NONE,       0.08, 0,    0.10],

  // ---- the chapel: stained glass, pale stone, gilt -------------------------
  //
  // Five coloured glasses rather than one "stained glass" material, because in
  // this renderer the material is not only what the sprite looks like: the same
  // colour is handed to the occupancy volume as the light TINT of that pane (see
  // glassBox in ../lib/geom.mjs). One material per colour is what makes the
  // window and the patch of light it throws on the floor the same decision,
  // taken once, in one line — the reason the chapel map can afford to have five
  // colours at all.
  //
  // They are deliberately dark (a real glazier's red transmits about half the
  // light it catches) and only mildly specular: a pane that reads as a mirror
  // is a pane you cannot see the colour of.
  ['glassRose',     'b8352f', PAT.GLASS,      0.30, 0,    0.12],
  ['glassAzure',    '2d6bb5', PAT.GLASS,      0.30, 0,    0.12],
  ['glassGold',     'd2a02a', PAT.GLASS,      0.32, 0,    0.12],
  ['glassVerdant',  '3d8f57', PAT.GLASS,      0.30, 0,    0.12],
  ['glassViolet',   '6f4a9e', PAT.GLASS,      0.30, 0,    0.12],
  ['marblePale',    'e7e1d2', PAT.STUCCO,     0.10, 0,    0.16],
  ['marbleDk',      '9d968a', PAT.STUCCO,     0.10, 0,    0.18],
  ['stonePale',     'ddd6c6', PAT.STUCCO,     0.04, 0,    0.30],
  ['gold',          'c9a227', PAT.METAL,      0.55, 0,    0.15],
  ['carpetRed',     '8c2f2f', PAT.FABRIC,     0.03, 0,    0.50],
];

export const MATS = {};
export const MAT_LIST = [];
for (const [name, hex, pattern, spec, emis, bump] of DEFS) {
  const c = hex.match(/../g).map((h) => parseInt(h, 16) / 255);
  const idx = MAT_LIST.length;
  const mat = { idx, name, color: c, pattern, spec, emissive: emis, bump: bump ?? 0 };
  MATS[name] = idx;
  MAT_LIST.push(mat);
}
export const mat = (idx) => MAT_LIST[idx];
export { PAT };

/** Material index by name with a loud failure — typos in model code are common. */
export function M(name) {
  const i = MATS[name];
  if (i === undefined) throw new Error(`unknown material: ${name}`);
  return i;
}
