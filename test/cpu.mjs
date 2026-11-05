// Real-time cost of the kit: a busy 16-step pattern at 120 BPM, 8 bars.
//   node test/cpu.mjs [circuit|behavioural] [dense|demo]
import { Kit, VOICES } from '../dsp/kit.js';
const SR = 48000, model = process.argv[2] ?? 'circuit', which = process.argv[3] ?? 'dense';
const kit = new Kit(SR); kit.setAllModels(model);
const pat = { bd: 'x...x...x...x...', sd: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', oh: '..............x.',
  lt: '.........x......', mt: '..........x.....', ht: '...........x....', cp: '....x.......x...', rs: '...x......x.....',
  cb: '......x.......x.', cy: 'x...............', ma: '.x.x.x.x.x.x.x.x', cl: '.......x........', lc: '..x.............', mc: '.....x..........', hc: '.............x..' };
// the bench page's demo pattern (fewer voices)
const DEMO = {
  bd: 'x.....x...x.....', sd: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', oh: '..............x.',
  cp: '....x.......x...', lc: '.........x....x.', mc: '...x..........x.', cb: '..........x..x..',
  rs: '.......x........', cl: '...............x', ma: 'x.xx.xx.x.xx.xx.',
};
if (which === 'demo') { for (const k in pat) delete pat[k]; Object.assign(pat, DEMO); }
const step = SR * 60 / 120 / 4, bars = 8;
for (let b = 0; b < bars; b++) for (let s = 0; s < 16; s++) for (const [id, p] of Object.entries(pat)) if (p[s] === 'x') kit.trigger(id, s % 4 === 0 ? 1 : 0, Math.round((b * 16 + s) * step));
const n = Math.round(bars * 16 * step), out = new Float32Array(128);
const t0 = performance.now(); let worst = 0, worstLate = 0;
for (let i = 0; i < n; i += 128) {
  const t = performance.now(); kit.render(out, 128); const d = performance.now() - t;
  worst = Math.max(worst, d); if (i > 2 * SR) worstLate = Math.max(worstLate, d); // after JIT warm-up
}
const ms = performance.now() - t0, secs = n / SR;
console.log(`${model} (${which}): ${(ms / 1000).toFixed(2)} s CPU for ${secs.toFixed(1)} s audio = ${(100 * ms / 1000 / secs).toFixed(0)}% of one core; worst 128-frame block ${worst.toFixed(2)} ms (${worstLate.toFixed(2)} ms after the first 2 s) (budget ${(128 / SR * 1000).toFixed(2)} ms)`);
