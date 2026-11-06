// Cached circuit hits: each voice played back from hits rendered offline by
// the circuit model (test/cache-render.mjs) at the default knob settings.
// 16 slightly different hits per voice and accent level (other noise and
// metal-oscillator states, trigger level +-1.5%); every trigger picks one at
// random, never the same one twice in a row. Costs next to nothing.
//
// Knobs: LEVEL follows the circuit's own level response (measured when the
// cache was rendered). DECAY, where the voice has one, shortens the hit with
// an exponential fade below its default setting; at or above the default the
// hit plays as rendered. Pitch and tone knobs are ignored. A closed hat
// chokes a ringing open hat with a 10 ms fade.
//
// Files: cache/<id>.wav (16-bit mono, the hits back to back, normal ones
// first) and cache/index.json ({ <id>: { sr, scale, normal: [[start, len]..],
// accent: [..], level: [gain at level 0, 1/8 .. 1], and for a voice with a
// SNAP knob dryNormal / dryAccent: the same hits with SNAP full } }).
import { Voice, clamp } from './core.js';

export const VARIANTS = 16;

// minimal 16-bit PCM mono WAV
export function writeWav(int16, sr) {
  const b = Buffer.alloc(44 + int16.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + int16.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(int16.length * 2, 40);
  Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).copy(b, 44);
  return b;
}
// -> Int16Array of the data chunk (16-bit mono only)
export function readWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let p = 12;
  while (p + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    const len = dv.getUint32(p + 4, true);
    if (id === 'data') return new Int16Array(arrayBuffer.slice(p + 8, p + 8 + len));
    p += 8 + len + (len & 1);
  }
  throw new Error('no data chunk');
}

export class CachedVoice extends Voice {
  // params: the circuit voice's knob list (same ids, so kit.set reaches both)
  constructor(sr, params) {
    super(sr, params.map((p) => ({ ...p })));
    this.data = null; this.info = null;
    this.plays = [];          // { hit: [normal, accent], mix, pos, gain }
    this.last = -1;
    this.rng = 0x9e3779b9;
  }
  get loaded() { return !!this.data; }
  load(info, int16) {
    this.info = info;
    const s = info.scale / 32767;
    const cut = (r) => { const x = new Float32Array(r[1]); for (let i = 0; i < r[1]; i++) x[i] = int16[r[0] + i] * s; return x; };
    this.data = { normal: info.normal.map(cut), accent: info.accent.map(cut) };
    // SNAP (clap): the same hits with the reverb path off, mixed in by the knob
    if (info.dryNormal) { this.data.dryNormal = info.dryNormal.map(cut); this.data.dryAccent = info.dryAccent.map(cut); }
    this.rate = info.sr / this.sr;  // playback step when the host runs at another rate
  }
  _rand() { let x = this.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rng = x >>> 0; return this.rng / 4294967296; }
  trigger(accent = 0) {
    if (!this.data) return;
    const n = this.data.normal.length;
    let k = Math.floor(this._rand() * n);
    if (k === this.last && n > 1) k = (k + 1 + Math.floor(this._rand() * (n - 1))) % n;
    this.last = k;
    // in-between accent settings mix the normal and accented hit
    const d = this.data, snap = d.dryNormal ? clamp(this.p.snap ?? 0, 0, 1) : 0;
    // SNAP: each hit is blended with its dry twin (the mixer is linear, so
    // this is the circuit with its reverb path turned down)
    this.plays.push({ a: d.normal[k], b: d.accent[k], da: snap ? d.dryNormal[k] : null, db: snap ? d.dryAccent[k] : null, snap, mix: clamp(accent, 0, 1), pos: 0 });
    if (this.plays.length > 8) this.plays.shift();
  }
  get awake() { return this.plays.length > 0; }
  // closed hat chokes the open hat: 10 ms fade
  choke() { for (const pl of this.plays) if (pl.cut === undefined) pl.cut = pl.pos; }
  _levelGain() {
    const t = this.info.level, x = clamp(this.p.level ?? 1, 0, 1) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(x));
    return t[i] + (t[i + 1] - t[i]) * (x - i);
  }
  // fade rate (per second): 0 at or above the default DECAY
  _fade(len) {
    const def = this.params.find((q) => q.id === 'decay')?.def;
    if (def === undefined) return 0;
    const d = clamp(this.p.decay, 0, 1);
    return d >= def ? 0 : 3 * (def / Math.max(d, 0.01) - 1) / (len / this.info.sr);
  }
  render(out, n) {
    if (!this.plays.length) return;
    const g = this._levelGain(), step = this.rate, isr = 1 / this.info.sr;
    for (const pl of this.plays) {
      // a pure normal or accent hit plays alone (its own length)
      const m = pl.mix, a = m === 1 ? pl.b : pl.a, b = m === 0 || m === 1 ? a : pl.b;
      const da = m === 1 ? pl.db : pl.da, db = m === 0 || m === 1 ? da : pl.db, sn = pl.snap;
      const len = (pl.len ??= Math.min(a.length, b.length, da ? da.length : Infinity, db ? db.length : Infinity)), k = this._fade(len);
      let pos = pl.pos;
      for (let i = 0; i < n && pos < len - 1; i++, pos += step) {
        const j = pos | 0, f = pos - j;
        let xa = a[j] + (a[j + 1] - a[j]) * f;
        if (sn) xa += (da[j] + (da[j + 1] - da[j]) * f - xa) * sn;
        let y = xa;
        if (b !== a) { let xb = b[j] + (b[j + 1] - b[j]) * f; if (sn) xb += (db[j] + (db[j + 1] - db[j]) * f - xb) * sn; y = xa + (xb - xa) * m; }
        if (k) y *= Math.exp(-k * pos * isr);
        if (pl.cut !== undefined) { const c = 1 - (pos - pl.cut) * isr * 100; if (c <= 0) { pos = len; break; } y *= c; }
        out[i] += y * g;
      }
      pl.pos = pos;
    }
    this.plays = this.plays.filter((pl) => pl.pos < pl.len - 1);
  }
}
