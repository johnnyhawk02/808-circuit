// CB — Cowbell, behavioural model (manual p.6, schematic p.13 "COWBELL").
//
// A cheap stand-in for voices/cb-circuit.js, fitted to its output
// (test/fit.mjs). The 540 and 800 Hz Schmitt oscillators each switch a
// transistor (Q15, Q14); while one is off the envelope current flows past it
// into the IC2b band-pass, so each oscillator contributes the envelope gated
// on and off by its square (a unipolar pulse train, not a +-1 square). The
// envelope is C9 with R82/C34 as a second, slower load: a fast drop then a
// long tail. After IC2b, C76/R117 high-pass the output into IC6.
import { Voice, Biquad, OnePole, rail, decayCoef, lerp, clamp } from '../dsp/core.js';
import { voicingTrigger } from './cb-circuit.js';

export const meta = { id: 'cb', name: 'Cowbell', short: 'CB' };

// Fitted to the circuit model (node test/fit.mjs cb ...).
export const FIT = {
  gLo: 0.8308, gHi: 1.216,           // 540 Hz (Q15) and 800 Hz (Q14) paths
  bpF: 923.4, bpQ: 2.935,         // IC2b band-pass
  fast: 0.008703, slow: 0.1298,    // envelope time constants, s
  mixS: 0.1849,                 // share of the slow tail
  inHp: 1365,                 // C30/C31 coupling into IC2b, Hz
  g: 1.125,                     // volts out per volt of trigger
};

export class CB extends Voice {
  constructor(sr, metal) {
    super(sr, [{ id: 'level', name: 'Level', def: 0.8 }]);
    this.metal = metal;
    this.vppNormal = 3.5; this.vppAccent = 12;
    const F = FIT;
    this.bp = new Biquad(sr, 'bp', F.bpF, F.bpQ);
    this.hp = new OnePole(sr, 1 / (2 * Math.PI * 22e3 * 0.022e-6), 'hp');
    this.inHp = new OnePole(sr, F.inHp, 'hp');
    this.kF = decayCoef(F.fast, sr); this.kS = decayCoef(F.slow, sr);
    this.eF = 0; this.eS = 0;
  }
  trigger(accent = 0) {
    const F = FIT, v = voicingTrigger(accent) * lerp(this.trimN, this.trimA, clamp(accent, 0, 1)) * F.g;
    this.eF = v * (1 - F.mixS); this.eS = v * F.mixS;
  }
  render(out, n) {
    const F = FIT, lvl = this.levelGain(), lo = this.metal.cbLo, hi = this.metal.cbHi;
    for (let i = 0; i < n; i++) {
      this.eF *= this.kF; this.eS *= this.kS;
      const e = this.eF + this.eS;
      const g = (1 - lo[i]) * 0.5 * F.gLo + (1 - hi[i]) * 0.5 * F.gHi; // on while the square is low (band-limited edges)
      out[i] += rail(this.hp.tick(this.bp.tick(this.inHp.tick(g * e)))) * lvl;
    }
  }
}
