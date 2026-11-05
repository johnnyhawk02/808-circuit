// Renders the circuit model of one voice at a set of knob settings and caches
// the raw output (volts, Float32) in test/.cache/ for test/match.mjs.
//   node test/ref-render.mjs <id>        (slow: solves the circuit)
//   node test/ref-render.mjs all         every voice, 4 processes
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { Kit, VOICES } from '../dsp/kit.js';
import { cases, SR, render } from './match-lib.mjs';

const id = process.argv[2];
if (id === 'all') {
  const ids = VOICES.map(([v]) => v); let running = 0, i = 0;
  const next = () => {
    while (running < 4 && i < ids.length) {
      const v = ids[i++]; running++;
      const p = spawn(process.execPath, [new URL(import.meta.url).pathname, v], { stdio: 'inherit' });
      p.on('exit', () => { running--; next(); });
    }
  };
  next();
} else {
  mkdirSync(new URL('./.cache/', import.meta.url), { recursive: true });
  const t0 = Date.now();
  for (const cs of cases(id)) {
    const x = render(id, 'circuit', cs);
    writeFileSync(new URL(`./.cache/${id}-${cs.name}.f32`, import.meta.url), Buffer.from(x.buffer));
  }
  // noise floor: the default hit again with the noise / metal sources in a
  // different state, i.e. the best score a model of this circuit can reach
  const alt = render(id, 'circuit', { ...cases(id)[0], name: 'alt' }, { alt: true });
  writeFileSync(new URL(`./.cache/${id}-alt.f32`, import.meta.url), Buffer.from(alt.buffer));
  console.log(id, 'done', ((Date.now() - t0) / 1000).toFixed(0), 's');
}
