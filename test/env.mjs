// Short-window envelope (1 ms RMS, dB) of a case: circuit vs behavioural.
//   node test/env.mjs <id> [case] [ms=120] [step=1]
import { cases, render } from './match-lib.mjs';
import { loadRef } from './match.mjs';
const SR = 48000;
const [id, cname = 'n', ms = '120', st = '1'] = process.argv.slice(2);
const cs = cases(id).find((c) => c.name === cname);
const ref = loadRef(id, cs), got = render(id, 'behavioural', cs);
const rms = (x, t) => { const a = Math.round(t * SR / 1000), w = 48; let s = 0; for (let i = a; i < a + w; i++) s += (x[i] ?? 0) ** 2; return (10 * Math.log10(s / w + 1e-12)).toFixed(0); };
const out = [];
for (let t = 0; t < +ms; t += +st) out.push(`${t}:${rms(ref, t)}/${rms(got, t)}`);
console.log(out.join(' '));
