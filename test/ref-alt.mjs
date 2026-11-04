// Only the noise-floor render (see ref-render.mjs): node test/ref-alt.mjs <id>
import { writeFileSync } from 'node:fs';
import { cases, render } from './match-lib.mjs';
const id = process.argv[2];
const alt = render(id, 'circuit', { ...cases(id)[0], name: 'alt' }, { alt: true });
writeFileSync(new URL(`./.cache/${id}-alt.f32`, import.meta.url), Buffer.from(alt.buffer));
