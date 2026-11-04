// CY — Cymbal, behavioural model (manual p.6, schematic p.13 "CYMBAL").
//
// A cheap stand-in for voices/cy-circuit.js, fitted to its output
// (test/fit.mjs). Same three-part structure as the circuit:
//  * the six metal squares are split by the two IC3 bridged-T band-passes
//    (~7 kHz high, ~3.4 kHz low)
//  * three swing VCAs (Fig. 12): Q16 on the high band with a short envelope
//    (C38), Q17 on the high band with the long, DECAY-controlled envelope
//    (C40 + the Q20 tail from C41 / VR2), Q18 on the low band, fed from the
//    same tail. Each envelope store charges through its diode and resistor,
//    so the hit swells in over a few ms
//  * the IC5 high-passes on the high side and the Q25 high-pass on the low
//    side; VR4 (TONE) cross-fades the high and low sides into IC6
import { Voice, BridgedT, Biquad, OnePole, swingVCA, map3, rail, decayCoef, lerp, clamp } from '../dsp/core.js';
import { voicingTrigger } from './cb-circuit.js';

export const meta = { id: 'cy', name: 'Cymbal', short: 'CY' };

// Fitted to the circuit model (node test/fit.mjs cy ...).
export const FIT = {
  hiF: 8090, hiQ: 9.979, loF: 2918, loQ: 1.598,  // IC3 bands
  vca: 69.96,                               // swing VCA gain
  att: 0.002551,                            // envelope charge time constant, s
  dA: 0.1517, d0: 0.2662, d5: 0.7431, d1: 1.12, dL: 0.3559, // Q16 / Q17 at DECAY 0, mid, max / Q18
  eA: 0.2932, eB: 0.1548, eL: 0.4239,             // envelope volts per trigger volt
  gB: 0.9679,                               // Q17 path gain relative to Q16
  hpH: 13070, hpL: 4791,                  // IC5 / Q25 high-passes
  hi0: 0.9695, hi1: 0.7736, lo0: 1.777, lo1: 2.133, // VR4: band gains at TONE 0 / max
  lp: 7257, g: 0.3848,
};

export class CY extends Voice {
  constructor(sr, metal) {
    super(sr, [
      { id: 'level', name: 'Level', def: 0.8 },
      { id: 'tone', name: 'Tone', def: 0.5 },
      { id: 'decay', name: 'Decay', def: 0.5 },
    ]);
    this.metal = metal;
    this.vppNormal = 3.5; this.vppAccent = 7;
    const F = FIT;
    this.bHi = new BridgedT(sr); this.bHi.set(F.hiF, F.hiQ);
    this.bLo = new BridgedT(sr); this.bLo.set(F.loF, F.loQ);
    this.hpA = new Biquad(sr, 'hp', F.hpH, 0.7);
    this.hpB = new Biquad(sr, 'hp', F.hpH, 0.7);
    this.hpL = new Biquad(sr, 'hp', F.hpL, 0.97);
    this.lp = new OnePole(sr, F.lp, 'lp');
    this.aK = decayCoef(F.att, sr);
    this.kA = decayCoef(F.dA, sr);
    this.cA = this.cB = this.cL = 0; this.vA = this.vB = this.vL = 0;
    this.onParam();
  }
  onParam() {
    const F = FIT, t = clamp(this.p.tone, 0, 1);
    const dB = map3(this.p.decay, F.d0, F.d5, F.d1);
    this.kB = decayCoef(dB, this.sr);
    this.kL = decayCoef(F.dL * dB / F.d5, this.sr); // Q18 hangs off the same Q20 tail
    this.gHi = lerp(F.hi0, F.hi1, t); this.gLo = lerp(F.lo0, F.lo1, t);
  }
  trigger(accent = 0) {
    const F = FIT, v = voicingTrigger(accent) * lerp(this.trimN, this.trimA, clamp(accent, 0, 1));
    this.cA = v * F.eA; this.cB = v * F.eB; this.cL = v * F.eL;
  }
  render(out, n) {
    const F = FIT, lvl = this.levelGain() * F.g, s = this.metal.sum, aK = this.aK, g = F.vca;
    for (let i = 0; i < n; i++) {
      const hi = this.bHi.tick(s[i]), lo = this.bLo.tick(s[i]);
      this.cA *= this.kA; this.cB *= this.kB; this.cL *= this.kL;
      this.vA = this.cA + (this.vA - this.cA) * aK;
      this.vB = this.cB + (this.vB - this.cB) * aK;
      this.vL = this.cL + (this.vL - this.cL) * aK;
      if (this.vB < 1e-5 && this.vL < 1e-5 && this.vA < 1e-5) { this.lp.tick(0); continue; }
      const high = this.hpA.tick(swingVCA(this.vA, hi, g)) + this.hpB.tick(swingVCA(this.vB, hi, g)) * F.gB;
      const low = this.hpL.tick(swingVCA(this.vL, lo, g));
      out[i] += rail(this.lp.tick(high * this.gHi + low * this.gLo)) * lvl;
    }
  }
}
