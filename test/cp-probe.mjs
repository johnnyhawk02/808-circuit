// Clap circuit internals over one hit: comparator window, C144 sawtooth,
// OTA bias current and the two paths into the mixer.
//   node test/cp-probe.mjs
import { CPCircuit } from '../voices/cpma-circuit.js';
import { NoiseBus } from '../dsp/noise.js';
const SR = 48000, shared = { noise: new NoiseBus(SR) };
const v = new CPCircuit(SR, shared); v.set('level', 1);
const N = Math.round(SR * 0.5), b = new Float32Array(1);
const P = { OC: [v.s3, 'OC'], OB: [v.s3, 'OB'], SAW: [v.s3, 'SAW'], IA: [v.s3x, 'IA'], B72: [v.s3x, 'B72'], B71: [v.s3x, 'B71'], C70: [v.s4, 'C70'], B70: [v.s4, 'B70'], E70: [v.s4, 'E70'], BUF: [v.s4, 'BUF'], OUT: [v.s4, 'OUT'] };
const rec = Object.fromEntries(Object.keys(P).map((k) => [k, new Float32Array(N)]));
v.trigger(0);
for (let i = 0; i < N; i++) { shared.noise.render(1); b[0] = 0; v.render(b, 1); for (const k in P) rec[k][i] = P[k][0].v[P[k][0].idx[P[k][1]]]; }
const at = (k, ms) => rec[k][Math.min(N - 1, Math.round(Math.max(0, ms) * SR / 1000))];
const rms = (k, a, z) => { let s = 0, m = 0; const i0 = Math.round(a * SR / 1000), i1 = Math.round(z * SR / 1000); for (let i = i0; i < i1; i++) m += rec[k][i]; m /= i1 - i0; for (let i = i0; i < i1; i++) s += (rec[k][i] - m) ** 2; return Math.sqrt(s / (i1 - i0)); };
console.log('ms     OC     OB    SAW    B72    B71  Iabc_uA  E70   B70  | rms BUF   C70   OUT');
for (const t of [-0.1, 0.5, 1, 2, 4, 6, 8, 10, 11, 12, 13, 14, 16, 20, 24, 26, 27, 28, 30, 32, 35, 40, 50, 60, 80, 100, 150, 200, 300, 400])
  console.log(String(t).padStart(5), ['OC', 'OB', 'SAW', 'B72', 'B71'].map((k) => at(k, Math.max(0, t)).toFixed(2).padStart(6)).join(' '),
    ((at('IA', t) + 13.8) / 10e3 * 1e6).toFixed(0).padStart(7), at('E70', t).toFixed(2).padStart(6), at('B70', t).toFixed(2).padStart(6), ' |',
    ['BUF', 'C70', 'OUT'].map((k) => rms(k, Math.max(0, t), Math.max(0, t) + 2).toFixed(3).padStart(6)).join(''));
// Q73 dump times
const d = []; for (let i = 1; i < N; i++) if (rec.SAW[i] < rec.SAW[i - 1] - 0.5) { if (!d.length || i - d[d.length - 1] > 20) d.push(i); }
console.log('C144 dumps at ms:', d.map((i) => (i / SR * 1000).toFixed(1)).join(' '));
