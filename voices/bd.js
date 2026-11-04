// BD — Bass Drum, behavioural model (manual p.5, schematic p.9 "BASS DRUM").
//
// A cheap stand-in for voices/bd-circuit.js, fitted to its output
// (test/fit.mjs): one zero-delay state-variable resonator plus a few
// envelopes, instead of solving the network every sample.
//
//  * The bridged-T around IC12a rings as a damped sine. For the first few ms
//    after the trigger Q43 shorts R165, so the first half-cycle runs at about
//    twice the frequency; then C39/R161 give it a second, smaller kick.
//  * After that the pitch slides down from ~58 Hz to the network's resting
//    ~49 Hz as C43 recovers; the slide is quicker at short DECAY settings.
//  * VR6 (DECAY) sets the ring time; VR5 (TONE) with R171/C45 is a one-pole
//    low-pass whose corner is computed from the parts, as in the circuit.
//  * The trigger edge leaks through C40 into IC12 and gives the click.
import { Voice, BridgedT, Pulse, OnePole, map3, qFromDecay, rail, clamp, lerp } from '../dsp/core.js';

export const meta = { id: 'bd', name: 'Bass Drum', short: 'BD' };

// Fitted to the circuit model (node test/fit.mjs bd ...).
export const FIT = {
  f0: 48.42,        // resting pitch, Hz
  glide: 0.2355,   // extra pitch at the start, fraction of f0
  glideK: 0.2073,  // glide time constant as a fraction of the decay time
  d0: 0.04829, d5: 0.3033, d1: 0.8946, // ring time to 1/10 at DECAY 0 / mid / max, s
  fast: 3.185,       // pitch multiple while Q43 shorts R165
  seg: 0.00368,    // how long it lasts, s
  kick1: 1.527,    // first pulse, x peak amplitude
  kick2: 0.3734,    // C39 re-trigger pulse
  click: 0.3478,    // C40 trigger feed-through
  aN: 1.662, aA: 3.434,  // ring amplitude, normal / full accent, V
};

export class BD extends Voice {
  constructor(sr) {
    super(sr, [
      { id: 'level', name: 'Level', def: 0.8 },
      { id: 'tone', name: 'Tone', def: 0.5 },
      { id: 'decay', name: 'Decay', def: 0.5 },
    ]);
    this.vppNormal = 3.5; this.vppAccent = 10;
    this.res = new BridgedT(sr);
    this.pulse = new Pulse(sr);
    this.tone = new OnePole(sr, 1000, 'lp');
    this.click = new OnePole(sr, 400, 'hp');
    this.t = 1e9; // samples since trigger
    this.amp = 0;
    this.onParam();
  }
  onParam() {
    const F = FIT;
    this.t10 = map3(this.p.decay, F.d0, F.d5, F.d1);
    this.q = qFromDecay(F.f0, this.t10);
    this.gCoef = Math.exp(-1 / (F.glideK * this.t10 * this.sr));
    // VR5 10k C-taper || R172 10k, in series with R171 220R, into C45 .1u
    const vr5 = 10e3 * (1 - clamp(this.p.tone, 0, 1)) ** 2 + 1;
    const R = 220 + (vr5 * 10e3) / (vr5 + 10e3);
    this.tone.set(1 / (2 * Math.PI * R * 0.1e-6));
  }
  trigger(accent = 0) {
    const F = FIT;
    this.amp = lerp(F.aN * this.trimN, F.aA * this.trimA, clamp(accent, 0, 1));
    this.t = 0;
    this.g = 1;
    this.res.set(F.f0 * (1 + F.glide) * F.fast, this.q);
    this.pulse.fire(this.res.pulseHeight(this.amp * F.kick1, 1e-3), 1e-3);
    this.segN = Math.max(1, Math.round(F.seg * this.sr));
  }
  render(out, n) {
    const F = FIT, sr = this.sr, lvl = this.levelGain(), clickN = sr * 0.001;
    for (let i = 0; i < n; i++) {
      if (this.t === this.segN) {
        this.res.set(F.f0 * (1 + F.glide * this.g), this.q);
        this.pulse.fire(this.res.pulseHeight(this.amp * F.kick2, 1e-3), 1e-3);
      } else if (this.t > this.segN && (this.t & 15) === 0) {
        this.res.set(F.f0 * (1 + F.glide * this.g), this.q);
      }
      this.g *= this.gCoef;
      let y = rail(this.res.tick(this.pulse.tick()));
      y += this.click.tick(this.t < clickN ? this.amp * F.click : 0);
      out[i] += this.tone.tick(y) * lvl;
      this.t++;
    }
  }
}
