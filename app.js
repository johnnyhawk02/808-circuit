// Test bench UI: pads, knobs, a 16-step sequencer and a scope.
import { Kit, VOICES } from './dsp/kit.js';
import { sampleFiles } from './dsp/sampler.js';
import { parseWav } from './dsp/wav.js';
import { readWav } from './dsp/cache.js';

// Circuit reference + the manual's check values for each card.
const INFO = {
  bd: ['IC12 · Q39–Q44', '~49 Hz · 300 ms'],
  sd: ['IC14 ×2 · Q45–Q49', '238 + 476 Hz · 60 ms'],
  lt: ['IC15 · SW8', '80–100 Hz · 200 ms'],
  mt: ['IC17 · SW9', '120–160 Hz · 130 ms'],
  ht: ['IC18 · SW10', '165–220 Hz · 100 ms'],
  lc: ['IC15 · SW8', '165–220 Hz · 180 ms'],
  mc: ['IC17 · SW9', '250–310 Hz · 100 ms'],
  hc: ['IC18 · SW10', '370–455 Hz · 80 ms'],
  rs: ['IC20/21 · Q62', '455 + 1667 Hz · 10 ms'],
  cl: ['IC20 · Q74', '2500 Hz · 25 ms'],
  cp: ['IC21–23 · Q69–Q73', 'noise · 100 ms'],
  ma: ['Q65–Q68', 'noise · 25–35 ms'],
  cb: ['IC2 · Q14/Q15', '540 + 800 Hz · 50 ms'],
  cy: ['IC3/IC5 · Q16–Q20', '6 osc · 350–1200 ms'],
  oh: ['Q24–Q27', '6 osc · 90–600 ms'],
  ch: ['Q28–Q31', '6 osc · 50 ms'],
};
const KEYS = '1234567890qwerty';

const specKit = new Kit(48000, { circuits: false }); // main-thread copy, only for the knob specs
const spec = specKit.spec();

let ctx = null, node = null, analyser = null, fallbackKit = null;
const send = (m, transfer) => {
  if (node?.port) node.port.postMessage(m, transfer ?? []);
  else if (fallbackKit) {
    if (m.t === 'trig') fallbackKit.trigger(m.id, m.accent, m.when != null ? Math.round(m.when * ctx.sampleRate) : undefined);
    else if (m.t === 'set') fallbackKit.set(m.id, m.param, m.value);
    else if (m.t === 'master') fallbackKit.master = m.value;
    else if (m.t === 'model') fallbackKit.setModel(m.id, m.value);
    else if (m.t === 'sample') fallbackKit.loadSample(m.id, m.key, { sr: m.sr, data: m.data });
    else if (m.t === 'cache') fallbackKit.loadCache(m.id, m.info, new Int16Array(m.pcm));
    else if (m.t === 'stop') fallbackKit.queue.length = 0;
  }
};

const state = { values: {}, models: {}, master: 0.8, accent: 1, engine: '' };
for (const v of spec) { state.values[v.id] = { ...v.values }; state.models[v.id] = 'circuit'; }

async function startAudio() {
  if (ctx) { if (ctx.state !== 'running') await ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  analyser = ctx.createAnalyser(); analyser.fftSize = 4096;
  analyser.connect(ctx.destination);
  try {
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    node = new AudioWorkletNode(ctx, 'tr808', { numberOfInputs: 0, outputChannelCount: [2] });
    state.engine = 'AudioWorklet';
  } catch (err) {
    console.warn('AudioWorklet unavailable, using ScriptProcessor', err);
    fallbackKit = new Kit(ctx.sampleRate);
    node = ctx.createScriptProcessor(1024, 0, 2);
    node.onaudioprocess = (e) => {
      const L = e.outputBuffer.getChannelData(0);
      fallbackKit.frame = Math.round(e.playbackTime * ctx.sampleRate);
      fallbackKit.render(L, L.length);
      e.outputBuffer.getChannelData(1).set(L);
    };
    node.port = null;
    state.engine = 'ScriptProcessor';
  }
  if (node.port) node.port.onmessage = ({ data: m }) => { if (m.t === 'load') showLoad(m.value); };
  node.connect(analyser);
  // push current knob state into the engine
  for (const id in state.values) for (const p in state.values[id]) send({ t: 'set', id, param: p, value: state.values[id][p] });
  send({ t: 'master', value: state.master });
  for (const id in loadedSamples) for (const [key, w] of loadedSamples[id]) send({ t: 'sample', id, key, sr: w.sr, data: w.data.slice() });
  for (const id in state.models) {
    if (state.models[id] === 'cached') loadCached(id); else send({ t: 'model', id, value: state.models[id] });
  }
  document.getElementById('engine').textContent = `${state.engine} · ${ctx.sampleRate / 1000} kHz`;
  document.body.classList.add('live');
}

// ---------------------------------------------------------------- pads
const grid = document.getElementById('voices');
const flash = (id, acc) => {
  const el = document.getElementById(`card-${id}`);
  el.classList.remove('hit', 'hit-acc'); void el.offsetWidth;
  el.classList.add(acc ? 'hit-acc' : 'hit');
};
async function hit(id, accent) {
  await startAudio();
  send({ t: 'trig', id, accent: accent ? state.accent : 0 });
  flash(id, accent);
  scopeHold = performance.now();
}

for (const [i, v] of spec.entries()) {
  const [circuit, check] = INFO[v.id];
  const card = document.createElement('section');
  card.className = `card fam-${famOf(v.id)}`; card.id = `card-${v.id}`;
  card.innerHTML = `
    <header>
      <span class="abbr">${v.id.toUpperCase()}</span>
      <span class="name">${v.name}</span>
      <kbd title="Keyboard shortcut (Shift = accent)">${KEYS[i].toUpperCase()}</kbd>
    </header>
    <p class="ref"><span>${circuit}</span><span>${check}</span></p>
    <div class="model" role="group" aria-label="${v.name} model">
      <button type="button" data-m="circuit" aria-pressed="true" title="Component-level simulation of every part on the schematic">Circuit</button>
      <button type="button" data-m="cached" aria-pressed="false" title="16 normal + 16 accented hits rendered by the circuit at the default knobs, one picked at random per hit. Level and Decay work; pitch and tone knobs don't. Almost no CPU.">Cached</button>
      <button type="button" data-m="behavioural" aria-pressed="false" title="Synthesized: oscillators, filters and envelopes fitted to the circuit model, at a fraction of the CPU">Synth</button>
      <button type="button" data-m="sample" aria-pressed="false" title="Recordings of a real TR-808 (Michael Fischer, 1994), nearest knob setting">808</button>
    </div>
    <div class="knobs"></div>
    <div class="pads">
      <button type="button" class="pad" id="hit-${v.id}">Hit</button>
      <button type="button" class="pad acc" id="acc-${v.id}">Accent</button>
    </div>`;
  const knobs = card.querySelector('.knobs');
  for (const p of v.params) {
    const id = `k-${v.id}-${p.id}`;
    const wrap = document.createElement('label');
    wrap.className = 'knob'; wrap.htmlFor = id;
    wrap.innerHTML = `<span>${p.name}</span><input type="range" id="${id}" min="0" max="1" step="0.01" value="${v.values[p.id]}"><output>${Math.round(v.values[p.id] * 10)}</output>`;
    const input = wrap.querySelector('input'), out = wrap.querySelector('output');
    input.addEventListener('input', () => {
      const value = +input.value;
      state.values[v.id][p.id] = value; out.textContent = Math.round(value * 10);
      send({ t: 'set', id: v.id, param: p.id, value });
    });
    knobs.append(wrap);
  }
  card.querySelector(`#hit-${v.id}`).addEventListener('pointerdown', (e) => { e.preventDefault(); hit(v.id, false); });
  card.querySelector(`#acc-${v.id}`).addEventListener('pointerdown', (e) => { e.preventDefault(); hit(v.id, true); });
  for (const b of card.querySelectorAll('.pad')) b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit(v.id, b.classList.contains('acc')); }
  });
  for (const b of card.querySelectorAll('.model button')) b.addEventListener('click', () => setModel(v.id, b.dataset.m));
  grid.append(card);
}
// ---------------------------------------------------------------- 808 samples
// Fetched per voice the first time its 808 button is picked; each recording
// goes to the engine as raw PCM (the worklet can't fetch).
const loadedSamples = {}, loading = {};
function loadSamples(id) {
  if (loadedSamples[id] || loading[id]) return loading[id];
  const card = document.getElementById(`card-${id}`);
  card.classList.add('loading');
  loading[id] = Promise.all(sampleFiles().filter(([v]) => v === id).map(async ([, key, path]) => {
    const r = await fetch(new URL(path, import.meta.url));
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return [key, parseWav(await r.arrayBuffer())];
  })).then((list) => {
    loadedSamples[id] = list;
    for (const [key, w] of list) send({ t: 'sample', id, key, sr: w.sr, data: w.data.slice() });
  }).catch((err) => { console.warn('samples', id, err); card.classList.add('nosample'); })
    .finally(() => { card.classList.remove('loading'); delete loading[id]; });
  return loading[id];
}
function setModel(id, m) {
  state.models[id] = m;
  if (m === 'sample') loadSamples(id);
  for (const b of document.querySelectorAll(`#card-${id} .model button`)) b.setAttribute('aria-pressed', b.dataset.m === m);
  if (m === 'cached') loadCached(id); else send({ t: 'model', id, value: m });
  const all = Object.values(state.models);
  for (const b of document.querySelectorAll('#all-models button')) b.setAttribute('aria-pressed', all.every((x) => x === b.dataset.m));
}
for (const b of document.querySelectorAll('#all-models button')) b.addEventListener('click', () => { for (const v of spec) setModel(v.id, b.dataset.m); });

// Cached circuit hits: fetched per voice the first time Cached is picked
// (cache/<id>.wav, 32 kHz 16-bit), then handed to the audio engine.
let cacheIndex = null;
const cacheSent = new Set(), cacheLoading = {};
async function loadCached(id) {
  if (!ctx) return; // startAudio() loads it
  if (!cacheSent.has(id)) {
    cacheLoading[id] ??= (async () => {
      cacheIndex ??= fetch(new URL('./cache/index.json', import.meta.url)).then((r) => r.json());
      const info = (await cacheIndex)[id];
      const buf = await (await fetch(new URL(`./cache/${id}.wav`, import.meta.url))).arrayBuffer();
      const pcm = readWav(buf).buffer;
      send({ t: 'cache', id, info, pcm }, [pcm]);
      cacheSent.add(id);
    })().catch((err) => { console.warn('cache load failed', id, err); delete cacheLoading[id]; });
    await cacheLoading[id];
  }
  if (state.models[id] === 'cached') send({ t: 'model', id, value: 'cached' });
}

// rendering load reported by the worklet (fraction of the real-time budget)
const loadEl = document.getElementById('load'), warnEl = document.getElementById('overload');
let loadAvg = 0;
function showLoad(x) {
  loadAvg = loadAvg ? 0.6 * loadAvg + 0.4 * x : x;
  loadEl.textContent = `DSP load ${Math.round(loadAvg * 100)}%`;
  warnEl.hidden = loadAvg < 0.85;
}
function famOf(id) {
  if (['bd', 'sd'].includes(id)) return 'a';
  if (['lt', 'mt', 'ht', 'lc', 'mc', 'hc'].includes(id)) return 'b';
  if (['rs', 'cl', 'cp', 'ma'].includes(id)) return 'c';
  return 'd';
}

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const i = KEYS.indexOf(e.key.toLowerCase());
  if (i >= 0) { hit(spec[i].id, e.shiftKey); return; }
  if (e.key === ' ' && !e.target.matches('button')) { e.preventDefault(); togglePlay(); }
});

// ---------------------------------------------------------------- master
const masterEl = document.getElementById('master');
masterEl.addEventListener('input', () => { state.master = +masterEl.value; send({ t: 'master', value: state.master }); });
const accentEl = document.getElementById('accent');
accentEl.addEventListener('input', () => { state.accent = +accentEl.value; });
document.getElementById('start').addEventListener('click', startAudio);

// ---------------------------------------------------------------- sequencer
// 0 = off, 1 = on, 2 = accented
const STEPS = 16;
const pattern = {};
for (const v of spec) pattern[v.id] = new Array(STEPS).fill(0);
const DEMO = {
  bd: 'x.....x...x.....', sd: '....x.......X...', ch: 'x.x.x.x.x.x.x.x.', oh: '..............x.',
  cp: '....X.......X...', lc: '.........x....x.', mc: '...x..........x.', cb: '..........x..x..',
  rs: '.......x........', cl: '...............x', ma: 'x.xx.xx.x.xx.xx.',
};
for (const id in DEMO) [...DEMO[id]].forEach((c, i) => { pattern[id][i] = c === 'x' ? 1 : c === 'X' ? 2 : 0; });

const seq = document.getElementById('seq');
const head = document.createElement('div'); head.className = 'row head';
head.innerHTML = '<span class="lab"></span>' + Array.from({ length: STEPS }, (_, i) => `<span class="num">${i + 1}</span>`).join('');
seq.append(head);
for (const v of spec) {
  const row = document.createElement('div');
  row.className = `row fam-${famOf(v.id)}`;
  row.innerHTML = `<span class="lab">${v.id.toUpperCase()}</span>`;
  for (let s = 0; s < STEPS; s++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'step'; b.dataset.v = pattern[v.id][s];
    b.setAttribute('aria-label', `${v.name} step ${s + 1}`);
    if (s % 4 === 0) b.classList.add('beat');
    b.addEventListener('click', () => {
      pattern[v.id][s] = (pattern[v.id][s] + 1) % 3; b.dataset.v = pattern[v.id][s];
    });
    row.append(b);
  }
  seq.append(row);
}
document.getElementById('clear').addEventListener('click', () => {
  for (const id in pattern) pattern[id].fill(0);
  seq.querySelectorAll('.step').forEach((b) => (b.dataset.v = 0));
});

const tempoEl = document.getElementById('tempo'), tempoOut = document.getElementById('tempo-out');
tempoEl.addEventListener('input', () => (tempoOut.textContent = tempoEl.value));
let playing = false, nextTime = 0, step = 0, timer = 0;
const playBtn = document.getElementById('play');
async function togglePlay() {
  await startAudio();
  playing = !playing;
  playBtn.textContent = playing ? 'Stop' : 'Play';
  playBtn.setAttribute('aria-pressed', playing);
  if (playing) { step = 0; nextTime = ctx.currentTime + 0.06; schedule(); }
  else { clearTimeout(timer); send({ t: 'stop' }); markStep(-1); }
}
playBtn.addEventListener('click', togglePlay);
function schedule() {
  const spb = 60 / +tempoEl.value / 4; // 16th notes
  while (nextTime < ctx.currentTime + 0.12) {
    for (const id in pattern) {
      const v = pattern[id][step];
      if (v) send({ t: 'trig', id, accent: v === 2 ? state.accent : 0, when: nextTime });
    }
    const s = step, t = nextTime;
    setTimeout(() => playing && markStep(s), Math.max(0, (t - ctx.currentTime) * 1000));
    step = (step + 1) % STEPS; nextTime += spb;
  }
  timer = setTimeout(schedule, 25);
}
function markStep(s) {
  seq.querySelectorAll('.row').forEach((r) => r.querySelectorAll('.step').forEach((b, i) => b.classList.toggle('now', i === s)));
}

// ---------------------------------------------------------------- scope
const cv = document.getElementById('scope'), g = cv.getContext('2d');
let scopeHold = 0, scopeBuf = null;
function drawScope() {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--scope-bg'); g.fillRect(0, 0, w, h);
  g.strokeStyle = css.getPropertyValue('--grid'); g.lineWidth = 1;
  for (let x = 0; x <= 10; x++) { g.beginPath(); g.moveTo((x * w) / 10, 0); g.lineTo((x * w) / 10, h); g.stroke(); }
  for (let y = 0; y <= 4; y++) { g.beginPath(); g.moveTo(0, (y * h) / 4); g.lineTo(w, (y * h) / 4); g.stroke(); }
  if (analyser) {
    if (!scopeBuf) scopeBuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(scopeBuf);
    // rising zero-crossing trigger for a steady trace
    let start = 0;
    for (let i = 1; i < scopeBuf.length / 2; i++) if (scopeBuf[i - 1] <= 0 && scopeBuf[i] > 0) { start = i; break; }
    const span = Math.min(scopeBuf.length - start, Math.round(ctx.sampleRate * 0.04));
    g.strokeStyle = css.getPropertyValue('--trace'); g.lineWidth = 1.6; g.beginPath();
    for (let i = 0; i < span; i++) {
      const x = (i / span) * w, y = h / 2 - scopeBuf[start + i] * h * 0.9;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  requestAnimationFrame(drawScope);
}
drawScope();
