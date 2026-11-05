// OH — Open Hi-Hat and CH — Closed Hi-Hat, behavioural model (manual p.6,
// schematic p.13 "OPEN HIHAT" / "CLS'D HIHAT", Q21-Q31).
//
// A cheap stand-in for voices/hats-circuit.js, fitted to its output
// (test/fit.mjs). Both hats take the ~7.1 kHz high band of the six metal
// oscillators (the IC3 bridged-T):
//  * a swing VCA (Fig. 12; Q27 for OH, Q30 for CH): the band signal pulls the
//    collector down, but never below the envelope's floor, so the output is
//    the signal chopped by the envelope. With a finite gain the chopping only
//    starts once the envelope has fallen below the signal swing, which gives
//    the hats their fast-then-faster decay
//  * the Sallen-Key high-pass after it (Q26 / Q31, from the parts) and the
//    IC7 mixer's 220p roll-off
//  * OH envelope: C62 charges through R137 (a soft onset) and leaks slowly
//    through R139; when C60 has charged through VR3 (DECAY), Q22 turns on and
//    dumps C62, so the decay knob mostly sets when the hat is cut off.
//    CH chokes OH through Q23 the same way
//  * CH envelope: C63 charged by the hit, discharging into the VCA
import { Voice, BridgedT, Biquad, OnePole, swingVCA, map3, rail, decayCoef, lerp, clamp } from '../dsp/core.js';
import { voicingTrigger } from './cb-circuit.js';

const HI = BridgedT.fromParts(560, 82e3, 0.0033e-6, 0.0033e-6);
const skHP = (R1, R2, C) => ({ f: 1 / (2 * Math.PI * Math.sqrt(R1 * R2) * C), q: 0.5 * Math.sqrt(R2 / R1) });

// Fitted to the circuit model (node test/fit.mjs oh|ch ...).
export const FIT = {
  oh: { bpF: 6272, bpQ: 5.964, vca: 62.45, e: 0.3606, att: 0.01407, dec: 0.1673, cut0: 0.03134, cut5: 0.387, cut1: 0.6413, dump: 0.009703, hpQ: 2.415, lp: 5666, g: 1.651 },
  ch: { bpF: 6216, bpQ: 1.711, vca: 36.74, e: 0.4087, att: 0.001188, dec: 0.01424, hpQ: 2.35, lp: 12340, g: 1.393 },
};

class Hat extends Voice {
  constructor(sr, metal, spec, key, hp) {
    super(sr, spec);
    this.metal = metal; this.key = key; const F = FIT[key];
    this.bp = new BridgedT(sr); this.bp.set(F.bpF, F.bpQ);
    this.hp = new Biquad(sr, 'hp', hp.f, F.hpQ);
    this.lp = new OnePole(sr, F.lp, 'lp');
    this.aK = decayCoef(F.att, sr); this.dK = decayCoef(F.dec, sr);
    this.eC = 0; this.e = 0; this.t = 1e9; this.cutN = 1e12; this.cutK = 1;
  }
  fire(accent) {
    const F = FIT[this.key];
    this.eC = voicingTrigger(accent) * lerp(this.trimN, this.trimA, clamp(accent, 0, 1)) * F.e;
    this.t = 0; this.dK = decayCoef(F.dec, this.sr); this.cutK = 1;
  }
  render(out, n) {
    const F = FIT[this.key], lvl = this.levelGain() * F.g, s = this.metal.sum;
    for (let i = 0; i < n; i++) {
      if (this.t++ === this.cutN) this.dK = this.cutK;
      this.eC *= this.dK;                              // the envelope cap
      this.e = this.eC + (this.e - this.eC) * this.aK; // charging / follower lag
      const b = this.bp.tick(s[i]);                    // IC3 keeps running
      if (this.e < 1e-5 && this.eC < 1e-5) { this.lp.tick(0); continue; }
      const v = swingVCA(this.e, b, F.vca);
      out[i] += rail(this.lp.tick(this.hp.tick(v))) * lvl;
    }
  }
}

export class OH extends Hat {
  constructor(sr, metal) {
    super(sr, metal, [
      { id: 'level', name: 'Level', def: 0.8 },
      { id: 'decay', name: 'Decay', def: 0.5 },
    ], 'oh', skHP(2.7e3, 68e3, 1.5e-9));
    this.vppNormal = 3.5; this.vppAccent = 7;
  }
  trigger(accent = 0) {
    const F = FIT.oh;
    this.fire(accent);
    this.cutN = Math.round(map3(this.p.decay, F.cut0, F.cut5, F.cut1) * this.sr);
    this.cutK = decayCoef(F.dump, this.sr);
  }
  choke() { this.dK = decayCoef(FIT.oh.dump, this.sr); this.cutN = 1e12; } // Q23 dumps C62
}
OH.meta = { id: 'oh', name: 'Open Hi-Hat', short: 'OH' };

export class CH extends Hat {
  constructor(sr, metal) {
    super(sr, metal, [{ id: 'level', name: 'Level', def: 0.8 }], 'ch', skHP(2.7e3, 68e3, 1e-9));
    this.vppNormal = 3; this.vppAccent = 6;
  }
  trigger(accent = 0) { this.fire(accent); }
}
CH.meta = { id: 'ch', name: 'Closed Hi-Hat', short: 'CH' };
