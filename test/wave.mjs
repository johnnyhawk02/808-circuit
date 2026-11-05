// Print the first ms of a case as a coarse waveform: circuit vs behavioural.
//   node test/wave.mjs <id> [case] [ms=30] [step_ms=0.5]
import { cases, render } from './match-lib.mjs';
import { loadRef } from './match.mjs';
const SR = 48000;
const [id, cname = 'n', ms = '30', st = '0.5'] = process.argv.slice(2);
const cs = cases(id).find((c) => c.name === cname);
const ref = loadRef(id, cs), got = render(id, 'behavioural', cs);
for (let t = 0; t < +ms; t += +st) { const k = Math.round(t * SR / 1000); console.log(t.toFixed(2).padStart(6), ref[k].toFixed(3).padStart(8), got[k].toFixed(3).padStart(8)); }
