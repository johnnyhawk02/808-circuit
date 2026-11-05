// Side-by-side look at one knob case: circuit (cached) vs behavioural.
//   node test/analyze.mjs <id> [case]
import { cases, render } from './match-lib.mjs';
import { loadRef } from './match.mjs';
import { features } from './features.mjs';
const SR = 48000;
const [id, cname = 'n'] = process.argv.slice(2);
const cs = cases(id).find((c) => c.name === cname);
const ref = loadRef(id, cs), got = render(id, 'behavioural', cs);
function zc(x) { // pitch from zero crossings in 10 ms windows
  const z = []; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) z.push(i - x[i] / (x[i] - x[i - 1]));
  return (t) => { const a = z.filter((i) => i >= t * SR && i < (t + 0.04) * SR); return a.length > 1 ? (SR * (a.length - 1) / (a[a.length - 1] - a[0])).toFixed(0) : '-'; };
}
const zr = zc(ref), zg = zc(got), fr = features(ref), fg = features(got);
console.log(`Vpp ${fr.vpp.toFixed(2)} / ${fg.vpp.toFixed(2)}`);
const T = [0, 0.002, 0.004, 0.006, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0, 1.5, 2];
console.log('t_ms   env_dB ckt/beh    zcHz ckt/beh');
for (const t of T) { const k = Math.round(t * SR / 96); if (k >= fr.env.length) break;
  console.log(String(t * 1000).padStart(5), fr.env[k].toFixed(1).padStart(7), fg.env[k].toFixed(1).padStart(7), zr(t).padStart(7), zg(t).padStart(7)); }
// long-term spectrum, 1/12-oct bands from 25 Hz, every 3rd band
console.log('LTS (Hz ckt beh)');
const line = [];
for (let i = 0; i < fr.lts.length; i += 3) line.push(`${Math.round(25 * 2 ** (i / 12 + 1 / 24))}:${fr.lts[i].toFixed(0)}/${fg.lts[i].toFixed(0)}`);
console.log(line.join('  '));
if (process.argv.includes('--spg')) {
  const bands = fr.spg[0].length;
  console.log('spectrogram (1/3 oct from 40 Hz), rows = frames at 0,5,10,20,40,80,160 ms: ckt | beh');
  for (const t of [0, 1, 2, 4, 8, 16, 32]) if (fr.spg[t]) console.log(String(t * 5).padStart(4), fr.spg[t].map((v) => Math.max(-99, v).toFixed(0).padStart(4)).join(''), '\n    ', fg.spg[t].map((v) => Math.max(-99, v).toFixed(0).padStart(4)).join(''));
}
