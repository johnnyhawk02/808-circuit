// Shared bits for the circuit-vs-behavioural match (test/match.mjs).
import { readFileSync } from 'node:fs';
import { Kit, VOICES, VOLT_SCALE } from '../dsp/kit.js';
import { sampleFiles } from '../dsp/sampler.js';
import { parseWav } from '../dsp/wav.js';

const wavCache = {};
export function loadSamplesInto(kit, id) {
  for (const [v, key, path] of sampleFiles()) if (v === id) {
    const w = wavCache[path] ?? (wavCache[path] = parseWav(readFileSync(new URL('../' + path, import.meta.url))));
    kit.loadSample(id, key, w);
  }
}
export const SR = 48000;

const LONG = { cy: 3, oh: 2.5, bd: 2, lt: 1.5 };
// Knob settings compared: default (normal + accent), each knob at both ends,
// and the level knob at 1/4 and 1/2 to get its taper.
export function cases(id) {
  const kit = new Kit(SR, { circuits: false });
  const spec = kit.spec().find((s) => s.id === id);
  const secs = LONG[id] ?? 1.2;
  const out = [{ name: 'n', accent: 0, knobs: {}, secs }, { name: 'a', accent: 1, knobs: {}, secs }];
  for (const p of spec.params) {
    if (p.id === 'level') continue;
    out.push({ name: `${p.id}0`, accent: 0, knobs: { [p.id]: 0 }, secs: secs * (p.id === 'decay' ? 0.6 : 1) });
    out.push({ name: `${p.id}1`, accent: 0, knobs: { [p.id]: 1 }, secs: secs * (p.id === 'decay' ? 1.6 : 1) });
  }
  out.push({ name: 'l25', accent: 0, knobs: { level: 0.25 }, secs: 0.4, levelOnly: true });
  out.push({ name: 'l50', accent: 0, knobs: { level: 0.5 }, secs: 0.4, levelOnly: true });
  return out;
}

// Render one hit, in volts, through the kit (shared noise / metal sources).
// opts.kit reuses a kit (behavioural fitting); trims come from calibration.
export function render(id, model, cs, opts = {}) {
  const kit = opts.kit ?? new Kit(SR, { circuits: model === 'circuit' });
  kit.solo = id; kit.master = 1; kit.setModel(id, model);
  if (model === 'sample') loadSamplesInto(kit, id);
  if (opts.alt) { // different noise seed and metal-oscillator phases
    kit.shared.noise.s = 0x1234567; for (const o of kit.shared.metal.osc) o.vc = 2.2 + 0.6 * Math.random();
    for (const o of kit.metal.osc) o.p = Math.random();
  }
  const v = kit.voices[id];
  const defs = Object.fromEntries(v.params.map((p) => [p.id, p.def]));
  for (const k in defs) kit.set(id, k, k === 'level' ? 1 : defs[k]); // knobs at their defaults (12 o'clock but for CP's SNAP)
  for (const [k, val] of Object.entries(cs.knobs)) kit.set(id, k, val);
  const n = Math.round(cs.secs * SR), out = new Float32Array(n);
  kit.trigger(id, cs.accent);
  kit.render(out, n);
  for (let i = 0; i < n; i++) out[i] /= VOLT_SCALE;
  return out;
}
export { VOICES };
