// How close the circuit and synth models come to the real TR-808 recordings
// (cache/808/), with the same score as test/match.mjs. Only knob cases the
// sample set covers (default, each knob at its ends); accent is left out
// because the set has no accented hits.
//   node test/vs808.mjs [ids...]
import { cases, render, VOICES } from './match-lib.mjs';
import { loadRef } from './match.mjs';
import { features, distance } from './features.mjs';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : VOICES.map(([v]) => v);
const rows = [];
for (const id of ids) {
  const cs = cases(id).filter((c) => !c.levelOnly && c.accent === 0);
  let sc = 0, sb = 0, n = 0;
  for (const c of cs) {
    const ref = loadRef(id, c); if (!ref) continue;
    const s = features(render(id, 'sample', c));
    sc += distance(s, features(ref)).score; sb += distance(s, features(render(id, 'behavioural', c))).score; n++;
  }
  rows.push({ id, 'circuit vs 808': (sc / n).toFixed(1), 'synth vs 808': (sb / n).toFixed(1) });
}
console.table(rows);
