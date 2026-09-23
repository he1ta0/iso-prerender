// Atlas loading + sprite lookup.
//
// The offline build writes albedo / nrm / mat / stamp as four separate RGBA8
// PNGs that all share one packing layout, so a single UV set addresses all
// three G-buffer sources.

export class Atlas {
  constructor(manifest, images) {
    this.m = manifest;
    this.sprites = manifest.sprites;
    this.images = images;                     // { albedo, nrm, mat, stamp } HTMLImageElement
    const [aw, ah] = manifest.atlas.albedo;
    this.size = [aw, ah];
    this.zScale = manifest.atlas.zScale;
    this.ppc = manifest.atlas.ppc;

    // precompute uv rects
    this.uv = {};
    for (const [id, s] of Object.entries(this.sprites)) {
      this.uv[id] = {
        a: [s.a[0] / aw, s.a[1] / ah, s.a[2] / aw, s.a[3] / ah],
      };
    }
  }

  has(id) { return !!this.sprites[id]; }
  get(id) { return this.sprites[id]; }

  /**
   * Resolve `id` + rotation to a real sprite key.
   *
   * A model baked with rots > 1 is stored as `id#0`..`id#3` and has NO bare
   * `id`; a model with rots == 1 is stored under its bare id. Writing
   * `rot ? `${id}#${rot}` : id` looks right and is wrong, because rot 0 is
   * falsy: every unrotated rotatable piece silently resolves to nothing and the
   * object just disappears from the scene. This is the third time that has
   * bitten, so it now lives in exactly one place.
   */
  spriteId(id, rot = 0) {
    if (!id) return null;
    const r = rot | 0;
    if (this.sprites[`${id}#${r}`]) return `${id}#${r}`;
    if (this.sprites[id]) return id;
    if (this.sprites[`${id}#0`]) return `${id}#0`;
    return null;
  }

  /** every sprite id whose category matches */
  byCat(cat) {
    return Object.keys(this.sprites).filter((k) => this.sprites[k].cat === cat);
  }

  /**
   * First id out of `ids` that actually exists, returned as a BASE id (so the
   * caller can still apply a rotation). Must accept `id#0` as proof of life:
   * a rots > 1 model has no bare id, and testing only for the bare id silently
   * returns null for every rotatable piece in the kit.
   */
  first(...ids) {
    for (const id of ids) {
      if (!id) continue;
      if (this.sprites[id] || this.sprites[`${id}#0`]) return id;
    }
    return null;
  }

  /**
   * Stable pseudo-random variant pick. Uses a full avalanche hash — a cheap
   * multiply-xor would leave visible periodicity in the low bits, which shows up
   * as a regular checkerboard across the grass.
   */
  variant(ids, x, y) {
    if (!ids.length) return null;
    let h = Math.imul((x | 0) + 1, 0x27d4eb2d) ^ Math.imul((y | 0) + 1, 0x165667b1);
    h ^= h >>> 15; h = Math.imul(h, 0x2545f491);
    h ^= h >>> 13; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 16;
    return ids[(h >>> 0) % ids.length];
  }

  /** weighted variant pick: weights[i] corresponds to ids[i] */
  variantW(ids, weights, x, y) {
    if (!ids.length) return null;
    let h = Math.imul((x | 0) + 7, 0x9e3779b1) ^ Math.imul((y | 0) + 13, 0x85ebca6b);
    h ^= h >>> 15; h = Math.imul(h, 0x27d4eb2d);
    h ^= h >>> 13; h = Math.imul(h, 0x165667b1);
    h ^= h >>> 16;
    const r = (h >>> 0) / 4294967296;
    let acc = 0;
    for (let i = 0; i < ids.length; i++) {
      acc += weights[i] ?? 0;
      if (r < acc) return ids[i];
    }
    return ids[ids.length - 1];
  }
}

export async function loadAtlas(base = 'assets', setKey = null) {
  // The single-file build inlines every manifest and PNG as data URLs; the code
  // path below is otherwise identical to the dev-server one.
  const inline = (typeof window !== 'undefined') ? window.__ASSETS__ : null;
  if (inline) {
    const key = setKey || (base.includes('int') ? 'interior' : 'outdoor');
    const set = inline.sets[key];
    if (!set) throw new Error(`inline asset set missing: ${key}`);
    const load = (src) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('inline image failed to decode'));
      img.src = src;
    });
    const [albedo, nrm, mat, stamp] = await Promise.all([
      load(set.images.albedo), load(set.images.nrm),
      load(set.images.mat), load(set.images.stamp),
    ]);
    return new Atlas(set.manifest, { albedo, nrm, mat, stamp });
  }
  const manifest = await (await fetch(`${base}/sprites.json`)).json();
  const load = (name) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`failed to load ${base}/${name}.png`));
    img.src = `${base}/${name}.png`;
  });
  const [albedo, nrm, mat, stamp] = await Promise.all([
    load('albedo'), load('nrm'), load('mat'), load('stamp'),
  ]);
  return new Atlas(manifest, { albedo, nrm, mat, stamp });
}
