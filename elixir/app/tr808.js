// ---- the 808 sounds (the bench's own code, bundled as TR808 by tr808-bundle.mjs) and the 808 page ----
// No LXR voices: the LXR-02 engine is only the effects and the mix now. The grid's lanes (app/tr808-grid.js) play the
// sixteen sounds, each on a track of the mixer (app/player.js: BUS808); the generator plays one sound a track (t8.map,
// the standard kit). Each sound plays as the circuit simulation or as cached hits, with its own knobs; the cache
// button renders a sound's hits at its current knobs in a worker, as on the bench, kept in this browser (IndexedDB
// tr808-cache, the bench's own, so caches made on either show up in both); revert brings the shipped ones back.
// Models and knobs are kept in this browser, not in the presets.
const T8_IDS = TR808.VOICES.map(([id]) => id);
const T8_NAME = Object.fromEntries(TR808.VOICES.map(([id, name]) => [id, name.toLowerCase()]));
const T8_SPEC = new TR808.Kit(44100, { circuits: false }).spec(); // (no circuits: just the knob lists)
const T8_PARAMS = Object.fromEntries(T8_SPEC.map((v) => [v.id, v.params]));
const T8_LIVE = ['level', 'snap', 'accent']; // knobs cached plays live; the cache button bakes the rest in (drive too: it is in the circuit)
// the sounds in the order the grid's lanes and the 808 page show them: kick, snares and claps, toms, congas and small
// percussion, cymbals and hats
const T8_ORDER = ['bd', 'sd', 'rs', 'cp', 'lt', 'mt', 'ht', 'lc', 'mc', 'hc', 'cl', 'ma', 'cb', 'cy', 'oh', 'ch'];
const T8_KIT = ['bd', 'lt', 'ht', 'sd', 'cy', 'ch', 'oh'];
const T8_KEY = 'elixir808-tr808';
// the cache button records this many hits a voice, plain and accented each, played in random order, never the same one
// twice running (the shipped cache has 16)
const T8_HITS = 4;
// shipped cached hits: the bench's cache/ folder, beside this app's folder
// the bench's cache/: one folder up when served from elixir/ (locally), bench/cache/ on the live site (the app at the root)
const T8_CACHE_URL = new URL(location.pathname.includes('/elixir/') ? '../cache/' : 'bench/cache/', location.href);

const t8 = { map: T8_KIT.slice(), models: Object.fromEntries(T8_IDS.map((id) => [id, 'cached'])),
  values: Object.fromEntries(T8_SPEC.map((v) => [v.id, { ...v.values }])) };
try {
  const s = JSON.parse(localStorage.getItem(T8_KEY));
  if (s) {
    if (Array.isArray(s.map) && s.map.length === 7) t8.map = s.map.map((id, t) => (T8_IDS.includes(id) ? id : T8_KIT[t]));
    for (const id of T8_IDS) {
      if (s.models?.[id] === 'circuit' || s.models?.[id] === 'cached') t8.models[id] = s.models[id];
      for (const p of T8_PARAMS[id]) if (typeof s.values?.[id]?.[p.id] === 'number') t8.values[id][p.id] = s.values[id][p.id];
    }
  }
} catch (e) {}
const t8Save = () => { try { localStorage.setItem(T8_KEY, JSON.stringify(t8)); } catch (e) {} };

// ---- to the audio thread (send() queues until the audio starts) ----
const t8SendMap = () => send({ type: 'map808', map: t8.map.slice() });
for (const id of T8_IDS) {
  for (const p of T8_PARAMS[id]) send({ type: 'set808', id, param: p.id, value: t8.values[id][p.id] });
}
t8SendMap();

// cached hits: the shipped ones (fetched the first time a voice plays cached) or the ones made here
const t8Custom = {}, t8Jobs = {}, t8Sent = new Set(), t8Loading = {};
let t8Index = null;
async function t8LoadCached(id) {
  if (!t8Sent.has(id)) {
    t8Loading[id] ??= (async () => {
      await t8CustomReady;
      if (t8Custom[id]) { send({ type: 'cache808', id, info: t8Custom[id].info, pcm: t8Custom[id].pcm.slice(0) }); t8Sent.add(id); return; }
      t8Index ??= fetch(new URL('index.json', T8_CACHE_URL)).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
      const info = (await t8Index)[id];
      const buf = await (await fetch(new URL(`${id}.wav`, T8_CACHE_URL))).arrayBuffer();
      const pcm = TR808.readWav(buf).buffer;
      if (t8Custom[id]) return; // a cache press finished meanwhile and sent its own
      send({ type: 'cache808', id, info, pcm });
      t8Sent.add(id);
    })().catch((err) => {
      console.warn('808 cache load failed', id, err); delete t8Loading[id]; t8Missing.add(id);
      send({ type: 'model808', id, model: 'behavioural' }); // no hits: the synth model plays instead of silence
      t8Draw();
    });
    t8LoadingShow(1);
    await t8Loading[id];
    t8LoadingShow(-1);
  }
}
// "caching sounds…" by the title while any voice's hits are loading (those voices are silent until then)
let t8Pending = 0;
function t8LoadingShow(d) { t8Pending += d; const el = document.getElementById('m-loading'); if (el) el.hidden = t8Pending <= 0; }
const t8Missing = new Set(); // shipped hits that couldn't be fetched: cached falls back to the synth model
function t8SetModel(id, m) {
  t8.models[id] = m; t8Save();
  send({ type: 'model808', id, model: m });
  if (m === 'cached') t8LoadCached(id);
  t8Draw();
}

// ---- the cache button (as the bench's): IndexedDB tr808-cache, store hits, one entry per voice ----
const T8_DB = 'tr808-cache', T8_STORE = 'hits';
function t8Db() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(T8_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(T8_STORE);
    r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
  });
}
async function t8DbDo(mode, fn) {
  const d = await t8Db();
  return new Promise((ok, fail) => {
    const tx = d.transaction(T8_STORE, mode), req = fn(tx.objectStore(T8_STORE));
    tx.oncomplete = () => { d.close(); ok(req?.result); }; tx.onerror = tx.onabort = () => { d.close(); fail(tx.error); };
  });
}
const t8CustomReady = (async () => {
  try {
    const keys = await t8DbDo('readonly', (st) => st.getAllKeys());
    const vals = await t8DbDo('readonly', (st) => st.getAll());
    keys.forEach((id, i) => {
      if (!T8_PARAMS[id] || !vals[i]?.info) return;
      t8Custom[id] = vals[i];
      // the knobs show what the cached hits were rendered at
      for (const [p, x] of Object.entries(vals[i].info.knobs ?? {})) t8SetKnob(id, p, x, false);
    });
  } catch (err) { console.warn('no saved 808 caches (IndexedDB unavailable)', err); }
  t8Draw();
})();
// the voices playing cached load their hits now (after any saved ones are read)
for (const id of T8_IDS) { send({ type: 'model808', id, model: t8.models[id] }); if (t8.models[id] === 'cached' && t8.map.includes(id)) t8LoadCached(id); }

function t8SetKnob(id, p, x, save = true) {
  t8.values[id][p] = x;
  send({ type: 'set808', id, param: p, value: x });
  if (save) t8Save();
}
// the worker: the engine script (it holds TR808) and the bench's cache-worker, as a classic worker from a blob
let t8WorkerUrl = null;
function t8Worker() {
  t8WorkerUrl ??= URL.createObjectURL(new Blob([document.getElementById('engine').textContent, `
self.onmessage = ({ data: { id, values, variants } }) => {
  try {
    let last = 0;
    const { info, pcm } = TR808.buildCache(id, values, (done, total) => {
      const now = Date.now();
      if (now - last > 150 || done === total) { last = now; self.postMessage({ t: 'progress', id, done, total }); }
    }, variants);
    self.postMessage({ t: 'done', id, info, pcm: pcm.buffer }, [pcm.buffer]);
  } catch (err) { self.postMessage({ t: 'error', id, message: String(err && err.message || err) }); }
};`], { type: 'text/javascript' }));
  return new Worker(t8WorkerUrl);
}
// one worker per voice being cached, so several voices render on several cores
function t8MakeCache(id) {
  if (t8Jobs[id] && !t8Jobs[id].error) return;
  const j = (t8Jobs[id] = { done: 0, total: 0 }); t8Draw();
  const w = t8Worker(); j.w = w; j.knobs = { ...t8.values[id] };
  const fail = (msg) => {
    w.terminate(); j.error = msg; t8Draw();
    setTimeout(() => { if (t8Jobs[id] === j) { delete t8Jobs[id]; t8Draw(); } }, 6000);
  };
  w.onerror = (e) => { e.preventDefault?.(); fail(e.message || 'worker failed'); };
  w.onmessage = async ({ data: m }) => {
    if (m.t === 'progress') { j.done = m.done; j.total = m.total; t8Draw(); return; }
    if (m.t === 'error') { fail(m.message); return; }
    w.terminate(); delete t8Jobs[id];
    const entry = { info: m.info, pcm: m.pcm, date: Date.now() };
    t8Custom[id] = entry; t8Missing.delete(id);
    t8DbDo('readwrite', (st) => st.put(entry, id)).catch((err) => console.warn('could not save 808 cache', err));
    await t8Loading[id]; // a shipped load in flight must not land after ours
    t8Sent.delete(id); delete t8Loading[id];
    t8SetModel(id, 'cached');
  };
  w.postMessage({ id, values: { ...t8.values[id] }, variants: T8_HITS });
}
async function t8Revert(id) {
  if (!t8Custom[id]) return;
  delete t8Custom[id];
  t8DbDo('readwrite', (st) => st.delete(id)).catch((err) => console.warn('could not delete 808 cache', err));
  await t8Loading[id];
  t8Sent.delete(id); delete t8Loading[id];
  for (const p of T8_PARAMS[id]) if (!T8_LIVE.includes(p.id)) t8SetKnob(id, p.id, p.def);
  if (t8.models[id] === 'cached') t8LoadCached(id);
  mDrawAll(); t8Draw();
}

// ---- the page: every sound in its own box, all on one page: its name (tap to hear it), circuit or cached, its knobs,
// and its cache button with what it plays ----
async function t8Audition(id) {
  if (t8.models[id] === 'cached') await t8LoadCached(id);
  send({ type: 'hit808', id, acc: false });
}
// (a sound's box is built twice: on the 808 page and in the grid page's side panel; t8Draw keeps both)
const t8Cards = Object.fromEntries(T8_ORDER.map((id) => [id, []]));
function t8Card(id, into) {
  const card = document.createElement('div');
  card.className = 'm-808-v';
  card.innerHTML = `<button class="m-808-vname" type="button" title="${T8_NAME[id]}: tap to hear it">${id}</button>`
    + '<span class="m-808-models"><button class="m-toggle" type="button" data-m="circuit" title="The circuit simulation: every knob works, costs CPU">circuit</button>'
    + '<button class="m-toggle" type="button" data-m="cached" title="Recorded hits, one picked at random each time: almost no CPU">cached</button></span>'
    + '<div class="m-808-set"></div>'
    + '<button class="m-btn m-808-go" type="button" title="Record 4 normal + 4 accented hits through the circuit at these knobs, kept in this browser, played at random, never the same one twice running">cache</button>'
    + '<span class="m-808-status"></span>'
    + '<button class="m-808-revert" type="button" hidden title="Forget your hits and go back to the shipped ones (default knobs)">revert</button>';
  into.append(card);
  card.querySelector('.m-808-vname').addEventListener('click', () => t8Audition(id));
  card.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => t8SetModel(id, b.dataset.m)));
  card.querySelector('.m-808-go').addEventListener('click', () => t8MakeCache(id));
  card.querySelector('.m-808-revert').addEventListener('click', () => t8Revert(id));
  const box = card.querySelector('.m-808-set');
  for (const p of T8_PARAMS[id]) {
    mFader(box, p.name.toLowerCase(), { knob: true, min: 0, max: 100, get: () => Math.round(t8.values[id][p.id] * 100), show: String, dflt: Math.round(p.def * 100),
      set: (v) => { t8SetKnob(id, p.id, v / 100); t8Draw(); mDrawAll(); } });
  }
  t8Cards[id].push(card);
  return card;
}
for (const id of T8_ORDER) t8Card(id, $('m-808-all'));

const t8KnobText = (id, knobs) => T8_PARAMS[id].filter((p) => knobs?.[p.id] !== undefined).map((p) => `${p.name.toLowerCase()} ${Math.round(knobs[p.id] * 100)}`).join(' · ');
function t8Draw() {
  for (const id in t8Cards) for (const card of t8Cards[id]) {
    const j = t8Jobs[id], c = t8Custom[id], st = card.querySelector('.m-808-status');
    card.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.m === t8.models[id]));
    card.querySelector('.m-808-go').disabled = !!j && !j.error;
    card.querySelector('.m-808-revert').hidden = !c || !!j;
    st.title = '';
    if (j) st.textContent = j.error ? 'failed' : j.total ? `${Math.round(100 * j.done / j.total)}%` : '…';
    else if (t8Missing.has(id) && !c) st.textContent = 'no hits';
    else if (!c) st.textContent = '16 shipped';
    else {
      const k = c.info.knobs ?? {}, moved = Object.keys(k).some((p) => Math.abs((t8.values[id][p] ?? k[p]) - k[p]) > 1e-9);
      st.textContent = `${moved ? 'old ' : ''}${c.info.normal.length} yours`;
      st.title = `cached plays your hits: ${t8KnobText(id, k)}${moved ? ' (knobs moved since)' : ''}`;
    }
    if (j?.error) st.title = j.error;
  }
}
M_PAGE_NAMES.t808 = '808';
// The 808 page is hidden for now (the grid's controls panel edits every sound); true brings its tab back
const T8_PAGE = false;
if (!T8_PAGE) {
  $('m').classList.add('m-no808');
  document.querySelector('[data-m-tab="t808"]').hidden = true;
  document.querySelector('[data-m-panel="t808"]').hidden = true;
}
t8Draw();
