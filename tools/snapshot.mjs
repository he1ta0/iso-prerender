// Snapshot the project into backup/<name>.zip before a risky change.
//
//   node tools/snapshot.mjs --name m2-interior-fixes
//   node tools/snapshot.mjs --list
//
// Deliberately excludes node_modules, work/ scratch and any previous backup, so
// a snapshot stays small enough to take before *every* meaningful change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipWriter } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = path.join(ROOT, 'backup');
const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

if (argv.includes('--list')) {
  if (!fs.existsSync(BACKUP)) { console.log('no backups yet'); process.exit(0); }
  for (const f of fs.readdirSync(BACKUP).sort()) {
    const st = fs.statSync(path.join(BACKUP, f));
    console.log(`${f.padEnd(44)} ${(st.size / 1024).toFixed(0).padStart(6)} KB  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  process.exit(0);
}

const name = argVal('--name', null);
if (!name) { console.error('usage: node tools/snapshot.mjs --name <label>   (or --list)'); process.exit(1); }

const SKIP_DIRS = new Set(['node_modules', 'work', 'backup', '.git', 'dist']);
const SKIP_EXT = new Set(['.log']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
    if (!e.isFile()) continue;
    if (SKIP_EXT.has(path.extname(e.name))) continue;
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    files.push({ name: rel, data: fs.readFileSync(full) });
  }
})(ROOT);

files.sort((a, b) => (a.name < b.name ? -1 : 1));
fs.mkdirSync(BACKUP, { recursive: true });
const out = path.join(BACKUP, `${name}.zip`);
const zw = new ZipWriter();
for (const f of files) zw.add(f.name, f.data);
fs.writeFileSync(out, zw.finish());
const total = files.reduce((s, f) => s + f.data.length, 0);
console.log(`snapshot -> ${path.relative(ROOT, out)}  ${files.length} files, `
  + `${(total / 1048576).toFixed(2)} MB raw, ${(fs.statSync(out).size / 1024).toFixed(0)} KB zipped`);
