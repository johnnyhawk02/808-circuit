// Shared circuit building blocks for the TR-808 voice prototypes.
// Everything runs per-sample in plain JS so the same code works in an
// AudioWorklet, a ScriptProcessor fallback, or Node (offline tests).
//
// Signals are kept in "volts" so the levels in the service manual's
// voice-check table (Vpp at MULTI OUT) can be used directly. The kit
// scales volts to digital full scale at the very end.

export const LN10 = Math.log(10);

// Time for a decaying envelope to reach 1/10 of its start (the manual's
// "decay time" definition, see CHECKING VOICES on p.14) -> time constant.
export const tauFromDecay = (t10) => t10 / LN10;

// Per-sample multiplier for an exponential decay with time constant tau.
export const decayCoef = (tau, sr) => (tau <= 0 ? 0 : Math.exp(-1 / (tau * sr)));

// Q that makes a resonator ring down to 1/10 in t10 seconds at f Hz.
export const qFromDecay = (f, t10) => (Math.PI * f * t10) / LN10;

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// Piecewise-exponential map through the manual's short/mid/long points.
export function map3(p, lo, mid, hi) {
  p = clamp(p, 0, 1);
  return p < 0.5
    ? Math.exp(lerp(Math.log(lo), Math.log(mid), p * 2))
    : Math.exp(lerp(Math.log(mid), Math.log(hi), (p - 0.5) * 2));
}

// ---------------------------------------------------------------------------
// Bridged-T resonator (manual Fig. 11). An op-amp with a bridged-T network
// in its feedback path is a high-Q band-pass: f = 1/(2*pi*sqrt(R1 R2 C1 C2)),
// Q = sqrt(R2/R1) / (sqrt(C1/C2) + sqrt(C2/C1)). A trigger pulse makes it
// ring as a damped sine. Modelled as a zero-delay-feedback state-variable
// filter so frequency and Q can be modulated per sample (BD / tom pitch tricks).
export class BridgedT {
  constructor(sr) {
    this.sr = sr;
    this.ic1 = 0; this.ic2 = 0;
    this.f = 100; this.q = 10;
    this._coef();
  }
  static fromParts(R1, R2, C1, C2) {
    return {
      f: 1 / (2 * Math.PI * Math.sqrt(R1 * R2 * C1 * C2)),
      q: Math.sqrt(R2 / R1) / (Math.sqrt(C1 / C2) + Math.sqrt(C2 / C1)),
    };
  }
  set(f, q) {
    if (f === this.f && q === this.q) return;
    this.f = f; this.q = q; this._coef();
  }
  _coef() {
    const f = Math.min(this.f, this.sr * 0.45);
    this.g = Math.tan((Math.PI * f) / this.sr);
    this.k = 1 / this.q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  // Returns the unity-peak-gain band-pass output.
  tick(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return this.k * v1;
  }
  // Pulse height that makes a rectangular pulse of width w (s) leave the
  // resonator ringing with peak amplitude `amp`.
  pulseHeight(amp, w) {
    const s = Math.abs(Math.sin(Math.PI * this.f * w));
    return amp / (2 * this.k * Math.max(s, 0.05));
  }
  reset() { this.ic1 = this.ic2 = 0; }
}

// Rectangular trigger pulse, the 808's common trigger is ~1 ms wide.
export class Pulse {
  constructor(sr) { this.sr = sr; this.n = 0; this.h = 0; }
  fire(height, width) { this.h = height; this.n = Math.max(1, Math.round(width * this.sr)); }
  tick() { if (this.n > 0) { this.n--; return this.h; } return 0; }
}

// Generic RBJ biquad for the passive/active filters around the voices.
export class Biquad {
  constructor(sr, type = 'lp', f = 1000, q = 0.707) {
    this.sr = sr; this.type = type;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(f, q);
  }
  set(f, q = this.q) {
    this.f = f; this.q = q;
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr;
    const c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0, b1, b2;
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    switch (this.type) {
      case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; break;
      case 'bp': b0 = a; b1 = 0; b2 = -a; break; // 0 dB peak
      default:   b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  tick(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// One-pole RC filters (coupling caps, tone controls).
export class OnePole {
  constructor(sr, f = 1000, type = 'lp') { this.sr = sr; this.type = type; this.z = 0; this.set(f); }
  set(f) { this.f = f; this.a = 1 - Math.exp((-2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr); }
  tick(x) {
    this.z += this.a * (x - this.z);
    return this.type === 'hp' ? x - this.z : this.z;
  }
}

// Exponential RC envelope: instantly charged by a trigger, discharges
// through a resistor. Optional short attack (charge through a resistor).
export class RCEnv {
  constructor(sr) { this.sr = sr; this.v = 0; this.target = 0; this.att = 0; this.coef = 0; this.attCoef = 0; this.phase = 0; }
  setDecay(t10) { this.coef = decayCoef(tauFromDecay(t10), this.sr); }
  setTau(tau) { this.coef = decayCoef(tau, this.sr); }
  setAttack(tau) { this.attCoef = tau > 0 ? decayCoef(tau, this.sr) : 0; }
  fire(level) {
    this.target = level;
    if (this.attCoef > 0) this.phase = 1; else { this.v = level; this.phase = 2; }
  }
  tick() {
    if (this.phase === 1) {
      this.v = this.target + (this.v - this.target) * this.attCoef;
      if (this.v >= this.target * 0.98) this.phase = 2;
    } else {
      this.v *= this.coef;
    }
    return this.v;
  }
}

// Swing-type VCA (manual Fig. 12). The envelope feeds the collector of a
// transistor through R2/D; the AC-coupled signal drives its base. On the
// positive half the transistor pulls the collector down toward ground, but
// never below it, so the output is the signal clipped by the envelope:
// a chopped, harmonically rich waveform ("ringing metallic sound").
// Returns the AC part (the collector minus the envelope's own DC).
export function swingVCA(env, sig, gain) {
  const pull = sig > 0 ? sig * gain : 0;
  return -(pull < env ? pull : env);
}

// Noise. The 808 main board has one white-noise source (transistor
// junction) and a low-pass "pink" version of it (block diagram, p.7).
export class Noise {
  constructor(seed = 22222) { this.s = seed >>> 0 || 1; }
  white() {
    // xorshift32 -> uniform [-1,1); scaled to ~unit RMS-ish
    let s = this.s;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this.s = s;
    return (s / 2147483648 - 1) * 1.7;
  }
}
export class PinkNoise {
  // Paul Kellet's economy pink filter on top of white noise.
  constructor(seed) { this.n = new Noise(seed); this.b0 = this.b1 = this.b2 = 0; }
  tick() {
    const w = this.n.white();
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.25;
  }
}

// Soft rail clipping for op-amps on +-15 V supplies.
export const rail = (x, v = 13) => v * Math.tanh(x / v);

// PolyBLEP-corrected square for the 40106/HD14584 Schmitt-trigger oscillators.
export class SchmittOsc {
  constructor(sr, f, phase = Math.random()) { this.sr = sr; this.p = phase; this.setFreq(f); }
  setFreq(f) { this.f = f; this.dt = f / this.sr; }
  tick() {
    const dt = this.dt;
    let p = this.p + dt; if (p >= 1) p -= 1; this.p = p;
    let y = p < 0.5 ? 1 : -1;
    y += blep(p, dt);
    let q = p + 0.5; if (q >= 1) q -= 1;
    y -= blep(q, dt);
    return y;
  }
}
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// Small helper for voices: each exposes `params` (spec list) and `p` values.
export class Voice {
  constructor(sr, spec) {
    this.sr = sr;
    this.params = spec;
    this.p = {};
    for (const s of spec) this.p[s.id] = s.def;
    this.trimN = 1; this.trimA = 1; // output calibration, see dsp/calibration.js
  }
  set(id, v) { this.p[id] = v; this.onParam?.(id, v); }
  // LEVEL knob gain, following the circuit's pot taper (dsp/calibration.js)
  levelGain() { return levelLaw(this.levelPts, this.p.level); }
  // accent: 0 = normal hit, 1 = full accent (ACCENT knob fully up).
  // Peak-to-peak target in volts for this hit, from the manual's table.
  vpp(accent) {
    return lerp(this.vppNormal * this.trimN, this.vppAccent * this.trimA, clamp(accent, 0, 1));
  }
}

// LEVEL pot law through the circuit model's gains at 1/4 and 1/2 rotation
// ([g25, g50], measured by test/calibrate.mjs): linear up to 1/4, then
// exponential (log-linear) segments up to full. Without points: linear.
export function levelLaw(pts, l) {
  l = clamp(l, 0, 1);
  if (!pts) return l;
  const [g25, g50] = pts;
  if (l <= 0.25) return g25 * l / 0.25;
  if (l <= 0.5) return g25 * Math.pow(g50 / g25, (l - 0.25) / 0.25);
  return g50 * Math.pow(1 / g50, (l - 0.5) / 0.5);
}
