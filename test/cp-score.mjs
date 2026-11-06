// Clap circuit vs the real TR-808 recording: envelope and spectrum distance.
//   node test/cp-score.mjs [C144=.. TM3=.. ...]   (overrides CP_PARTS)
import { readFileSync } from 'node:fs';
import { parseWav } from '../dsp/wav.js';
import { CP_PARTS } from '../voices/cpma-circuit.js';
const SR = 48000;
if (import.meta.url === `file://${process.argv[1]}`) for (const a of process.argv.slice(2)) if (a.includes('=')) { const [k, v] = a.split('='); CP_PARTS[k] = +v; }
const { CPCircuit } = await import('../voices/cpma-circuit.js');
const { NoiseBus } = await import('../dsp/noise.js');
function resample(d, from) { const n = Math.floor(d.length * SR / from), o = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i * from / SR, k = Math.floor(x), f = x - k; o[i] = (d[k] ?? 0) * (1 - f) + (d[k + 1] ?? 0) * f; } return o; }
function onset(x) { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.05 * p) return i; return 0; }
export function realClap() { const w = parseWav(readFileSync(new URL('../cache/808/CP/CP.WAV', import.meta.url))); const r = resample(w.data, w.sr); return r.subarray(Math.max(0, onset(r) - 24)); }
export function circuitClap(seed = 0x808, secs = 0.8) {
  const shared = { noise: new NoiseBus(SR, seed) }, v = new CPCircuit(SR, shared); v.set('level', 1);
  const N = Math.round(SR * secs), o = new Float32Array(N), b = new Float32Array(1);
  v.trigger(0); for (let i = 0; i < N; i++) { shared.noise.render(1); b[0] = 0; v.render(b, 1); o[i] = b[0]; }
  return o.subarray(Math.max(0, onset(o) - 24));
}
const rmsAt = (x, a, ms) => { const i0 = Math.round(a * SR / 1000), n = Math.round(ms * SR / 1000); let s = 0; for (let i = i0; i < i0 + n; i++) s += (x[i] ?? 0) ** 2; return Math.sqrt(s / n); };
// envelope in dB re the loudest 2 ms frame: 2 ms frames to 120 ms, 20 ms frames to 600 ms
export function envelope(x) {
  const e = []; for (let t = 0; t < 120; t += 2) e.push(rmsAt(x, t, 2)); const p = Math.max(...e);
  for (let t = 120; t < 600; t += 20) e.push(rmsAt(x, t, 20));
  return e.map((v) => 20 * Math.log10(v / p + 1e-6));
}
function band(s, f) { const w0 = 2 * Math.PI * f / SR; let re = 0, im = 0; for (let i = 0; i < s.length; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / s.length); re += s[i] * h * Math.cos(w0 * i); im += s[i] * h * Math.sin(w0 * i); } return re * re + im * im; }
export function spectrum(x, a, b) { const s = x.subarray(Math.round(a * SR), Math.round(b * SR)), o = []; for (let f = 250; f < 10000; f *= 2 ** (1 / 3)) { let p = 0; for (let d = -3; d <= 3; d++) p += band(s, f * 2 ** (d / 21)); o.push(10 * Math.log10(p + 1e-20)); } const m = Math.max(...o); return o.map((v) => v - m); }
const gap = (a, b) => a.reduce((s, v, i) => s + Math.abs(Math.max(v, -60) - Math.max(b[i], -60)), 0) / a.length;
export function score(x, R) {
  const eA = envelope(x), eB = envelope(R);
  return { envE: gap(eA.slice(0, 60), eB.slice(0, 60)), envT: gap(eA.slice(60), eB.slice(60)), spB: gap(spectrum(x, 0, 0.035), spectrum(R, 0, 0.035)), spT: gap(spectrum(x, 0.06, 0.3), spectrum(R, 0.06, 0.3)) };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const R = realClap(), seeds = [0x808, 0x1234567, 0xbeef];
  const S = seeds.map((s) => score(circuitClap(s), R)); const m = (k) => (S.reduce((a, s) => a + s[k], 0) / S.length).toFixed(2);
  const x = circuitClap(); const eA = envelope(x), eR = envelope(R);
  console.log('parts', JSON.stringify(CP_PARTS));
  console.log(`env 0-120ms ${m('envE')} dB  tail ${m('envT')} dB  spectrum bursts ${m('spB')} tail ${m('spT')}  total ${(+m('envE') + +m('envT') + +m('spB') + +m('spT')).toFixed(2)}`);
  if (process.argv.includes('-v') || true) {
    console.log('env 2ms  real:', eR.slice(0, 30).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('env 2ms  ckt :', eA.slice(0, 30).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('env 2ms  real:', eR.slice(30, 60).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('env 2ms  ckt :', eA.slice(30, 60).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('tail20ms real:', eR.slice(60).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('tail20ms ckt :', eA.slice(60).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('spec burst real:', spectrum(R, 0, 0.035).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('spec burst ckt :', spectrum(x, 0, 0.035).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('spec tail  real:', spectrum(R, 0.06, 0.3).map((v) => v.toFixed(0).padStart(4)).join(''));
    console.log('spec tail  ckt :', spectrum(x, 0.06, 0.3).map((v) => v.toFixed(0).padStart(4)).join(''));
    let a = 0, b = 0; for (const v of x) { a = Math.max(a, v); b = Math.min(b, v); } console.log('Vpp', (a - b).toFixed(2));
  }
}
