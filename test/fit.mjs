// Fit a behavioural voice's FIT constants to its circuit model.
//   node test/fit.mjs <id> key1 key2 ... [--iters 300] [--wave 0.5] [--cases n,a,...]
// Each voice module exports FIT (plain numbers). Positive keys are searched in
// log space (Nelder-Mead); the score is test/match.mjs's, summed over the knob
// cases, plus optionally a waveform term (first 60 ms, deterministic voices).
import { Kit } from '../dsp/kit.js';
import { cases, render } from './match-lib.mjs';
import { loadRef } from './match.mjs';
import { features, distance } from './features.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const write = args.includes('--write'); if (write) args.splice(args.indexOf('--write'), 1);
const iters = +opt('iters', 250), waveW = +opt('wave', 0), only = opt('cases', null), quiet = opt('quiet', null);
const [id, ...keys] = args;
const mods = { bd: 'bd', sd: 'sd', lt: 'tom', mt: 'tom', ht: 'tom', lc: 'tom', mc: 'tom', hc: 'tom', rs: 'rs', cl: 'cl', cp: 'cp', ma: 'ma', cb: 'cb', cy: 'cy', oh: 'hats', ch: 'hats' };
const mod = await import(`../voices/${mods[id]}.js`);
const FIT = mod.FIT[id] ?? mod.FIT;
const list = cases(id).filter((c) => !c.levelOnly && (!only || only.split(',').includes(c.name)));
const refs = list.map((cs) => { const r = loadRef(id, cs); return { cs, raw: r, f: features(r) }; });
const kit = new Kit(48000, { circuits: false });

function score() {
  let s = 0;
  for (const { cs, raw, f } of refs) {
    const k = new Kit(48000, { circuits: false });
    k.voices[id].trimN = k.voices[id].trimA = 1;
    const x = render(id, 'behavioural', cs, { kit: k });
    s += distance(f, features(x)).score;
    if (waveW) {
      const n = Math.min(raw.length, 2880); let e = 0, r = 0;
      for (let i = 0; i < n; i++) { e += (raw[i] - x[i]) ** 2; r += raw[i] ** 2; }
      s += waveW * 10 * Math.log10(e / r + 1e-3) + waveW * 30;
    }
  }
  return s / refs.length;
}
const sign = keys.map((k) => (FIT[k] > 0 ? 1 : FIT[k] < 0 ? -1 : 0));
const toX = () => keys.map((k, i) => (sign[i] ? Math.log(Math.abs(FIT[k])) : FIT[k]));
const setX = (x) => keys.forEach((k, i) => { FIT[k] = sign[i] ? sign[i] * Math.exp(x[i]) : x[i]; });
const f = (x) => { setX(x); return score(); };

// Nelder-Mead
let x0 = toX(), n = keys.length;
let simplex = [x0, ...keys.map((_, i) => { const x = x0.slice(); x[i] += sign[i] ? 0.25 : 0.1 * (Math.abs(x[i]) || 1); return x; })];
let vals = simplex.map(f);
console.log('start', vals[0].toFixed(3));
for (let it = 0; it < iters; it++) {
  const ord = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
  simplex = ord.map((i) => simplex[i]); vals = ord.map((i) => vals[i]);
  const c = x0.map((_, j) => simplex.slice(0, n).reduce((a, x) => a + x[j], 0) / n);
  const pt = (t) => c.map((cj, j) => cj + t * (simplex[n][j] - cj));
  const xr = pt(-1), fr = f(xr);
  if (fr < vals[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; } }
  else if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; }
  else {
    const xc = pt(fr < vals[n] ? -0.5 : 0.5), fc = f(xc);
    if (fc < Math.min(fr, vals[n])) { simplex[n] = xc; vals[n] = fc; }
    else for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); vals[i] = f(simplex[i]); }
  }
  if (!quiet && it % 25 === 0) console.log(it, vals[0].toFixed(3));
  if (Math.max(...vals) - Math.min(...vals) < 1e-3) break;
}
const best = vals.indexOf(Math.min(...vals));
setX(simplex[best]);
console.log('best', vals[best].toFixed(3));
console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, +FIT[k].toPrecision(4)]))));
if (write) {
  // patch the numbers into the voice file's FIT block
  const path = new URL(`../voices/${mods[id]}.js`, import.meta.url);
  let src = readFileSync(path, 'utf8');
  let a = src.indexOf('export const FIT = {'), b = src.indexOf('\n};', a);
  if (mod.FIT[id]) { a = src.indexOf(`\n  ${id}: {`, a); b = src.indexOf('}', a + 5); }
  let blk = src.slice(a, b);
  for (const k of keys) {
    const re = new RegExp(`(\\b${k}:\\s*)(-?[0-9.]+(?:e-?[0-9]+)?)`);
    if (!re.test(blk)) { console.error('not found in FIT:', k); continue; }
    blk = blk.replace(re, `$1${+FIT[k].toPrecision(4)}`);
  }
  writeFileSync(path, src.slice(0, a) + blk + src.slice(b));
  console.log('wrote', path.pathname);
}
