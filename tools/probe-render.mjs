// A/B probe for the renderer's occlusion switches.
//
//   node tools/probe-render.mjs --mode indoor --presets noon,morning
//   node tools/probe-render.mjs --mode outdoor --presets noon
//
// Renders the SAME frame under different occlusion settings and reports how many
// pixels changed and WHERE — a 4x4 coarse map of the frame, because a diff
// confined to one corner means something very different from a diff spread over
// everything. It also writes the three frames out as PNGs, so the difference can
// be looked at rather than inferred.
//
// The two switches:
//
//   depthOff   draw with no depth test at all — exactly what the renderer did
//              before the depth buffer existed. The diff against normal is
//              therefore "everything the depth buffer decided".
//   focusOff   publish no focus, so nothing can be ghosted. The diff is
//              "everything the cutaway did".
//
// A healthy picture has SMALL, LOCALISED diffs. A diff that is large, or that
// lands on geometry it has no business touching — a wall with nothing behind it,
// a piece of furniture standing in the open — is the bug.
//
// NOTE: pixels are compared IN THE PAGE. Shipping ~1 MB of typed array back
// through the CDP bridge loses the type, which is why this does not return raw
// frames (see the same note in verify.mjs).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(argVal('--port', 8211));
const OUT = path.resolve(ROOT, argVal('--out', 'work/probe'));
const MODE = argVal('--mode', 'indoor');
const CAM = argVal('--cam', null);
const PRESETS = { morning: 0.32, noon: 0.50, golden: 0.70, night: 0.94 };
const names = (argVal('--presets', 'noon') || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await launchBrowser({ width: 640, height: 360 });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 900));

const report = [];
for (const name of names) {
  const t = PRESETS[name];
  if (t === undefined) continue;

  const setup = async (depthOff, focusOff) => {
    await page.evaluate((md, tt, cam, dOff, fOff) => {
      const g = window.game;
      g.enter(md);
      g.state.paused = true;
      g.state.time = tt;
      g.state.hud.weather = 'CLEAR';
      g.state.hud.weatherMix = 0;
      g.state.hud.showHelp = false;
      if (cam) { g.cam.x = cam[0]; g.cam.y = cam[1]; }
      g.depthOff = dOff;
      g.focusOff = fOff;
    }, MODE, t, CAM ? CAM.split(',').map(Number) : null, depthOff, focusOff);
    await new Promise((r) => setTimeout(r, 340));
  };

  const shot = async (tag) => {
    const file = path.join(OUT, `${name}_${MODE}_${tag}.png`);
    await page.screenshot({ path: file });
    return file;
  };

  // The comparison itself runs in the page, where the typed arrays keep their type.
  const measure = () => page.evaluate(() => {
    const c = document.getElementById('gl');
    const gl = c.getContext('webgl2');
    const snap = () => {
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const a = snap();
    const inner = window.__probeGrab;
    if (!inner) return { error: 'no inner grab' };
    return { error: 'unused', a };
  });
  void measure;

  // grab frames into the page, then diff them there
  await setup(false, false);
  await page.evaluate(() => {
    const c = document.getElementById('gl');
    const gl = c.getContext('webgl2');
    window.__f = {};
    const grab = (k) => {
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      window.__f[k] = px;
    };
    window.__grab = grab;
    grab('normal');
  });
  const fNormal = await shot('normal');

  await setup(true, false);
  await page.evaluate(() => window.__grab('noDepth'));
  const fNoDepth = await shot('noDepth');

  await setup(false, true);
  await page.evaluate(() => window.__grab('noCut'));
  const fNoCut = await shot('noCut');

  await setup(false, false);

  const r = await page.evaluate(() => {
    const W = document.getElementById('gl').width, H = document.getElementById('gl').height;
    const diff = (a, b) => {
      let n = 0, worst = 0;
      const grid = new Array(16).fill(0);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          if (d > 24) { n++; grid[Math.min(3, (y * 4 / H) | 0) * 4 + Math.min(3, (x * 4 / W) | 0)]++; }
          if (d > worst) worst = d;
        }
      }
      return { n, worst, grid, frac: n / (W * H) };
    };
    const f = window.__f;
    return {
      mode: window.game.mode,
      instances: window.game.renderer.instCount + window.game.renderer.ghostCount,
      noDepth: diff(f.normal, f.noDepth),
      noCut: diff(f.normal, f.noCut),
    };
  });

  report.push({ name, t, ...r, files: [fNormal, fNoDepth, fNoCut] });
}

console.log(`\nprobe: ${MODE}${CAM ? ` cam ${CAM}` : ''}, ${report.length} preset(s) -> ${path.relative(ROOT, OUT)}`);
for (const r of report) {
  console.log(`\n  ${r.name} t=${r.t} (${r.mode}, ${r.instances} sprites)`);
  console.log(`    depth test off vs on : ${String(r.noDepth.n).padStart(6)} px differ (${(r.noDepth.frac * 100).toFixed(2)}%), worst delta ${r.noDepth.worst}`);
  console.log(`      where (4x4 grid)   : ${r.noDepth.grid.join(' ')}`);
  console.log(`    cutaway off vs on    : ${String(r.noCut.n).padStart(6)} px differ (${(r.noCut.frac * 100).toFixed(2)}%), worst delta ${r.noCut.worst}`);
  console.log(`      where (4x4 grid)   : ${r.noCut.grid.join(' ')}`);
}

await browser.close();
server.close();
