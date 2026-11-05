// Circuit-model regression check for solver / speed changes.
//   node test/regress.mjs save     render every circuit voice, keep as reference
//   node test/regress.mjs [ids..]  render again and compare with the reference
//   REF=name selects another reference set (test/.cache/<name>/)
// Cases: default knobs (normal + accent hit) and each knob at both ends.
// Reported per voice (worst case): error-to-signal ratio of the waveform
// (dB, lower is closer; -60 = the difference is 1/1000 of the signal),
// largest gap between the 10 ms RMS envelopes in the part above -40 dB,
// mean gap between the long-term 1/3-octave spectra (dB, bands within 40 dB
// of the loudest), and the change in peak-to-peak level.
// The waveform error is only meaningful for voices without metal or noise
// sources: those are sensitive to the Newton tolerance itself (the same
// solver with the tolerance 10% tighter gives a different waveform with the
// same sound). `node test/regress.mjs floor [ids..]` shows that spread: it
// compares the reference against the current code with tol x 0.9.
// `node test/regress.mjs alt [ids..]` gives the hit-to-hit spread of the
// voice itself: the noise generator and the free-running metal oscillators
// start in another state (as they would on the real machine).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Kit, VOICES, VOLT_SCALE } from '../dsp/kit.js';
import { Circuit } from '../dsp/mna.js';
const SR = 48000, LONG = { cy: 3, oh: 2.5, bd: 2, lt: 1.5 };
const dir = new URL(`./.cache/${process.env.REF ?? 'regress'}/`, import.meta.url);
const save = process.argv[2] === 'save', floor = process.argv[2] === 'floor', alt = process.argv[2] === 'alt';
const args = process.argv.slice(floor || alt ? 3 : 2);
const ids = save || !args.length ? VOICES.map(([id]) => id) : args;
// TOL_SCALE=x scales every Newton tolerance (floor: 0.9)
const tolScale = +(process.env.TOL_SCALE ?? (floor ? 0.9 : 1));
if (tolScale !== 1) { const s0 = Circuit.prototype.step; Circuit.prototype.step = function (m, tol = this.tol) { return s0.call(this, m, tol * tolScale); }; }

function cases(id) {
  const spec = new Kit(SR, { circuits: false }).spec().find((s) => s.id === id), secs = LONG[id] ?? 1.2;
  const out = [{ name: 'n', accent: 0, knobs: {} }, { name: 'a', accent: 1, knobs: {} }];
  for (const p of spec.params) if (p.id !== 'level') for (const v of [0, 1]) out.push({ name: p.id + v, accent: 0, knobs: { [p.id]: v } });
  return out.map((c) => ({ ...c, secs }));
}
function render(id, cs) {
  const kit = new Kit(SR); kit.solo = id; kit.master = 1; kit.setModel(id, 'circuit');
  if (alt) { kit.shared.noise.s = 0x1234567; kit.shared.metal.osc.forEach((o, i) => { o.vc = 2.2 + 0.6 * ((i * 0.61 + 0.3) % 1); }); }
  for (const p of kit.voices[id].params) kit.set(id, p.id, p.id === 'level' ? 1 : 0.5);
  for (const [k, v] of Object.entries(cs.knobs)) kit.set(id, k, v);
  // a second hit 0.3 s in checks that the voice re-triggers the same way
  const n = Math.round(cs.secs * SR), out = new Float32Array(n);
  kit.trigger(id, cs.accent, 0); kit.trigger(id, cs.accent, Math.round(0.3 * SR) + 7);
  const t0 = performance.now(); kit.render(out, n); const ms = performance.now() - t0;
  for (let i = 0; i < n; i++) out[i] /= VOLT_SCALE;
  return [out, ms / 1000 / cs.secs];
}
const env = (x) => { const w = 480, e = []; for (let i = 0; i + w <= x.length; i += w) { let s = 0; for (let j = i; j < i + w; j++) s += x[j] * x[j]; e.push(Math.sqrt(s / w)); } return e; };
const vpp = (x) => { let lo = 0, hi = 0; for (const s of x) { if (s < lo) lo = s; if (s > hi) hi = s; } return hi - lo; };
// 1/3-octave spectrogram, 2048-point Hann frames, hop 1024
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) {
      const u = i + j, t = u + len / 2, tr = re[t] * cr - im[t] * ci, ti = re[t] * ci + im[t] * cr;
      re[t] = re[u] - tr; im[t] = im[u] - ti; re[u] += tr; im[u] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
function spectro(x) {
  const N = 2048, edges = []; for (let f = 40; f < 20000; f *= 2 ** (1 / 3)) edges.push(Math.round(f / SR * N));
  const out = [];
  for (let o = 0; o + N <= x.length; o += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[o + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    fft(re, im);
    const row = [];
    for (let b = 0; b + 1 < edges.length; b++) { let e = 1e-20; for (let i = edges[b]; i < Math.max(edges[b + 1], edges[b] + 1); i++) e += re[i] * re[i] + im[i] * im[i]; row.push(10 * Math.log10(e)); }
    out.push(row);
  }
  return out;
}
function compare(ref, x) {
  let se = 0, ss = 0; for (let i = 0; i < ref.length; i++) { const d = x[i] - ref[i]; se += d * d; ss += ref[i] * ref[i]; }
  const er = env(ref), ex = env(x), top = Math.max(...er); let envDb = 0;
  for (let i = 0; i < er.length; i++) if (er[i] > top * 0.01) envDb = Math.max(envDb, Math.abs(20 * Math.log10((ex[i] + 1e-9) / (er[i] + 1e-9))));
  // long-term 1/3-octave spectrum (sum of the frames), bands within 40 dB
  const lt = (S) => S[0].map((_, b) => 10 * Math.log10(S.reduce((a, r) => a + 10 ** (r[b] / 10), 0)));
  const sr = lt(spectro(ref)), sx = lt(spectro(x)), fl = Math.max(...sr) - 40; let sum = 0, cnt = 0;
  for (let b = 0; b < sr.length; b++) if (sr[b] > fl) { sum += Math.abs(Math.max(sx[b], fl) - sr[b]); cnt++; }
  return { specDb: sum / cnt, esr: 10 * Math.log10((se + 1e-30) / (ss + 1e-30)), envDb, vppPct: 100 * (vpp(x) / vpp(ref) - 1), finite: x.every(Number.isFinite) };
}
mkdirSync(dir, { recursive: true });
const rows = [];
for (const id of ids) {
  let worst = { esr: -Infinity, envDb: 0, specDb: 0, vppPct: 0, finite: true }, cpu = 0, nc = 0;
  for (const cs of cases(id)) {
    const [x, load] = render(id, cs); cpu += load; nc++;
    const f = new URL(`${id}-${cs.name}.f32`, dir);
    if (save) { writeFileSync(f, Buffer.from(x.buffer)); continue; }
    if (!existsSync(f)) { console.log('no reference for', id, '- run save first'); process.exit(1); }
    const r = compare(new Float32Array(readFileSync(f).buffer.slice(0)), x);
    worst = { esr: Math.max(worst.esr, r.esr), envDb: Math.max(worst.envDb, r.envDb), specDb: Math.max(worst.specDb, r.specDb), vppPct: Math.abs(r.vppPct) > Math.abs(worst.vppPct) ? r.vppPct : worst.vppPct, finite: worst.finite && r.finite, at: r.esr >= worst.esr ? cs.name : worst.at };
  }
  rows.push(save ? { id, 'cpu %': +(100 * cpu / nc).toFixed(1) } : { id, 'error dB': +worst.esr.toFixed(1), 'worst case': worst.at, 'env gap dB': +worst.envDb.toFixed(2), 'spec gap dB': +worst.specDb.toFixed(2), 'Vpp %': +worst.vppPct.toFixed(2), 'cpu %': +(100 * cpu / nc).toFixed(1), ok: worst.finite ? '' : 'NaN!' });
}
console.table(rows);
