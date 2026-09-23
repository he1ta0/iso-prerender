// Model registry. Every module exports a `MODELS` array of descriptors:
//
//   { id, name, cat, fp:[w,d], seed, cap, build(b), phase?, rots?, anchor? }
//
//   id     unique atlas key
//   name   short ASCII label for the build list / UI
//   cat    grouping: ground | water | build | crop | tree | prop | char
//   fp     footprint in tiles; the Builder is created as new Builder(fp[0], fp[1], seed)
//   cap    approximate max height in world units (QA + camera fitting)
//   phase  pattern phase index -> tile variant (see patterns.mjs)
//   rots   how many 90-degree rotations to bake (default 1)
//
// `character.mjs` is special: it exports many frames instead of MODELS, so it is
// expanded here into ordinary descriptors.

import { MODELS as terrain } from './terrain.mjs';
import { MODELS as buildings } from './buildings.mjs';
import { MODELS as roomkit, MODELS_ROOF } from './roomkit.mjs';
import { MODELS as chapel } from './chapel.mjs';

const optional = async (path) => {
  try { return await import(path); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
};

const crops = await optional('./crops.mjs');
const props = await optional('./props.mjs');
const furniture = await optional('./furniture.mjs');
const character = await optional('./character.mjs');

export const ALL = [
  ...terrain,
  ...buildings,
  ...roomkit,
  ...MODELS_ROOF,
  ...chapel,
  ...(crops?.MODELS ?? []),
  ...(props?.MODELS ?? []),
  ...(furniture?.MODELS ?? []),
];

// ---- character frames ------------------------------------------------------
if (character?.CHAR && typeof character.buildCharacter === 'function') {
  const { CHAR, buildCharacter } = character;
  const outfits = CHAR.palette?.length ?? 1;
  for (const [action, spec] of Object.entries(CHAR.actions)) {
    for (let frame = 0; frame < spec.frames; frame++) {
      ALL.push({
        id: `char_${action}_${String(frame).padStart(2, '0')}`,
        name: `CHAR ${action.toUpperCase()}`,
        cat: 'char',
        fp: [1, 1],
        seed: 900 + frame,
        cap: 1.35,
        action,
        frame,
        fps: spec.fps,
        frames: spec.frames,
        rots: CHAR.dirs ?? 1,
        anchor: [0.5, 0.5, 0],
        build(b) { buildCharacter(b, { action, frame, outfit: 0 }); },
      });
    }
  }
  if (outfits > 1) console.log(`character: ${outfits} outfits declared (baking outfit 0 only)`);
}

export const byId = new Map(ALL.map((m) => [m.id, m]));
export const CHARS = character?.CHAR ?? null;
