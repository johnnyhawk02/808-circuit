// LT/MT/HT — Toms and LC/MC/HC — Congas, behavioural model (manual p.6,
// schematic p.9, IC15/IC17/IC18 with SW8/SW9/SW10).
//
// A cheap stand-in for voices/tom-circuit.js, fitted to its output
// (test/fit.mjs). One damped resonator per drum:
//  * the bridged-T rings at a pitch set by VR11 (TUNING); the circuit's
//    D80/D81 pair barely bends it at these levels, so there is no glide
//  * IC15b's positive feedback through R230 makes the ring build up over the
//    first ~10 ms; modelled as a short swell on the output
//  * the higher the tuning, the louder the drum (less of the kick is lost
//    in VR11)
//  * toms only: a burst of pink noise through the Q52 VCA and the R222/C75
//    low-pass, with its own envelope (C72 via D55, discharging into R218)
import { Voice, BridgedT, Pulse, OnePole, Biquad, Noise, map3, qFromDecay, rail, decayCoef, lerp, clamp } from '../dsp/core.js';
import { busVoltage } from '../dsp/mna.js';

const NAMES = { lt: 'Low Tom', mt: 'Mid Tom', ht: 'Hi Tom', lc: 'Low Conga', mc: 'Mid Conga', hc: 'Hi Conga' };

// Fitted to the circuit model (node test/fit.mjs <id> ...). f0/f5/f1: pitch
// at TUNING min / mid / max; g0/g1: level at min / max relative to mid;
// t10: ring time to 1/10; k: kick per volt of trigger bus; sw/swT: swell
// depth and time constant; noise (toms): nK level, nDec decay, nLp corner.
export const FIT = {
  lt: { f0: 79.43, f5: 86.47, f1: 97.98, g0: 0.6449, g1: 1.165, t10: 0.202, k: 0.325, sw: 0.4179, swT: 0.004526, nK: 0.4072, nDec: 0.04071, nLp: 488.9 },
  mt: { f0: 122.5, f5: 134.1, f1: 150.7, g0: 0.5521, g1: 0.9786, t10: 0.1176, k: 0.5031, sw: 0.2067, swT: 0.01405, nK: 0.03014, nDec: 0.1184, nLp: 644.2 },
  ht: { f0: 167.5, f5: 182.1, f1: 205.5, g0: 0.5063, g1: 0.8871, t10: 0.09465, k: 0.6266, sw: 0.1763, swT: 0.1282, nK: 0.01836, nDec: 0.01202, nLp: 4030 },
  lc: { f0: 175.5, f5: 191.5, f1: 215.3, g0: 0.8144, g1: 1.214, t10: 0.1796, k: 0.4278, sw: 0.4171, swT: 0.003576 },
  mc: { f0: 251, f5: 276.4, f1: 309.1, g0: 0.8089, g1: 1.156, t10: 0.09227, k: 0.2853, sw: 0.2809, swT: 0.004596 },
  hc: { f0: 369.2, f5: 405.6, f1: 451.1, g0: 0.8302, g1: 1.213, t10: 0.08274, k: 0.4948, sw: 0.4684, swT: 0.003922 },
};

class TomConga extends Voice {
  constructor(sr, key) {
    super(sr, [
      { id: 'level', name: 'Level', def: 0.8 },
      { id: 'tuning', name: 'Tuning', def: 0.5 },
    ]);
    this.key = key; const F = FIT[key];
    this.vppNormal = 3; this.vppAccent = 10;
    this.res = new BridgedT(sr);
    this.pulse = new Pulse(sr);
    this.sw = 0; this.swK = decayCoef(F.swT, sr);
    if (F.nK != null) {
      // P.N. bus: white noise through IC24b (Sallen-Key low-pass, 271 Hz, Q 0.74)
      this.white = new Noise(key.charCodeAt(0) * 97);
      this.pinkLp = new Biquad(sr, 'lp', 271, 0.74);
      this.nLp = new OnePole(sr, F.nLp, 'lp');
      this.nE = 0; this.nK = decayCoef(F.nDec, sr);
    }
    this.onParam();
  }
  onParam() {
    const F = FIT[this.key], t = clamp(this.p.tuning, 0, 1);
    this.f = map3(t, F.f0, F.f5, F.f1);
    this.g = t < 0.5 ? lerp(F.g0, 1, t * 2) : lerp(1, F.g1, t * 2 - 1);
    this.res.set(this.f, qFromDecay(this.f, F.t10));
  }
  trigger(accent = 0) {
    const F = FIT[this.key], vb = busVoltage(accent) * lerp(this.trimN, this.trimA, clamp(accent, 0, 1));
    this.pulse.fire(this.res.pulseHeight(vb * F.k * this.g, 1e-3), 1e-3);
    this.sw = F.sw;
    if (this.white) this.nE = vb * F.nK;
  }
  render(out, n) {
    const lvl = this.levelGain(), swK = this.swK;
    for (let i = 0; i < n; i++) {
      let y = this.res.tick(this.pulse.tick()) * (1 - this.sw);
      this.sw *= swK;
      if (this.white && this.nE > 1e-5) { y += this.nLp.tick(this.pinkLp.tick(this.white.white()) * this.nE); this.nE *= this.nK; }
      out[i] += rail(y) * lvl;
    }
  }
}

const make = (key) => {
  const C = class extends TomConga { constructor(sr) { super(sr, key); } };
  C.meta = { id: key, name: NAMES[key], short: key.toUpperCase() };
  return C;
};
export const LT = make('lt'), MT = make('mt'), HT = make('ht');
export const LC = make('lc'), MC = make('mc'), HC = make('hc');
