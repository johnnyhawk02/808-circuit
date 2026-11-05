// Per-voice / per-stage cost of the circuit kit on the dense cpu.mjs pattern.
//   node test/profile.mjs
import { Circuit } from '../dsp/mna.js';
import { Kit } from '../dsp/kit.js';
const SR = 48000;
const P = Circuit.prototype, step0 = P.step, build0 = P._buildBase;
P.step = function (...a) { const s = (this._st ??= { steps: 0, iters: 0, builds: 0, ms: 0, kSum: 0 }); s.steps++; const r = step0.apply(this, a); s.iters += this.iters; s.kSum += this.k; return r; };
P._buildBase = function (...a) { const s = (this._st ??= { steps: 0, iters: 0, builds: 0, ms: 0, kSum: 0 }); s.builds++; return build0.apply(this, a); };
const kit = new Kit(SR); kit.setAllModels('circuit');
for (const c of [kit.shared.noise.ckt, kit.shared.metal.ckt, ...Object.values(kit.circuit).flatMap((v) => v.stages ?? [v.ckt])]) c._st = null;
const pat = { bd: 'x...x...x...x...', sd: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', oh: '..............x.',
  lt: '.........x......', mt: '..........x.....', ht: '...........x....', cp: '....x.......x...', rs: '...x......x.....',
  cb: '......x.......x.', cy: 'x...............', ma: '.x.x.x.x.x.x.x.x', cl: '.......x........', lc: '..x.............', mc: '.....x..........', hc: '.............x..' };
const step = SR * 60 / 120 / 4, bars = 4;
for (let b = 0; b < bars; b++) for (let s = 0; s < 16; s++) for (const [id, p] of Object.entries(pat)) if (p[s] === 'x') kit.trigger(id, s % 4 === 0 ? 1 : 0, Math.round((b * 16 + s) * step));
// time each voice's render
const tv = {};
for (const [id, v] of Object.entries(kit.circuit)) { const r = v.render.bind(v); v.render = (o, n) => { const t = performance.now(); r(o, n); tv[id] = (tv[id] ?? 0) + performance.now() - t; }; }
for (const [name, o] of [['noise', kit.shared.noise], ['metal', kit.shared.metal]]) { const r = o.render.bind(o); o.render = (n) => { const t = performance.now(); r(n); tv[name] = (tv[name] ?? 0) + performance.now() - t; }; }
const n = Math.round(bars * 16 * step), out = new Float32Array(128);
const t0 = performance.now();
for (let i = 0; i < n; i += 128) kit.render(out, 128);
const total = performance.now() - t0, secs = n / SR;
const rows = [];
const add = (id, c, si) => { const s = c._st ?? { steps: 0, iters: 0, builds: 0, kSum: 0 }; rows.push({ id, stage: si, n: c.n, 'k avg': s.steps ? +(s.kSum / s.steps).toFixed(1) : 0, steps: s.steps, 'iters/step': s.steps ? +(s.iters / s.steps).toFixed(2) : 0, builds: s.builds }); };
add('noise', kit.shared.noise.ckt, 0); add('metal', kit.shared.metal.ckt, 0);
for (const [id, v] of Object.entries(kit.circuit)) (v.stages ?? [v.ckt]).forEach((c, i) => add(id, c, i));
console.table(rows);
console.table(Object.entries(tv).sort((a, b) => b[1] - a[1]).map(([id, ms]) => ({ id, '% core': +(100 * ms / 1000 / secs).toFixed(1) })));
console.log(`total ${(100 * total / 1000 / secs).toFixed(0)}% of one core`);
