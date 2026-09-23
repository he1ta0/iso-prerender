// Bundle the whole game — code, atlas PNGs and manifest — into one HTML file
// that runs by double-clicking it. No server, no fetch, no dependencies.
//
//   node tools/build-single.mjs [--out dist/homestead98.html]
//
// The PNGs go in as base64 data URLs and are handed to the atlas loader through
// a tiny shim, so the runtime code is byte-for-byte the same file that runs off
// the dev server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, argVal('--out', 'dist/homestead98.html'));

// ---- collect the ES modules the runtime actually imports -------------------
const MODULES = [
  'src/main.js',
  'src/atlas.js',
  'src/daylight.js',
  'src/font.js',
  'src/interior.js',
  'src/interior_upper.js',
  'src/interior_chapel.js',
  'src/iso.js',
  'src/rng.js',
  'src/ui.js',
  'src/world.js',
  'src/gl/renderer.js',
  'src/gl/shaders.js',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

// ---- both asset sets, inlined as data URLs ---------------------------------
// The game runs two scenes at two scales, so it needs two atlases. Missing one
// of them produces a single-file build that goes black the moment you walk
// indoors — which is exactly the kind of thing a bundle should never be able to
// do silently.
const b64 = (dir, f) => {
  const p = path.join(ROOT, dir, f);
  if (!fs.existsSync(p)) throw new Error(`bundle: missing ${dir}/${f}`);
  return fs.readFileSync(p).toString('base64');
};
function loadSet(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'sprites.json'), 'utf8'));
  return {
    manifest,
    images: {
      albedo: b64(dir, 'albedo.png'),
      nrm: b64(dir, 'nrm.png'),
      mat: b64(dir, 'mat.png'),
      stamp: b64(dir, 'stamp.png'),
    },
  };
}
const sets = { outdoor: loadSet('assets'), interior: loadSet('assets/int') };
const spriteTotal = Object.keys(sets.outdoor.manifest.sprites).length
  + Object.keys(sets.interior.manifest.sprites).length;

// ---- rewrite the module sources so they can live in one <script type=module>
// Each module keeps its own scope via a tiny registry instead of real ESM
// imports, which avoids needing import maps or blob URLs.
const sources = {};
for (const f of MODULES) sources[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const dir = path.posix.dirname(from);
  let p = path.posix.normalize(path.posix.join(dir, spec));
  if (!p.endsWith('.js')) p += '.js';
  return p;
}

// ---- every import must be a module this build actually carries ---------------
// The list above is hand-maintained, and a source file that imports something
// missing from it used to produce a bundle that boots to a blank page with
// "missing module src/…" buried in the console — which is exactly what adding a
// second interior did. A build that cannot run should fail HERE, naming the file
// and the specifier, rather than ship.
for (const f of MODULES) {
  for (const m of sources[f].matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
    const target = resolve(f, m[1]);
    if (target && !sources[target]) {
      throw new Error(`${f}: imports '${m[1]}' -> ${target}, which is not in MODULES`
        + ` (add it to the list at the top of tools/build-single.mjs)`);
    }
  }
}

// top-level await is used by main.js, so each module becomes an async factory
const wrapped = MODULES.map((f) => {
  let src = sources[f];
  const imports = [];

  // ---- no mutable exports ----------------------------------------------------
  // `export let x` is a LIVE BINDING: other modules see the new value when it is
  // reassigned. This bundle cannot offer that — it turns each module into a
  // factory that returns its exports, and each importer into a destructure, and
  // a destructure is a copy taken once. The failure is silent and monstrous: the
  // single-file build kept the OUTDOOR projection constants after the game had
  // switched to the 1.5x interior scale, so the shader's inverse projection put
  // every fragment 1.5x too far from the camera, and the interior light volume
  // was sampled in the wrong place — an indoor room lit as if it had no roof,
  // visible ONLY by double-clicking the bundled HTML. src/iso.js now keeps its
  // projection in a mutable OBJECT (see the note there); anything else mutable
  // is a build error rather than a mystery.
  const mutable = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /^\s*export\s+(let|var)\s/.test(l));
  if (mutable.length) {
    throw new Error(`${f}: mutable export (live binding) at line(s) `
      + `${mutable.map(([n]) => n).join(', ')} — a single-file build cannot keep it live.\n  `
      + mutable.slice(0, 3).map(([n, l]) => `${n}: ${l.trim()}`).join('\n  ')
      + '\n  Put the mutable state in an exported OBJECT and read its fields at use time'
      + ' (see ISO in src/iso.js).');
  }

  // Collect what the module exports *before* stripping the syntax — the factory
  // has to hand these back, since there is no real module record here.
  const exportNames = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    exportNames.push(m[1]);
  }
  for (const m of src.matchAll(/^export\s*\{([\s\S]*?)\}\s*;?/gm)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      exportNames.push((as[1] || as[0]).trim());
    }
  }
  if (/^export\s+default\s/m.test(src)) exportNames.push('default: __default');

  src = src.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?$/gm, (m, clause, spec) => {
    const target = resolve(f, spec);
    if (!target) return '';                    // node builtins etc. — not used at runtime
    const id = `__m${imports.length}`;
    imports.push({ id, target });
    const c = clause.trim();
    if (c.startsWith('*')) return `const ${c.slice(1).trim().replace(/^as\s+/, '')} = await __mod('${target}');`;
    if (c.startsWith('{')) return `const ${c} = await __mod('${target}');`;
    return `const ${c} = (await __mod('${target}')).default;`;
  });
  // strip export syntax, keeping `async` where present
  src = src.replace(/^export\s+(async\s+)?(const|let|var|function|class)\s/gm, '$1$2 ');
  src = src.replace(/^export\s*\{[\s\S]*?\}\s*;?[ \t]*$/gm, '');
  src = src.replace(/^export\s+default\s+/gm, 'const __default = ');
  // build-time safety net: a missed export only shows up as a blank page
  // otherwise, which is a miserable way to find out. Comment lines are skipped —
  // a comment cannot be an export statement, and documentation about this very
  // transform is the thing most likely to mention one.
  const leftover = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(([, l]) => /(^|[^\w.])export\s/.test(l));
  if (leftover.length) {
    throw new Error(`${f}: unhandled export syntax at line(s) ${leftover.map(([n]) => n).join(', ')}:\n  `
      + leftover.slice(0, 3).map(([n, l]) => `${n}: ${l.trim()}`).join('\n  '));
  }
  // Exports are handed back as GETTERS, not as a frozen snapshot, so anything
  // that reaches them through the namespace object (or through `import * as`)
  // still sees the current value — the same thing real ESM does. A destructuring
  // import still copies, which is why mutable exports are refused above.
  const ret = exportNames.length
    ? `\nreturn { ${exportNames.map((n) => (n.includes(':') ? n : `get ${n}() { return ${n}; }`)).join(', ')} };`
    : '\nreturn {};';
  return `__def(${JSON.stringify(f)}, async (__mod) => {\n${src}${ret}\n});`;
}).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>iso-prerender — HOMESTEAD 98</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: #05060a;
    background-image: radial-gradient(ellipse at 50% 45%, #0b0e18 0%, #05060a 70%); }
  #wrap { position: absolute; }
  canvas { position: absolute; left: 0; top: 0; display: block;
    image-rendering: pixelated; image-rendering: crisp-edges; }
  #ui { pointer-events: auto; cursor: default; }
  #boot { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #7d90a8; font: 12px/1.6 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.14em; text-align: center; white-space: pre; }
</style>
</head>
<body>
  <div id="wrap">
    <canvas id="gl"></canvas>
    <canvas id="ui"></canvas>
  </div>
  <div id="boot">LOADING…</div>
<script>
window.__ASSETS__ = {
  sets: {
    outdoor:  { manifest: ${JSON.stringify(sets.outdoor.manifest)},  images: {
      albedo: "data:image/png;base64,${sets.outdoor.images.albedo}",
      nrm:    "data:image/png;base64,${sets.outdoor.images.nrm}",
      mat:    "data:image/png;base64,${sets.outdoor.images.mat}",
      stamp:  "data:image/png;base64,${sets.outdoor.images.stamp}" } },
    interior: { manifest: ${JSON.stringify(sets.interior.manifest)}, images: {
      albedo: "data:image/png;base64,${sets.interior.images.albedo}",
      nrm:    "data:image/png;base64,${sets.interior.images.nrm}",
      mat:    "data:image/png;base64,${sets.interior.images.mat}",
      stamp:  "data:image/png;base64,${sets.interior.images.stamp}" } }
  }
};
</script>
<script>
(async () => {
  const boot = document.getElementById('boot');
  const defs = new Map();
  const cache = new Map();
  const __def = (name, fn) => defs.set(name, fn);
  const __mod = async (name) => {
    if (cache.has(name)) return cache.get(name);
    const fn = defs.get(name);
    if (!fn) throw new Error('missing module ' + name);
    const p = fn(__mod);
    cache.set(name, p);            // cache the promise: handles cycles + repeat
    return p;
  };
  try {
${wrapped}
    await __mod('src/main.js');
    boot.style.display = 'none';
  } catch (e) {
    boot.style.color = '#d9705a';
    boot.textContent = 'FAILED\\n' + (e && e.message ? e.message : e);
    console.error(e);
  }
})();
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
const kb = fs.statSync(OUT).size;
console.log(`wrote ${path.relative(ROOT, OUT)}  ${(kb / 1048576).toFixed(2)} MB  `
  + `(${MODULES.length} modules, ${spriteTotal} sprites across ${Object.keys(sets).length} scene sets)`);
