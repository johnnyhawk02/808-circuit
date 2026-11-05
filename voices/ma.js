// MA — Maracas, behavioural model (manual p.6, schematic p.9 "HAND CLAP / MARACAS").
//
// A cheap stand-in for the MA half of voices/cpma-circuit.js, fitted to its
// output (test/fit.mjs). White noise is gated by Q65: the trigger charges
// C135, Q67 then drags C134 down slowly through R341 (the soft opening), and
// when C135 has run down Q67 lets go and D66 snaps C134 back, so the gate
// shuts abruptly. The gated noise goes through C131/R338 (1.1 kHz) and the
// C132/C133 Sallen-Key high-pass around Q68 (10.6 kHz, Q 2.3, from the
// parts), then the IC19 mixer's 220p roll-off.
import { Voice, Biquad, OnePole, Noise, rail, decayCoef, lerp, clamp } from '../dsp/core.js';

export const meta = { id: 'ma', name: 'Maracas', short: 'MA' };

// Fitted to the circuit model (node test/fit.mjs ma ...).
export const FIT = {
  att: 0.008826,   // opening time constant, s
  hold: 0.03243,  // how long the gate stays open, s
  rel: 0.002088,   // D66 snap-shut time constant, s
  g: 2.087,       // level, V
  hpF: 9753, hpQ: 1.675, lp: 4928,
};

export class MA extends Voice {
  constructor(sr) {
    super(sr, [{ id: 'level', name: 'Level', def: 0.8 }]);
    this.vppNormal = 3; this.vppAccent = 5;
    const F = FIT;
    this.noise = new Noise(4242);
    this.hp1 = new OnePole(sr, 1 / (2 * Math.PI * 15e3 * 0.01e-6), 'hp');
    this.hp = new Biquad(sr, 'hp', F.hpF, F.hpQ);
    this.lp = new OnePole(sr, F.lp, 'lp');
    this.aK = decayCoef(F.att, sr); this.rK = decayCoef(F.rel, sr);
    this.holdN = Math.round(F.hold * sr);
    this.e = 0; this.t = 1e9; this.a = 0;
  }
  trigger(accent = 0) { this.a = lerp(this.trimN, this.trimA, clamp(accent, 0, 1)); this.t = 0; }
  render(out, n) {
    const F = FIT, lvl = this.levelGain() * F.g;
    for (let i = 0; i < n; i++) {
      const t = this.t++;
      this.e = t < this.holdN ? this.a + (this.e - this.a) * this.aK : this.e * this.rK;
      if (this.e < 1e-5 && t > this.holdN) { this.lp.tick(0); continue; }
      const y = this.lp.tick(this.hp.tick(this.hp1.tick(this.noise.white() * this.e)));
      out[i] += rail(y) * lvl;
    }
  }
}
