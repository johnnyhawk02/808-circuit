// Apply the JSON line printed by test/fit.mjs to a voice file's FIT block.
//   node test/apply-fit.mjs <id> <fit-output.txt>
import { readFileSync, writeFileSync } from 'node:fs';
const [id, file] = process.argv.slice(2);
const mods = { bd: 'bd', sd: 'sd', lt: 'tom', mt: 'tom', ht: 'tom', lc: 'tom', mc: 'tom', hc: 'tom', rs: 'rs', cl: 'cl', cp: 'cp', ma: 'ma', cb: 'cb', cy: 'cy', oh: 'hats', ch: 'hats' };
const vals = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').pop());
const path = new URL(`../voices/${mods[id]}.js`, import.meta.url);
const src = readFileSync(path, 'utf8');
let a = src.indexOf('export const FIT = {'), b = src.indexOf('\n};', a);
const nested = new RegExp(`\\n  ${id}: \\{`).exec(src.slice(a, b));
if (nested) { a += nested.index; b = src.indexOf('}', a + 5); }
let blk = src.slice(a, b);
for (const [k, v] of Object.entries(vals)) {
  if (v == null) continue;
  const re = new RegExp(`(\\b${k}:\\s*)(-?[0-9.]+(?:e-?[0-9]+)?)`);
  if (!re.test(blk)) { console.error('not in FIT:', k); continue; }
  blk = blk.replace(re, `$1${v}`);
}
writeFileSync(path, src.slice(0, a) + blk + src.slice(b));
console.log('updated', id);
