import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const want = process.argv.slice(2);
const txt = readFileSync('.aptcache/main.txt', 'utf8');
const stanzas = txt.split(/\n\n+/);
const found = new Map();
for (const s of stanzas) {
  const m = /^Package: (.+)$/m.exec(s);
  if (!m || !want.includes(m[1])) continue;
  const f = /^Filename: (.+)$/m.exec(s);
  const v = /^Version: (.+)$/m.exec(s);
  if (!f) continue;
  const prev = found.get(m[1]);
  if (!prev || v[1] > prev.version) found.set(m[1], { file: f[1], version: v[1] });
}
mkdirSync('.debs', { recursive: true });
for (const [pkg, { file, version }] of found) {
  const base = file.split('/').pop();
  console.log(pkg, version, base);
  execFileSync('curl', ['-sSL', '--retry', '6', '--retry-all-errors', '--retry-delay', '2', '--max-time', '120', `https://deb.debian.org/debian/${file}`, '-o', `.debs/${base}`]);
}
const missing = want.filter(w => !found.has(w));
if (missing.length) { console.error('MISSING:', missing.join(' ')); process.exit(1); }
