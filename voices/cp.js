// CP — Hand Clap, behavioural model (manual p.6 "CP/MA" + Fig. 13, schematic p.9).
//
// A cheap stand-in for the CP half of voices/cpma-circuit.js, fitted to its
// output (test/fit.mjs). Same signal flow, simple blocks:
//  * white noise through the IC21 band-pass (~1.2 kHz)
//  * the clap: the BA662 OTA multiplies the noise by an exponential of the
//    C144 sawtooth. Inside the ~30 ms comparator window C144 is charged and
//    dumped repeatedly (teeth every `tooth` s); when the window closes it is
//    dumped once more and that last ramp decays slowly. The OTA's tanh input
//    stage clips the noise a little, which brightens it
//  * the "reverb": Q70 amplifies the same noise under a slower envelope
//    (C139/C138), with the C146 roll-off on its collector
//  * a little of the sawtooth itself leaks into the mix as a low thump
import { Voice, Biquad, OnePole, Noise, rail, decayCoef, lerp, clamp } from '../dsp/core.js';

export const meta = { id: 'cp', name: 'Hand Clap', short: 'CP' };

// Fitted to the circuit model (node test/fit.mjs cp ...).
export const FIT = {
  bpF: 1411, bpQ: 1.796,           // IC21 band-pass
  drive: 1.581,                    // OTA input clipping
  tooth: 0.0114, win: 0.02752,      // tooth period and comparator window, s
  tTau: 0.01113, lTau: 0.04079,       // C144 decay inside the window / last ramp
  expK: 1.176,                       // Q71/Q72 exponential converter steepness
  clap: 1.86,                       // clap level, V
  vA: 0.1426, vAtt: 0.03658, vDec: 0.394, vLp: 984.1, // reverb level, attack, decay, C146 roll-off
  thump: 0.142,                    // sawtooth leak
};

export class CP extends Voice {
  constructor(sr) {
    super(sr, [{ id: 'level', name: 'Level', def: 0.8 }]);
    this.vppNormal = 6; this.vppAccent = 10;
    const F = FIT;
    this.noise = new Noise(1981);
    this.bp = new Biquad(sr, 'bp', F.bpF, F.bpQ);
    this.vLp = new OnePole(sr, F.vLp, 'lp');
    this.thHp = new OnePole(sr, 20, 'hp');
    this.fast = decayCoef(F.tTau, sr); this.slow = decayCoef(F.lTau, sr);
    this.vAk = decayCoef(F.vAtt, sr); this.vDk = decayCoef(F.vDec, sr);
    this.toothN = Math.max(1, Math.round(F.tooth * sr)); this.winN = Math.round(F.win * sr);
    this.ek = Math.exp(F.expK) - 1;
    this.saw = 0; this.t = 1e9; this.a = 0; this.vC = 0; this.vS = 0;
  }
  trigger(accent = 0) {
    this.a = lerp(this.trimN, this.trimA, clamp(accent, 0, 1));
    this.saw = 1; this.t = 0;
    this.vC = this.a;
  }
  render(out, n) {
    const F = FIT, lvl = this.levelGain(), a = this.a, K = F.expK, ek = this.ek;
    for (let i = 0; i < n; i++) {
      const t = this.t++;
      if (t < this.winN) { this.saw *= this.fast; if (t > 0 && t % this.toothN === 0) this.saw = 1; }
      else { if (t === this.winN) this.saw = 1; this.saw *= this.slow; }
      const g = (Math.exp(K * this.saw) - 1) / ek;
      // reverb envelope: C139 charged by the hit, C138 follows it
      this.vC *= this.vDk; this.vS = this.vC + (this.vS - this.vC) * this.vAk;
      const nz = this.bp.tick(this.noise.white());
      if (g < 1e-5 && this.vS < 1e-5) { this.thHp.tick(0); continue; }
      const clap = Math.tanh(nz * F.drive) * g * a * F.clap;
      const verb = this.vLp.tick(nz * this.vS * F.vA);
      out[i] += rail(clap + verb + this.thHp.tick(this.saw * a * F.thump)) * lvl;
    }
  }
}
