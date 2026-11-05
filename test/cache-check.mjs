// Plays the cached circuit hits in Node: CPU for the dense pattern and a
// comparison of one cached hit with a fresh circuit render.
//   node test/cache-check.mjs
import { readFileSync } from 'node:fs';
import { Kit, VOICES, VOLT_SCALE } from '../dsp/kit.js';
import { readWav } from '../dsp/cache.js';
const SR = 48000;
const index = JSON.parse(readFileSync(new URL('../cache/index.json', import.meta.url), 'utf8'));
const kit = new Kit(SR, { circuits: false });
let bytes = 0, secs = 0;
for (const [id] of VOICES) {
  if (!index[id]) { console.log('no cache for', id); continue; }
  const b = readFileSync(new URL(`../cache/${id}.wav`, import.meta.url));
  const pcm = readWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  kit.loadCache(id, index[id], pcm); kit.setModel(id, 'cached');
  bytes += b.length; secs += pcm.length / index[id].sr;
}
console.log(`cache: ${(bytes / 1e6).toFixed(1)} MB of WAV, ${secs.toFixed(0)} s of audio, ~${(secs * SR * 4 / 1e6).toFixed(0)} MB as float32 at the host's 48 kHz (${(secs * index.bd.sr * 4 / 1e6).toFixed(0)} MB at 32 kHz)`);
const pat = { bd: 'x...x...x...x...', sd: '....x.......x...', ch: 'x.x.x.x.x.x.x.x.', oh: '..............x.',
  lt: '.........x......', mt: '..........x.....', ht: '...........x....', cp: '....x.......x...', rs: '...x......x.....',
  cb: '......x.......x.', cy: 'x...............', ma: '.x.x.x.x.x.x.x.x', cl: '.......x........', lc: '..x.............', mc: '.....x..........', hc: '.............x..' };
const step = SR * 60 / 120 / 4, bars = 8;
for (let b = 0; b < bars; b++) for (let s = 0; s < 16; s++) for (const [id, p] of Object.entries(pat)) if (p[s] === 'x') kit.trigger(id, s % 4 === 0 ? 1 : 0, Math.round((b * 16 + s) * step));
const n = Math.round(bars * 16 * step), out = new Float32Array(128);
let peak = 0; const t0 = performance.now();
for (let i = 0; i < n; i += 128) { kit.render(out, 128); for (const x of out) peak = Math.max(peak, Math.abs(x)); }
const ms = performance.now() - t0;
console.log(`dense pattern, all cached: ${(100 * ms / 1000 / (n / SR)).toFixed(1)}% of one core, peak ${peak.toFixed(2)} FS`);
