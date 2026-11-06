// Fit the clap circuit's uncertain parts to the real TR-808 recording
// (test/cp-score.mjs), Nelder-Mead in log space.
//   node test/cp-fit.mjs C144 TM3 C127 ...
import { CP_PARTS } from '../voices/cpma-circuit.js';
import { realClap, circuitClap, score } from './cp-score.mjs';
import { features, distance } from './features.mjs';
const keys = process.argv.slice(2), R = realClap(), seeds = [0x808, 0x1234567, 0xbeef];
const vpp = (x) => { let a = 0, b = 0; for (const v of x) { a = Math.max(a, v); b = Math.min(b, v); } return a - b; };
// score = test/vs808.mjs's distance (recording scaled to the circuit's level,
// as the bench does) plus twice the clap-gap term of test/cp-score.mjs
const N = Math.round(1.2 * 48000);
const x0 = keys.map((k) => Math.log(CP_PARTS[k]));
function f(x) {
  keys.forEach((k, i) => { CP_PARTS[k] = Math.exp(x[i]); });
  let s = 0; for (const sd of seeds) {
    const c = circuitClap(sd, 1.25).slice(0, N), k = vpp(c) / vpp(R), r = R.slice(0, N).map((v) => v * k);
    s += distance(features(r), features(c)).score + 2 * score(c, R).art;
  }
  return Number.isFinite(s) ? s / seeds.length : 1e3;
}
let P = [x0, ...x0.map((_, i) => x0.map((v, j) => v + (i === j ? 0.15 : 0)))].map((x) => ({ x, y: f(x) }));
for (let it = 0; it < +(process.env.ITERS ?? 40); it++) {
  P.sort((a, b) => a.y - b.y);
  const n = keys.length, c = P[0].x.map((_, j) => P.slice(0, n).reduce((s, p) => s + p.x[j], 0) / n);
  const w = P[n], at = (t) => c.map((v, j) => v + t * (w.x[j] - v));
  const r = { x: at(-1) }; r.y = f(r.x);
  if (r.y < P[0].y) { const e = { x: at(-2) }; e.y = f(e.x); P[n] = e.y < r.y ? e : r; }
  else if (r.y < P[n - 1].y) P[n] = r;
  else { const k = { x: at(0.5) }; k.y = f(k.x); if (k.y < w.y) P[n] = k; else P = P.map((p, i) => i === 0 ? p : ((q) => ({ x: q, y: f(q) }))(p.x.map((v, j) => (v + P[0].x[j]) / 2))); }
  console.log(it, P[0].y.toFixed(3), keys.map((k, i) => `${k}=${Math.exp(P[0].x[i]).toPrecision(3)}`).join(' '));
}
