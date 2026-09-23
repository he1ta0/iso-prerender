// Boot the game headlessly and evaluate an expression inside the page.
//
//   node tools/probe-page.mjs "window.game.renderer.hmBase.length"
//   node tools/probe-page.mjs --mode indoor --file work/probe.js
//
// Same launch path as tools/shoot.mjs (chrome-headless-shell + SwiftShader), so
// anything it reports is what the real renderer is doing.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(argVal('--port', 8201));
const MODE = argVal('--mode', null);
const T = argVal('--t', null);
const FILE = argVal('--file', null);
const expr = FILE ? fs.readFileSync(FILE, 'utf8') : (argv.find((a) => !a.startsWith('--') && a !== MODE && a !== T && a !== FILE) || '1');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500).end(String(e.message)); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await launchBrowser({ width: 640, height: 360 });
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction('window.game && window.game.renderer', { timeout: 30000 });
} catch (e) {
  console.error('boot failed');
  for (const l of logs) console.error('  ' + l);
  await browser.close(); server.close(); process.exit(1);
}
await new Promise((r) => setTimeout(r, 600));
if (MODE) await page.evaluate((m) => window.game.enter(m), MODE);
if (T) await page.evaluate((t) => { window.game.state.paused = true; window.game.state.time = Number(t); }, T);
await new Promise((r) => setTimeout(r, 300));

try {
  const out = await page.evaluate(`(() => { ${expr.includes('return') ? expr : `return (${expr});`} })()`);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (e) {
  console.error('eval failed:', e.message);
  for (const l of logs) console.error('  ' + l);
  await browser.close(); server.close(); process.exit(1);
}
const SHOT = argVal('--shot', null);
if (SHOT) {
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: path.resolve(ROOT, SHOT) });
  console.log(`shot -> ${SHOT}`);
}
if (logs.length && argv.includes('--logs')) for (const l of logs) console.log('  ' + l);
await browser.close();
server.close();
