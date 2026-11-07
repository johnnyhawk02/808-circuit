// Reference renders from the JS voices, for the C++ port to match (vst/tests/voices.cpp).
//   node vst/tests/ref-voices.mjs <outdir> [sr] [seconds]
// For each voice: the circuit model, a normal hit then an accented one (0.6 s later), 64-sample blocks as the app's
// player renders them, each voice into its own buffer (kit.split). Writes <id>.f32 (float32 LE).
import { Kit, VOICES } from '../../dsp/kit.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const out = process.argv[2] || '/tmp/ref', sr = Number(process.argv[3] || 44140), secs = Number(process.argv[4] || 1.5);
const only = process.argv[5];
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const kit = new Kit(sr);
console.log('kit built', Date.now() - t0, 'ms');
kit.setAllModels('circuit'); kit.master = 1;
const KV = process.env.KNOBS ? Number(process.env.KNOBS) : null;
if (KV !== null) for (const v of kit.spec()) for (const q of v.params) if (q.id !== 'accent') kit.set(v.id, q.id, q.id === 'drive' ? KV / 2 : KV);
const split = {}; for (const [id] of VOICES) split[id] = new Float32Array(64);
kit.split = split;
const mix = new Float32Array(64);
for (const [id] of VOICES) {
  if (only && id !== only) continue;
  const n = Math.round(secs * sr / 64) * 64, y = new Float32Array(n);
  const t1 = Date.now();
  for (let b = 0; b < n / 64; b++) {
    if (b === 0) kit._fire(id, 0);
    if (b === Math.round(0.6 * sr / 64)) kit._fire(id, 1);
    for (const k in split) split[k].fill(0);
    kit.render(mix, 64);
    y.set(split[id], b * 64);
  }
  writeFileSync(`${out}/${id}.f32`, Buffer.from(y.buffer));
  console.log(id, Date.now() - t1, 'ms');
}
