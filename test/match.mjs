// How closely each behavioural voice follows its circuit model.
//   node test/ref-render.mjs all     once, after any circuit change (slow)
//   node test/match.mjs [ids...]     compare (fast)
// Per knob case: level error (dB, Vpp), and mean dB distance of the RMS
// envelope, the 1/3-octave spectrogram and the 1/12-octave long-term spectrum.
import { readFileSync, existsSync } from 'node:fs';
import { Kit } from '../dsp/kit.js';
import { cases, render, VOICES, SR } from './match-lib.mjs';
import { features, distance } from './features.mjs';

export function loadRef(id, cs) {
  const p = new URL(`./.cache/${id}-${cs.name}.f32`, import.meta.url);
  if (!existsSync(p)) return null;
  const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
export function compare(id, refCache = {}) {
  const rows = [];
  for (const cs of cases(id)) {
    const key = id + cs.name;
    const ref = refCache[key] ?? (refCache[key] = (() => { const r = loadRef(id, cs); return r && features(r); })());
    if (!ref) continue;
    const got = features(render(id, 'behavioural', cs));
    rows.push({ case: cs.name, ...distance(ref, got), refVpp: ref.vpp, gotVpp: got.vpp, levelOnly: cs.levelOnly });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : VOICES.map(([v]) => v);
  const summary = [];
  for (const id of ids) {
    const rows = compare(id);
    if (!rows.length) { console.log(id, 'no reference (run test/ref-render.mjs)'); continue; }
    const f = (v) => v.toFixed(1);
    if (ids.length === 1 || process.argv.includes('-v')) console.table(rows.map((r) => ({ case: r.case, lvl_dB: f(r.lvl), env: f(r.env), spg: f(r.spg), lts: f(r.lts), score: f(r.score), Vpp: `${r.refVpp.toFixed(2)} / ${r.gotVpp.toFixed(2)}` })));
    const full = rows.filter((r) => !r.levelOnly);
    const m = (k) => full.reduce((a, r) => a + Math.abs(r[k]), 0) / full.length;
    // floor: the circuit against itself with other noise / oscillator phases
    const cs0 = cases(id)[0], alt = loadRef(id, { name: 'alt' }), ref0 = loadRef(id, cs0);
    const floor = alt ? distance(features(ref0), features(alt)).score.toFixed(1) : '-';
    summary.push({ id, floor, lvl_dB: f(m('lvl')), env: f(m('env')), spg: f(m('spg')), lts: f(m('lts')), score: f(m('score')) });
  }
  console.table(summary);
}
