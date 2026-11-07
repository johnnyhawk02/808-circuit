// 808 Circuit as a plugin: put into the app's page before its own scripts. The page runs as it does in a browser, but
//  - its AudioContext and AudioWorkletNode are stand-ins: what it posts to the worklet goes to the plugin's player
//    (the same player, in C++), and the player's events come back to the worklet node's port;
//  - its localStorage and IndexedDB are kept by the plugin (with the project, and the shared keys in the user's
//    808 Circuit folder), seeded from window.__T8_INIT;
//  - a file it would download is saved through the plugin.
(() => {
  const init = window.__T8_INIT || {};
  const backend = () => window.__JUCE__ && window.__JUCE__.backend;
  const early = [];
  const emit = (id, v) => { const b = backend(); if (b) b.emitEvent(id, v); else early.push([id, v]); };
  const flushEarly = () => { const b = backend(); if (!b) return false; while (early.length) { const [id, v] = early.shift(); b.emitEvent(id, v); } return true; };
  if (!backend()) { const t = setInterval(() => { if (flushEarly()) clearInterval(t); }, 20); }

  // ---- binary values, as JSON: { __b64, t } ----
  const TYPES = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  const tag = (v) => {
    if (v instanceof ArrayBuffer) return { __b64: b64(new Uint8Array(v)), t: 'ArrayBuffer' };
    return { __b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), t: v.constructor.name };
  };
  const untag = (o) => {
    const u8 = unb64(o.__b64);
    if (o.t === 'ArrayBuffer') return u8.buffer;
    const T = TYPES[o.t] || Uint8Array;
    return new T(u8.buffer, 0, u8.byteLength / T.BYTES_PER_ELEMENT);
  };
  // every binary value tagged (for storage)
  const enc = (v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return tag(v);
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = enc(v[k]); return o; }
    return v;
  };
  const dec = (v) => {
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') { if (typeof v.__b64 === 'string') return untag(v); const o = {}; for (const k in v) o[k] = dec(v[k]); return o; }
    return v;
  };
  // (errors on the page, for the plugin's debug log: T8_DEBUG=1)
  addEventListener('error', (e) => emit('t8log', `${e.message} (${e.filename}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => emit('t8log', `unhandled: ${e.reason && (e.reason.stack || e.reason)}`));
  const warn = console.warn.bind(console);
  console.warn = (...a) => { warn(...a); try { emit('t8log', 'warn: ' + a.map(String).join(' ')); } catch (e) {} };
  window.__t8 = { emit, enc, dec, tag, untag, b64, init };

  // ---- messages for the player: the hits and the IR as binary, every other typed array as numbers ----
  const BIN = new Set(['pcm', 'L', 'R']);
  const encMsg = (v, key) => {
    if (v instanceof ArrayBuffer || (ArrayBuffer.isView(v) && BIN.has(key))) return tag(v);
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (Array.isArray(v)) return v.map((x) => encMsg(x));
    if (v && typeof v === 'object') { const o = {}; for (const k in v) if (v[k] !== undefined) o[k] = encMsg(v[k], k); return o; }
    return v;
  };
  const SHIPPED = init.shipped || {}, SHIPPED_BYTES = init.shippedBytes || {};
  const prep = (m) => {
    if (m && m.type === 'atBar') return { type: 'atBar', m: prep(m.m) };
    // the shipped hits are in the plugin already: just say which
    if (m && m.type === 'cache808' && SHIPPED[m.id] && m.pcm && m.pcm.byteLength === SHIPPED_BYTES[m.id]
      && JSON.stringify(m.info) === JSON.stringify(SHIPPED[m.id])) return { type: 'cache808', id: m.id, shipped: true };
    return encMsg(m);
  };
  // what's posted in one go goes as one (so the player takes it in one block); while the page boots, a preset's
  // "from the next bar" is now (the page is only catching up with the plugin)
  let batch = null;
  window.__t8.booting = true;
  const post = (m) => {
    if (window.__t8.booting && m && m.type === 'atBar') m = m.m;
    if (!batch) { batch = []; queueMicrotask(() => { const b = batch; batch = null; emit('t8', JSON.stringify(b)); }); }
    batch.push(prep(m));
  };

  // ---- the audio: stand-ins for the AudioContext and the worklet ----
  let theNode = null;
  class T8AudioContext {
    constructor() {
      this.sampleRate = init.rate || 48000; this.state = 'running'; this.outputLatency = 0; this.baseLatency = 0;
      this.destination = { channelCount: 2 }; this.audioWorklet = { addModule: () => Promise.resolve() };
      this.onstatechange = null; this.t0 = performance.now();
    }
    get currentTime() { return (performance.now() - this.t0) / 1000; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    addEventListener() {} removeEventListener() {}
  }
  class T8WorkletNode {
    constructor() { this.port = { onmessage: null, postMessage: post, start() {}, close() {} }; theNode = this; }
    connect() {} disconnect() {}
  }
  window.AudioContext = window.webkitAudioContext = T8AudioContext;
  window.AudioWorkletNode = T8WorkletNode;

  // ---- the player's events, and the host's ----
  const onHost = (h) => {
    try {
      if (typeof perf !== 'undefined' && typeof setPerf === 'function' && h.bpm) {
        const b = clampTempo(Math.round(h.bpm));
        if (b !== perf.tempo) setPerf('tempo', b);
      }
      if (typeof playing !== 'undefined' && h.playing !== playing) document.getElementById('play').click();
    } catch (e) { console.warn('host sync', e); }
  };
  window.__t8host = onHost;
  const onEv = (text) => {
    let evs; try { evs = JSON.parse(text); } catch (e) { return; }
    for (const ev of evs) {
      if (ev.type === 'host') { onHost(ev); continue; }
      if (ev.type === 'patSel') { try { g8Key(ev.n); } catch (e) {} continue; }
      if (ev.type === 'recData') { ev.L = untag(ev.L); ev.R = untag(ev.R); }
      if (theNode && theNode.port.onmessage) theNode.port.onmessage({ data: ev });
    }
  };
  const listen = () => { const b = backend(); if (!b) return setTimeout(listen, 20); b.addEventListener('t8ev', onEv); };
  listen();

  // ---- localStorage ----
  const store = new Map(Object.entries(init.store || {}));
  const fake = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { k = String(k); v = String(v); if (store.get(k) === v) return; store.set(k, v); emit('t8store', { k, v }); },
    removeItem: (k) => { k = String(k); if (!store.has(k)) return; store.delete(k); emit('t8store', { k, v: null }); },
    clear: () => { store.clear(); emit('t8store', { clear: true }); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  try { Object.defineProperty(window, 'localStorage', { get: () => fake, configurable: true }); } catch (e) {}
  if (window.localStorage !== fake && window.Storage) {
    // (where window's own can't be replaced: the methods of every Storage)
    for (const k of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) Storage.prototype[k] = function (...a) { return fake[k](...a); };
    try { Object.defineProperty(Storage.prototype, 'length', { get: () => store.size, configurable: true }); } catch (e) {}
  }

  // ---- IndexedDB: in memory, from and to the plugin ----
  const dbs = {};
  for (const [db, stores] of Object.entries(init.idb || {})) {
    dbs[db] = {};
    for (const [st, kv] of Object.entries(stores || {})) { dbs[db][st] = new Map(); for (const [k, v] of Object.entries(kv || {})) dbs[db][st].set(k, dec(v)); }
  }
  const later = (f) => setTimeout(f, 0);
  const req = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, readyState: 'pending' });
  const done = (r, result) => { r.result = result; r.readyState = 'done'; if (r.onsuccess) r.onsuccess({ target: r }); };
  class Tx {
    constructor(db, names, mode) { this.db = db; this.mode = mode; this.oncomplete = this.onerror = this.onabort = null; this.error = null; this.reqs = []; later(() => this.finish()); }
    objectStore(name) { return new Store(this, name); }
    finish() { for (const [r, v] of this.reqs) done(r, v); if (this.oncomplete) this.oncomplete({ target: this }); }
    abort() {}
  }
  class Store {
    constructor(tx, name) { this.tx = tx; this.name = name; const d = (dbs[tx.db.name] ??= {}); this.m = (d[name] ??= new Map()); }
    q(v) { const r = req(); this.tx.reqs.push([r, v]); return r; }
    keys() { return [...this.m.keys()].sort(); }
    get(k) { return this.q(this.m.get(String(k))); }
    getAll() { return this.q(this.keys().map((k) => this.m.get(k))); }
    getAllKeys() { return this.q(this.keys()); }
    count() { return this.q(this.m.size); }
    put(v, k) { k = String(k); this.m.set(k, v); emit('t8idb', JSON.stringify({ op: 'put', db: this.tx.db.name, store: this.name, key: k, value: enc(v) })); return this.q(k); }
    add(v, k) { return this.put(v, k); }
    delete(k) { k = String(k); this.m.delete(k); emit('t8idb', JSON.stringify({ op: 'delete', db: this.tx.db.name, store: this.name, key: k })); return this.q(undefined); }
    clear() { this.m.clear(); emit('t8idb', JSON.stringify({ op: 'clear', db: this.tx.db.name, store: this.name })); return this.q(undefined); }
  }
  class Db {
    constructor(name) { this.name = name; }
    get objectStoreNames() { const n = Object.keys(dbs[this.name] || {}); return { contains: (s) => n.includes(s), length: n.length, item: (i) => n[i] }; }
    createObjectStore(name) { (dbs[this.name] ??= {})[name] ??= new Map(); return new Store({ db: this, reqs: [] }, name); }
    transaction(names, mode) { return new Tx(this, names, mode); }
    close() {}
  }
  const fakeIdb = {
    open(name) {
      const r = req(); r.onupgradeneeded = null; r.onblocked = null;
      later(() => {
        const db = new Db(name); r.result = db;
        if (!dbs[name]) { dbs[name] = {}; if (r.onupgradeneeded) r.onupgradeneeded({ target: r, oldVersion: 0 }); }
        done(r, db);
      });
      return r;
    },
    deleteDatabase(name) { const r = req(); delete dbs[name]; later(() => done(r, undefined)); return r; },
  };
  try { Object.defineProperty(window, 'indexedDB', { get: () => fakeIdb, configurable: true }); } catch (e) {}

  // ---- downloads: saved through the plugin ----
  const saveLink = (a) => {
    const name = a.getAttribute('download') || 'download';
    fetch(a.href).then((r) => r.arrayBuffer()).then((buf) => emit('t8save', { name, b64: b64(new Uint8Array(buf)) }))
      .catch((e) => console.warn('save', e));
  };
  const isDownload = (a) => a && a.hasAttribute && a.hasAttribute('download') && a.href;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (isDownload(this)) saveLink(this); else click.call(this); };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (isDownload(a)) { e.preventDefault(); saveLink(a); }
  }, true);
})();
