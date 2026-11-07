// The JS reference for tests/player.cpp: runs the app's own Player (from the built elixir/index.html, as the page runs it)
// through a scripted session and writes its output and the messages it was sent.
// node vst/tests/ref-player.mjs <outdir> [scenario]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import vm from 'vm';
const root = new URL('../../', import.meta.url);
const out = process.argv[2] || '/tmp/refp';
const scen = process.argv[3] || 'main';
mkdirSync(out, { recursive: true });
const html = readFileSync(new URL('elixir/index.html', root), 'utf8');
const script = (id) => { const a = html.indexOf(`<script id="${id}">`) + `<script id="${id}">`.length; return html.slice(a, html.indexOf('</script>', a)); };
const ctx = vm.createContext({ console, Math, Date });
vm.runInContext(script('engine') + '\n' + script('player') + '\nglobalThis.LXR = LXR; globalThis.TR808 = TR808; globalThis.Player = Player; globalThis.IrVerb = IrVerb;', ctx);
const { LXR, TR808, Player, IrVerb } = ctx;
const FS = 48000;
const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');

// ---- the messages, each at an output frame ----
const log = [];
const at = (sec, m) => log.push({ at: Math.round(sec * FS), m });
const PAR = LXR.PAR;
const asDelay = (kit) => { if (kit[PAR.FX_TYPE] !== LXR.FX_DELAY) { kit[PAR.FX_TYPE] = LXR.FX_DELAY; kit[PAR.FX_P3] = 90; kit[PAR.FX_P4] = 50; } return kit; };
const initKit = () => { const k = new Array(PAR.END_OF_SOUND_PARAMETERS).fill(0); for (let i = 8; i < PAR.END_OF_SOUND_PARAMETERS; i++) k[i - 8] = LXR.INIT_KIT[i]; return asDelay(k); };
const sndKit = (file) => {
  const b = readFileSync(new URL('elixir/kits/' + file, root)); const k = new Array(PAR.END_OF_SOUND_PARAMETERS).fill(0);
  for (let i = 0; i < PAR.END_OF_SOUND_PARAMETERS && 8 + i < b.length; i++) k[i] = b[8 + i];
  return asDelay(k);
};
const IDS = TR808.VOICES.map(([id]) => id);
const index = JSON.parse(readFileSync(new URL('cache/index.json', root), 'utf8'));
const irSynth = (kind) => { // (app/irverb.js)
  const fs = LXR.REAL_FS, n = Math.round((kind === 'plate' ? 2.4 : 0.32) * fs), ch = [new Float32Array(n), new Float32Array(n)];
  let seed = kind === 'plate' ? 7 : 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1);
  ch.forEach((y) => { let lp = 0; for (let i = 0; i < n; i++) { const t = i / fs, x = rnd();
    if (kind === 'plate') { const a = Math.max(0.08, Math.exp(-t * 1.6)); lp += a * (x - lp); y[i] = (0.35 * x * Math.exp(-t * 40) + lp) * Math.exp(-6.9 * t / 2.4) * Math.min(1, i / 40); }
    else { lp += 0.45 * (x - lp); y[i] = lp * Math.min(1, t / 0.004) * (1 - 0.35 * t / 0.28) * (t > 0.28 ? Math.max(0, 1 - (t - 0.28) / 0.02) : 1); } } });
  return ch;
};
const pat = (fn) => { const on = [], acc = [], bar = []; for (let t = 0; t < 7; t++) { on.push([]); acc.push([]); bar.push([]); for (let s = 0; s < 16; s++) { const [o, a, b] = fn(t, s); on[t].push(o ? 1 : 0); acc[t].push(a ? 1 : 0); bar[t].push(b || 0); } } return { on, acc, bar }; };
const groove = { off: Array.from({ length: 7 }, (_, t) => Array.from({ length: 16 }, (_, s) => (s % 2 ? 0.12 * (t % 3) : 0) - (t === 5 && s % 4 === 2 ? 0.05 : 0))) };
const seqMsg = (o) => ({ type: 'seq', pattern: o.pattern, patternOn: true, bpm: o.bpm ?? 128, groove, vel: 100, accentDb: 6, playing: o.playing ?? true });
const mixMsg = (o = {}) => ({ type: 'mix', master: { comp: true, thresh: -12, ratio: 3, attack: 5, release: 120, makeup: 2, duck: 0.4, duckRelease: 150, duckFx: !!o.duckFx, duckOn: true, space: o.space ?? 0 },
  fx: [1, 1, 1, 1, 1, 1], echo: { pct: o.pct ?? 100, sync: o.sync ?? true, free: 0.3, fine: o.fine ?? 0 }, dist: { type: o.dt ?? 0, p: [50, 70, 60, 100], mix: o.dmix ?? 0 },
  ring: { wave: 0, freq: 0 }, verb: { pre: 12, low: 40, tone: 90, width: 80, gate: o.gate ?? 0, gfine: 0, len: 100 }, sendD: [0, 0, 0, 0, 0, 0], sendR: [0.2, 0, 0, 0.3, 0, 0] });

// the standard set-up, as the page sends it on start
at(0, { type: 'kit', values: initKit() });
at(0, { type: 'map808', map: ['bd', 'lt', 'ht', 'sd', 'cy', 'ch', 'oh'] });
for (const v of new TR808.Kit(44100, { circuits: false }).spec()) for (const p of v.params) at(0, { type: 'set808', id: v.id, param: p.id, value: v.values[p.id] });
for (const id of IDS) at(0, { type: 'model808', id, model: 'cached' });
const wav = (id) => TR808.readWav(readFileSync(new URL(`cache/${id}.wav`, root)).buffer.slice(0));
for (const id of IDS) { const pcm = wav(id); at(0, { type: 'cache808', id, info: index[id], pcm: pcm.buffer.slice(0), pcm64: b64(pcm) }); }
for (const [i, id] of IDS.entries()) at(0, { type: 'vmix808', id, vol: 100 + (i % 3) * 10, pan: 40 + (i * 7) % 50, echo: i % 4 === 1 ? 30 : 0, verb: i % 3 === 0 ? 25 : 0 });
const ir = irSynth('plate');
at(0, { type: 'verbIr', irL: ir[0], irR: ir[1], frac: 0.1 + 0.9 * 100 / 127 });
at(0, mixMsg());
const P1 = pat((t, s) => [t === 0 ? s % 4 === 0 : t === 3 ? s % 8 === 4 : t === 5 ? s % 2 === 0 : t === 6 ? s % 4 === 2 : t === 1 ? s === 11 : t === 4 ? s === 0 : s === 14, s === 4 || s === 12, t === 1 ? 2 : 0]);
if (scen === 'main') {
  at(0.01, seqMsg({ pattern: P1 }));
  at(1.0, { type: 'hit808', id: 'cp', acc: true });
  at(1.5, { type: 'param', par: PAR.FX_P4, value: 90 });     // more echo feedback
  at(2.0, { type: 'kit', values: sndKit('hrtl-untz/PROJ00-00-STOVE.SND') }); // a kit whose LFO moves the echo (sine)
  at(2.6, mixMsg({ dmix: 40, dt: 2, space: 60 }));          // the rat distortion in, the spacer on
  at(3.2, { type: 'set808', id: 'sd', param: 'snap', value: 0.3 });
  at(3.5, { type: 'param', par: PAR.FX_DELAY_TYPE, value: 1 }); // ping-pong
  at(3.6, mixMsg({ pct: 160, dmix: 20, dt: 1, gate: 6 }));   // wide, fold, the reverb gate
  at(4.0, { type: 'rush', v: 60 });
  at(4.8, { type: 'rush', v: 86 });
  at(5.6, { type: 'rush', v: 97 });
  at(6.4, { type: 'rush', v: 0 });
  at(6.5, { type: 'mute', muted: [0, 0, 0, 1, 0, 0] });
  const lanes = {}; for (const [i, id] of ['bd', 'cl', 'ma', 'rs', 'cb', 'ch', 'oh', 'lc', 'hc'].entries()) lanes[id] = { on: Array.from({ length: 64 }, (_, k) => (k * (i + 3)) % 7 === 0 ? 1 : 0), acc: Array.from({ length: 64 }, (_, k) => k % 16 === 0 ? 1 : 0) };
  at(7.0, { type: 'lanes808', lanes, pages: 4 });
  at(7.2, { type: 'rec', bars: 1, count: false });
  at(8.0, { type: 'atBar', m: seqMsg({ pattern: { pages: [P1, pat((t, s) => [s % 3 === 0, s === 0, 0])] }, bpm: 140 }) });
  at(8.1, { type: 'mute', muted: [0, 0, 0, 0, 0, 0] });
  at(9.0, mixMsg({ sync: false, fine: 30, duckFx: true }));
  at(9.5, { type: 'set808', id: 'bd', param: 'level', value: 0.6 });
  at(10.0, { type: 'lanes808', lanes: null });
  at(10.5, seqMsg({ pattern: P1, playing: false }));
  at(10.6, { type: 'trig', voice: 0, vel: 127 });
  at(11.0, { type: 'rec', bars: 0, count: true });
  at(13.0, { type: 'recStop' });
}
const SECS = scen === 'main' ? 14 : 4;
log.sort((a, b) => a.at - b.at);

// ---- run it ----
const p = new Player(FS);
const N = SECS * FS, L = new Float32Array(N), R = new Float32Array(N), events = [];
let li = 0;
const feed = (m) => {
  if (m.type === 'verbIr') p.msg({ type: 'verbIr', h: IrVerb.prepare(m.irL, m.irR, m.frac) });
  else if (m.type === 'cache808') { const { pcm64, ...rest } = m; p.msg(rest); }
  else p.msg(JSON.parse(JSON.stringify(m)));
};
const BLK = 128;
for (let f = 0; f < N; f += BLK) {
  while (li < log.length && log[li].at <= f) feed(log[li++].m);
  const l = L.subarray(f, f + BLK), r = R.subarray(f, f + BLK);
  p.process(l, r);
  for (const ev of p.events) events.push({ f, ...(ev.type === 'recData' ? { type: 'recData', n: ev.L.length, sumL: ev.L.reduce((a, b) => a + Math.abs(b), 0) } : ev) });
  p.events.length = 0;
}
// the log as the C++ reads it: binary as base64
const lines = log.map(({ at, m }) => {
  if (m.type === 'cache808') { const { pcm, ...rest } = m; return JSON.stringify({ at, m: rest }); }
  if (m.type === 'verbIr') return JSON.stringify({ at, m: { type: 'verbIr', irL64: b64(m.irL), irR64: b64(m.irR), frac: m.frac } });
  return JSON.stringify({ at, m });
});
writeFileSync(`${out}/log.jsonl`, lines.join('\n') + '\n');
const io = new Float32Array(2 * N); for (let i = 0; i < N; i++) { io[2 * i] = L[i]; io[2 * i + 1] = R[i]; }
writeFileSync(`${out}/out.f32`, Buffer.from(io.buffer));
writeFileSync(`${out}/events.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
let pk = 0; for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
console.log(`ref: ${SECS} s, peak ${pk.toFixed(3)}, ${events.length} events, ${log.length} messages`);
