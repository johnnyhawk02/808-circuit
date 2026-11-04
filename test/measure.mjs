// Offline check: render every voice the way the manual's CHECKING VOICES
// procedure does (p.14) and compare against its table. Also writes a WAV
// per voice and model (normal + accent hit) to ./renders.
//   node test/measure.mjs            both models side by side
//   node test/measure.mjs circuit    one model only
import { writeFileSync, mkdirSync } from 'node:fs';
import { Kit, VOICES, VOLT_SCALE } from '../dsp/kit.js';

const SR = 48000;
const EXPECT = { // Vpp normal, accent; freq Hz (mid / H,L); decay ms (mid)
  bd: [3.5, 10, [56], 300], sd: [3, 10, [476, 238], 60],
  lc: [3.5, 12, [185], 180], lt: [3.5, 12, [90], 200],
  mc: [3, 10, [280], 100], mt: [3, 11, [135], 130],
  hc: [3.5, 12, [400], 80], ht: [3.5, 12, [185], 100],
  cl: [2.5, 8, [2500], 25], rs: [3, 10, [1667, 455], 10],
  ma: [3, 5, [], 30], cp: [6, null, [], 100],
  cb: [3.5, 12, [800, 540], 50], cy: [3.5, 7, [], 800],
  oh: [3.5, 7, [], 450], ch: [3, 6, [], 50],
};

function renderVolts(id, accent, secs, trim, model = 'behavioural') {
  const kit = new Kit(SR, { circuits: model === 'circuit' });
  kit.solo = id;
  kit.master = 1;
  kit.setModel(id, trim ? 'behavioural' : model); // trims only apply to the behavioural voices
  kit.set(id, 'level', 1); // manual: VOICE LEVEL fully clockwise, other knobs 12 o'clock
  if (trim) { kit.voices[id].trimN = trim[0]; kit.voices[id].trimA = trim[1]; }
  const n = Math.round(secs * SR), out = new Float32Array(n);
  kit.trigger(id, accent, 0);
  // render in volts: bypass master limiter by scaling back
  kit.render(out, n);
  for (let i = 0; i < n; i++) out[i] /= VOLT_SCALE;
  return out;
}

function vpp(x) { let lo = 0, hi = 0; for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; }

// time until the windowed peak amplitude falls below 1/10 of the overall peak
function decay10(x) {
  const w = Math.round(SR * 0.002); let peak = 0, pk = [];
  for (let i = 0; i < x.length; i += w) { let m = 0; for (let j = i; j < i + w && j < x.length; j++) m = Math.max(m, Math.abs(x[j])); pk.push(m); peak = Math.max(peak, m); }
  let last = 0; pk.forEach((m, i) => { if (m >= peak / 10) last = i; });
  return ((last + 1) * w / SR) * 1000;
}

// strongest spectral peaks (Goertzel scan, 20 Hz - 4 kHz)
function peaks(x, count) {
  const seg = x.subarray(0, Math.min(x.length, SR * 0.25));
  const res = [];
  for (let f = 20; f <= 4000; f *= 1.004) {
    const k = 2 * Math.cos(2 * Math.PI * f / SR); let s1 = 0, s2 = 0;
    for (let i = 0; i < seg.length; i++) { const s0 = seg[i] + k * s1 - s2; s2 = s1; s1 = s0; }
    res.push([f, s1 * s1 + s2 * s2 - k * s1 * s2]);
  }
  const loc = res.filter((r, i) => i > 0 && i < res.length - 1 && r[1] > res[i - 1][1] && r[1] >= res[i + 1][1]);
  loc.sort((a, b) => b[1] - a[1]);
  return loc.slice(0, count).map((r) => Math.round(r[0]));
}

function wav(path, data) {
  const n = data.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}

if (process.argv.includes('--calibrate')) {
  // The synth voices are calibrated to the circuit models now, not the table.
  console.log('use: node test/ref-render.mjs all && node test/calibrate.mjs'); process.exit(0);
}

mkdirSync(new URL('../renders/', import.meta.url), { recursive: true });
const arg = process.argv[2];
const MODELS = arg === 'circuit' || arg === 'behavioural' ? [arg] : ['circuit', 'behavioural'];
const rows = [];
let bad = 0;
for (const [id] of VOICES) {
  const [vN, vA, fx, dx] = EXPECT[id];
  const row = { id };
  const cell = (k, s) => { row[k] = (row[k] ? row[k] + ' | ' : '') + s; };
  for (const model of MODELS) {
    const norm = renderVolts(id, 0, 2, null, model), acc = renderVolts(id, 1, 2, null, model);
    const mN = vpp(norm), mA = vpp(acc), d = decay10(norm), pf = peaks(norm, Math.max(1, fx.length));
    for (const v of [...norm, ...acc]) if (!Number.isFinite(v)) { bad++; break; }
    cell('Vpp', `${mN.toFixed(1)}/${mA.toFixed(1)}`);
    cell('Hz', pf.sort((a, b) => b - a).join('/'));
    cell('decay_ms', d.toFixed(0));
    // WAV: normal hit, then the accent hit, at digital scale
    const len = Math.round(SR * 1.6), out = new Float32Array(len * 2);
    for (let i = 0; i < len; i++) { out[i] = norm[i] * VOLT_SCALE * 1.6; out[len + i] = acc[i] * VOLT_SCALE * 1.6; }
    wav(new URL(`../renders/${id}-${model}.wav`, import.meta.url), out);
  }
  cell('Vpp', `manual ${vN}/${vA ?? '-'}`); cell('Hz', `manual ${fx.join('/') || '-'}`); cell('decay_ms', `manual ${dx}`);
  rows.push(row);
}
console.log('columns: ' + MODELS.join(' | ') + ' | manual   (Vpp normal/accent, strongest peaks, decay to -20 dB)');
console.table(rows);
if (bad) { console.error('non-finite samples in', bad, 'voices'); process.exit(1); }
