// Renders the cached circuit hits (see dsp/cache.js) into cache/.
//   node test/cache-render.mjs            every voice, 4 processes
//   node test/cache-render.mjs bd sd      just these (index.json is updated)
// Each voice: 16 normal + 16 accented hits through the circuit model at the
// default knob settings (LEVEL full), each with the noise generator and the
// free-running metal oscillators in another state and the trigger level
// +-1.5%, tails trimmed at -60 dB; plus the LEVEL knob's gain curve.
// Stored at 32 kHz (windowed-sinc conversion, flat to ~14 kHz, -60 dB by
// 16 kHz): the sampler-era top end.
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Kit, VOICES, VOLT_SCALE } from '../dsp/kit.js';
import { CIRCUITS } from '../voices/circuits.js';
import { VARIANTS, writeWav } from '../dsp/cache.js';

const SR = 48000, OUT_SR = 32000; // circuit runs at 48 kHz, hits stored at 32 kHz
const MAXLEN = { cy: 3, oh: 2.5, bd: 2, lt: 1.5, mt: 1.5, ht: 1.5 }; // s, before trimming
const dir = new URL('../cache/', import.meta.url);
const args = process.argv.slice(2);

if (args[0] !== '--one') {
  const ids = args.length ? args : VOICES.map(([id]) => id);
  let running = 0, i = 0;
  const next = () => {
    if (i >= ids.length && running === 0) return writeIndex(ids);
    while (running < 4 && i < ids.length) {
      const id = ids[i++]; running++;
      const p = spawn(process.execPath, [new URL(import.meta.url).pathname, '--one', id], { stdio: 'inherit' });
      p.on('exit', (code) => { if (code) console.log(id, 'failed'); running--; next(); });
    }
  };
  next();
} else renderVoice(args[1]);

function writeIndex(ids) {
  const f = new URL('index.json', dir);
  const index = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  for (const id of ids) {
    const part = new URL(`${id}.json`, dir);
    if (!existsSync(part)) continue;
    index[id] = JSON.parse(readFileSync(part, 'utf8')); rmSync(part);
  }
  const sorted = Object.fromEntries(VOICES.map(([id]) => id).filter((id) => index[id]).map((id) => [id, index[id]]));
  writeFileSync(f, JSON.stringify(sorted));
  let bytes = 0; for (const id in sorted) bytes += 44 + 2 * sorted[id].normal.concat(sorted[id].accent, sorted[id].dryNormal ?? [], sorted[id].dryAccent ?? []).reduce((a, r) => a + r[1], 0);
  console.log(`index: ${Object.keys(sorted).length} voices, ${(bytes / 1e6).toFixed(1)} MB of WAV`);
}

function renderVoice(id) {
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const kit = new Kit(SR, { circuits: false });
  const v = (kit.circuit[id] = new CIRCUITS[id](SR, kit.shared));
  kit.setModel(id, 'circuit'); kit.solo = id; kit.master = 1;
  kit.set(id, 'level', 1);
  // seeded randomness, so a re-render gives the same files
  let s = 0x808 + id.charCodeAt(0) * 977 + id.charCodeAt(1);
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  let jitter = 1;
  if (v.triggerVolts) { const tv = v.triggerVolts.bind(v); v.triggerVolts = (a) => tv(a) * jitter; }
  else { const tr = v.trigger.bind(v); v.trigger = (a) => { tr(a); if (v.sw) v.sw.v *= jitter; }; } // BD
  const block = new Float32Array(128);
  const rest = () => { // let the circuit settle back to rest between hits
    for (let t = 0; t < 4 * SR && (v.awake ?? v.idle < 3 * SR); t += 128) kit.render(block, 128);
    for (let t = 0; t < 0.1 * SR; t += 128) kit.render(block, 128);
  };
  const variant = () => {
    kit.shared.noise.s = (rnd() * 4294967295 >>> 0) || 1;
    for (const o of kit.shared.metal.osc) o.vc = 2.2 + 0.6 * rnd();
    jitter = 1 + 0.03 * (rnd() - 0.5);
    return { noise: kit.shared.noise.s, vc: kit.shared.metal.osc.map((o) => o.vc), jitter };
  };
  const again = (st) => { kit.shared.noise.s = st.noise; kit.shared.metal.osc.forEach((o, i) => { o.vc = st.vc[i]; }); jitter = st.jitter; };
  // a SNAP knob (clap) turns one linear path into the mixer down: store each
  // hit a second time with SNAP full, same noise, and let the player mix them
  const hasSnap = v.params.some((p) => p.id === 'snap');
  const hit = (accent) => {
    const n = Math.round((MAXLEN[id] ?? 1.2) * SR), out = new Float32Array(n);
    kit.trigger(id, accent, kit.frame);
    kit.render(out, n);
    for (let i = 0; i < n; i++) out[i] /= VOLT_SCALE; // volts, as the voice outputs them
    return out;
  };
  // 48 -> 32 kHz: Blackman-windowed sinc, cutoff 15 kHz, 64 taps at 48 kHz
  const resample = (x) => {
    const r = SR / OUT_SR, fc = 15000 / SR, H = 32, n = Math.floor(x.length / r), y = new Float32Array(n);
    for (let m = 0; m < n; m++) {
      const t = m * r, k0 = Math.ceil(t - H), k1 = Math.floor(t + H);
      let acc = 0;
      for (let k = Math.max(0, k0); k <= Math.min(x.length - 1, k1); k++) {
        const u = k - t, w = 0.42 + 0.5 * Math.cos(Math.PI * u / H) + 0.08 * Math.cos(2 * Math.PI * u / H);
        acc += x[k] * (u === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * u) / (Math.PI * u)) * w;
      }
      y[m] = acc;
    }
    return y;
  };
  const trim = (x) => {
    let peak = 0; for (const y of x) peak = Math.max(peak, Math.abs(y));
    let end = x.length; while (end > 1 && Math.abs(x[end - 1]) < peak * 1e-3) end--;
    const fade = Math.min(end, Math.round(0.005 * OUT_SR)), y = x.slice(0, Math.min(x.length, end + fade));
    for (let i = 0; i < fade && end + i < y.length; i++) y[end + i] *= 1 - i / fade;
    if (y.length) y[y.length - 1] = 0;
    return y;
  };
  rest();
  const hits = { normal: [], accent: [], dryNormal: [], dryAccent: [] };
  for (const key of ['normal', 'accent']) for (let k = 0; k < VARIANTS; k++) {
    const st = variant(), acc = key === 'accent' ? 1 : 0, full = trim(resample(hit(acc))); rest();
    hits[key].push(full);
    if (hasSnap) {
      kit.set(id, 'snap', 1); rest(); again(st);
      const dry = resample(hit(acc)).slice(0, full.length); rest(); kit.set(id, 'snap', 0); rest();
      hits[key === 'accent' ? 'dryAccent' : 'dryNormal'].push(dry);
    }
  }
  // LEVEL knob: gain of the same hit at level 0, 1/8 .. 1 (RMS ratio)
  const rms = (x) => Math.sqrt(x.reduce((a, y) => a + y * y, 0) / x.length);
  const level = [];
  let ref = 0;
  for (let l = 8; l >= 0; l--) {
    kit.set(id, 'level', l / 8); rest();
    s = 0x1234567; variant(); jitter = 1;
    const r = rms(hit(0)); if (l === 8) ref = r;
    level[l] = +(r / ref).toFixed(5);
    rest();
  }
  // pack: 16-bit, one scale per voice
  let peak = 0; for (const x of [...hits.normal, ...hits.accent]) for (const y of x) peak = Math.max(peak, Math.abs(y));
  const scale = peak * 1.001, all = [...hits.normal, ...hits.accent, ...hits.dryNormal, ...hits.dryAccent];
  const total = all.reduce((a, x) => a + x.length, 0), pcm = new Int16Array(total), ranges = [];
  let o = 0;
  for (const x of all) { ranges.push([o, x.length]); for (let i = 0; i < x.length; i++) pcm[o + i] = Math.round(x[i] / scale * 32767); o += x.length; }
  writeFileSync(new URL(`${id}.wav`, dir), writeWav(pcm, OUT_SR));
  const info = { sr: OUT_SR, scale: +scale.toFixed(6), normal: ranges.slice(0, VARIANTS), accent: ranges.slice(VARIANTS, 2 * VARIANTS), level };
  if (hasSnap) { info.dryNormal = ranges.slice(2 * VARIANTS, 3 * VARIANTS); info.dryAccent = ranges.slice(3 * VARIANTS); }
  writeFileSync(new URL(`${id}.json`, dir), JSON.stringify(info));
  console.log(id, `${(total / OUT_SR).toFixed(1)} s audio, ${(total * 2 / 1e6).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
