// Headless-browser resolution for the tools that have to *look* at a frame.
//
// The game itself has zero dependencies and never imports this file. Only the
// QA / screenshot / timelapse tools do, which is why puppeteer appears in
// package.json as a devDependency and nowhere else. `npm run build`,
// `npm run serve` and `npm run single` do not need a browser at all.
//
// Two portability bugs used to be copy-pasted inline across six tools, which is
// why this file exists:
//
//   1. `createRequire('<absolute path into a sibling project>/package.json')`.
//      It worked on exactly one machine, and meant a fresh clone could not run
//      `npm run verify` at all.
//   2. A pinned browser path with the platform and the build number baked in
//      ('win64-131.0.6778.204'), which quietly degraded to "whatever puppeteer
//      can find" everywhere else.
//
// Both now live here, once.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let cached = null;

/**
 * Resolve puppeteer, or throw an error that says what to do about it.
 *
 *   1. a plain `import('puppeteer')` — the happy path after `npm install`
 *   2. `$HOMESTEAD_PUPPETEER_ROOT` — point this at any directory that already
 *      has puppeteer in its node_modules, so the ~300 MB browser download is
 *      shared between projects instead of repeated per project
 */
export async function loadPuppeteer() {
  if (cached) return cached;

  try {
    const mod = await import('puppeteer');
    cached = mod.default ?? mod;
    return cached;
  } catch { /* not installed here — try the escape hatch below */ }

  const root = process.env.HOMESTEAD_PUPPETEER_ROOT;
  if (root) {
    try {
      cached = createRequire(path.join(path.resolve(root), 'package.json'))('puppeteer');
      return cached;
    } catch (e) {
      throw new Error(
        `HOMESTEAD_PUPPETEER_ROOT is set to "${root}" but puppeteer could not be loaded from it.\n`
        + `  ${e.message}`,
      );
    }
  }

  throw new Error([
    'These tools need puppeteer: verify / shoot / pick / probe-page / probe-render / probe-stale / timelapse.',
    '',
    '  npm install                # installs it as a devDependency',
    '',
    'If puppeteer is already installed in another project and you would rather not',
    'download a second browser, point this at that project instead:',
    '',
    '  HOMESTEAD_PUPPETEER_ROOT=/path/to/that/project npm run verify',
    '',
    '`npm run build`, `npm run serve` and `npm run single` never need a browser.',
  ].join('\n'));
}

// Newest browser build wins. Directory names look like 'win64-131.0.6778.204',
// so compare the numeric triple rather than the string — 'win64-9...' sorts
// after 'win64-131...' lexically, which is exactly backwards.
function versionKey(name) {
  const m = name.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Locate a chrome-headless-shell build.
 *
 * It ships its own SwiftShader and starts far faster than full Chrome when all
 * you need is a fixed-size canvas, so it is the one to drive. Returns null to
 * let puppeteer pick a browser itself rather than failing.
 *
 * `$CHROME_PATH` overrides everything; `$PUPPETEER_CACHE_DIR` relocates the
 * cache, for CI and unusual layouts.
 */
export function findBrowser() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    console.warn(`CHROME_PATH is set but does not exist: ${process.env.CHROME_PATH}`);
  }

  const roots = [process.env.PUPPETEER_CACHE_DIR, path.join(os.homedir(), '.cache', 'puppeteer')]
    .filter(Boolean);

  const found = [];
  for (const root of roots) {
    const base = path.join(root, 'chrome-headless-shell');
    let builds;
    try { builds = fs.readdirSync(base); } catch { continue; }
    for (const build of builds) {
      const dir = path.join(base, build);
      let inner;
      try { inner = fs.readdirSync(dir); } catch { continue; }
      for (const sub of inner) {
        for (const exe of ['chrome-headless-shell.exe', 'chrome-headless-shell']) {
          const p = path.join(dir, sub, exe);
          if (fs.existsSync(p)) found.push({ p, key: versionKey(build) });
        }
      }
    }
  }

  if (!found.length) return null;
  found.sort((a, b) => (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]) || (a.key[2] - b.key[2]));
  return found[found.length - 1].p;
}

/** The argument set every tool in here wants: software GL, no focus stealing. */
export function browserArgs(width, height) {
  return [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--hide-scrollbars', '--mute-audio',
    `--window-size=${width},${height}`,
  ];
}

/**
 * Launch a headless browser with this project's standard options.
 *
 * `announce` prints which browser was picked, because "SwiftShader rendered
 * this" and "your real GPU rendered this" produce very different numbers and
 * the logs should never leave that ambiguous.
 */
export async function launchBrowser({ width = 640, height = 360, args = [], announce = false } = {}) {
  const puppeteer = await loadPuppeteer();
  const executablePath = findBrowser();
  const opts = { headless: true, args: [...browserArgs(width, height), ...args] };
  if (executablePath) opts.executablePath = executablePath;
  else if (announce) console.warn('no chrome-headless-shell in the puppeteer cache; letting puppeteer resolve a browser');
  const browser = await puppeteer.launch(opts);
  if (announce) console.log(`  browser: ${executablePath || '(puppeteer default)'}`);
  return browser;
}
