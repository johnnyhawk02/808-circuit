// The kit: owns the shared metal oscillators, all 16 voices, a sample-
// accurate trigger queue and the master bus. Host-agnostic (worklet,
// ScriptProcessor or Node).
import { MetalBank } from './metal.js';
import { CALIBRATION, LEVEL } from './calibration.js';
import { SampleVoice } from './sampler.js';
import { BD } from '../voices/bd.js';
import { MetalCircuit } from './metal-circuit.js';
import { NoiseBus } from './noise.js';
import { CIRCUITS } from '../voices/circuits.js';
import { CachedVoice } from './cache.js';
import { SD } from '../voices/sd.js';
import { LT, MT, HT, LC, MC, HC } from '../voices/tom.js';
import { RS } from '../voices/rs.js';
import { CL } from '../voices/cl.js';
import { CP } from '../voices/cp.js';
import { MA } from '../voices/ma.js';
import { CB } from '../voices/cb.js';
import { CY } from '../voices/cy.js';
import { OH, CH } from '../voices/hats.js';

// Panel order. Volts -> digital: 12 V peak is about -6 dBFS.
export const VOICES = [
  ['bd', 'Bass Drum', BD], ['sd', 'Snare Drum', SD],
  ['lt', 'Low Tom', LT], ['mt', 'Mid Tom', MT], ['ht', 'Hi Tom', HT],
  ['lc', 'Low Conga', LC], ['mc', 'Mid Conga', MC], ['hc', 'Hi Conga', HC],
  ['rs', 'Rim Shot', RS], ['cl', 'Claves', CL],
  ['cp', 'Hand Clap', CP], ['ma', 'Maracas', MA],
  ['cb', 'Cowbell', CB], ['cy', 'Cymbal', CY],
  ['oh', 'Open Hi-Hat', OH], ['ch', 'Closed Hi-Hat', CH],
];
export const VOLT_SCALE = 1 / 24;
const NOISE_IDS = ['sd', 'lt', 'mt', 'ht', 'cp', 'ma'];
const METAL_IDS = ['cb', 'cy', 'oh', 'ch'];
// CH renders before OH so the circuit OH can read CH's envelope (choke)
const ORDER = VOICES.map(([id]) => id).filter((id) => id !== 'oh').concat('oh');

export class Kit {
  // opts.circuits = false skips building the circuit models (UI-only copies)
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.metal = new MetalBank(sr);
    this.voices = {};
    for (const [id, , C] of VOICES) {
      const v = (this.voices[id] = new C(sr, this.metal));
      const c = CALIBRATION[id];
      if (c) { v.trimN = c[0]; v.trimA = c[1]; }
      v.levelPts = LEVEL[id];
    }
    // Every voice exists twice: the behavioural model above and the
    // component-level circuit simulation. `model[id]` picks which one plays.
    this.behavioural = { ...this.voices };
    // ...and as recordings of a real TR-808 (dsp/sampler.js), once loaded
    this.sampled = {};
    for (const [id] of VOICES) {
      const v = (this.sampled[id] = new SampleVoice(sr, id, this.voices[id].params));
      v.levelPts = LEVEL[id];
    }
    this.shared = { noise: new NoiseBus(sr), metal: new MetalCircuit(sr) };
    this.circuit = {};
    if (opts.circuits !== false) for (const id in CIRCUITS) this.circuit[id] = new CIRCUITS[id](sr, this.shared);
    if (this.circuit.oh && this.circuit.ch) this.circuit.oh.chokeFrom = this.circuit.ch;
    // third model: hits pre-rendered by the circuit (dsp/cache.js), loaded
    // per voice with loadCache()
    this.cached = {};
    for (const [id] of VOICES) this.cached[id] = new CachedVoice(sr, this.behavioural[id].params);
    this.model = {};
    for (const [id] of VOICES) this.setModel(id, 'circuit');
    this.master = 0.8;
    this.frame = 0;      // running sample counter
    this.queue = [];     // {frame, id, accent}
    this.mix = new Float32Array(128);
    this.solo = null;    // render a single voice (tests)
  }
  spec() {
    return VOICES.map(([id, name]) => ({ id, name, params: this.voices[id].params, values: { ...this.voices[id].p } }));
  }
  set(id, param, value) {
    this.behavioural[id]?.set(param, value);
    this.sampled[id]?.set(param, value);
    this.circuit[id]?.set(param, value);
    this.cached[id]?.set(param, value);
  }
  // model: 'circuit' | 'cached' | 'behavioural' | 'sample'
  setModel(id, model) {
    const m = model === 'sample' ? 'sample'
      : model === 'cached' && this.cached[id]?.loaded ? 'cached'
      : model === 'behavioural' || model === 'cached' || !this.circuit[id] ? 'behavioural' : 'circuit';
    this.model[id] = m;
    this.voices[id] = m === 'sample' ? this.sampled[id] : this[m][id];
  }
  loadCache(id, info, int16) { this.cached[id].load(info, int16); }
  // one recording: key is the knob positions from the file name ('5050', '')
  loadSample(id, key, wav) { this.sampled[id]?.add(key, wav); }
  setAllModels(model) { for (const [id] of VOICES) this.setModel(id, model); }
  setBdModel(model) { this.setModel('bd', model); } // older hosts
  // when = absolute frame, or undefined for "now"
  trigger(id, accent = 0, when) {
    this.queue.push({ frame: when ?? this.frame, id, accent });
    this.queue.sort((a, b) => a.frame - b.frame);
  }
  _fire(id, accent) {
    const v = this.voices[id];
    if (!v) return;
    if (id === 'ch') {
      // behavioural OH is choked directly; the circuit OH is choked by the
      // circuit CH's C63 envelope, or, if CH plays behavioural, by a pulse
      this.behavioural.oh?.choke?.();
      this.sampled.oh?.choke?.();
      this.cached.oh?.choke();
      if (this.model.ch !== 'circuit') this.circuit.oh?.choke?.();
    }
    v.trigger(accent);
  }
  _usesCircuit(ids) { return ids.some((id) => this.model[id] === 'circuit' || this.circuit[id]?.awake); }
  // Render n frames of mono, digital scale, into dst (overwrites).
  render(dst, n) {
    let done = 0;
    while (done < n) {
      // split the block at the next queued trigger for sample accuracy
      while (this.queue.length && this.queue[0].frame <= this.frame) {
        const e = this.queue.shift();
        this._fire(e.id, e.accent);
      }
      let len = n - done;
      if (this.queue.length) len = Math.max(1, Math.min(len, this.queue[0].frame - this.frame));
      this._renderChunk(dst, done, len);
      done += len; this.frame += len;
    }
  }
  _renderChunk(dst, off, n) {
    if (this.mix.length < n) this.mix = new Float32Array(n);
    const mix = this.mix; mix.fill(0, 0, n);
    this.metal.render(n);
    const sh = this.shared;
    if (this._usesCircuit(NOISE_IDS)) sh.noise.render(n);
    sh.metal.active = () => this._usesCircuit(METAL_IDS);
    sh.metal.render(n);
    const ids = this.solo ? [this.solo] : ORDER;
    for (const id of ids) this.voices[id].render(mix, n);
    // the models that aren't selected finish any tail they were playing
    if (!this.solo) for (const [id] of VOICES) for (const m of ['behavioural', 'circuit', 'cached', 'sampled']) {
      const other = this[m][id];
      if (!other || other === this.voices[id]) continue;
      if (m === 'behavioural' || (other.awake ?? true)) other.render(mix, n);
    }
    const g = this.master * VOLT_SCALE;
    for (let i = 0; i < n; i++) {
      const x = mix[i] * g;
      dst[off + i] = x > 1 || x < -1 ? Math.tanh(x) : x; // master soft limit
    }
  }
}
