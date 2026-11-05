// CL — Claves, behavioural model (manual p.6 "RS/CL", schematic p.9).
//
// A cheap stand-in for the CL half of voices/rscl-circuit.js, fitted to its
// output (test/fit.mjs). In CL mode R313 turns IC20 into a very high-Q
// bridged-T (~2.5 kHz) that would ring for ~200 ms; the decay you hear is the
// Q74 FET mute closing as Q61's timer (C113 / R305) runs out. Q74's
// on-resistance leaves a faint residue of the ring under the mute, and the
// FET's gate swing leaks through as a soft thump as it closes.
import { Voice, BridgedT, Pulse, OnePole, rail, decayCoef, qFromDecay, lerp, clamp } from '../dsp/core.js';
import { busVoltage } from '../dsp/mna.js';

export const meta = { id: 'cl', name: 'Claves', short: 'CL' };

// Fitted to the circuit model (node test/fit.mjs cl ...).
export const FIT = {
  f: 2476, ring: 0.5219,  // resonator pitch, Hz, and ring time to 1/10, s
  k: 0.3709,              // kick per volt of trigger bus
  mute: 0.02085, muteTau: 0.001084, floor: 0.007156, // Q74: release time, fall time, residue
  thA: 0.08642, thW: 0.003852, // gate thump: volts per bus volt, width, s
};

export class CL extends Voice {
  constructor(sr) {
    super(sr, [{ id: 'level', name: 'Level', def: 0.8 }]);
    this.vppNormal = 2.5; this.vppAccent = 8;
    const F = FIT;
    this.res = new BridgedT(sr); this.res.set(F.f, qFromDecay(F.f, F.ring));
    this.pulse = new Pulse(sr);
    this.th = new OnePole(sr, 1 / (2 * Math.PI * F.thW), 'lp'); this.thN = Math.round(F.thW * sr); this.vb = 0;
    this.mK = decayCoef(F.muteTau, sr); this.m = 0; this.t = 1e9; this.muteN = Math.round(F.mute * sr);
  }
  trigger(accent = 0) {
    const F = FIT, vb = busVoltage(accent) * lerp(this.trimN, this.trimA, clamp(accent, 0, 1));
    this.pulse.fire(this.res.pulseHeight(vb * F.k, 0.2e-3), 0.2e-3);
    this.m = 1; this.t = 0; this.vb = vb;
  }
  render(out, n) {
    const F = FIT, lvl = this.levelGain(), fl = F.floor;
    for (let i = 0; i < n; i++) {
      const t = this.t++;
      if (t > this.muteN) this.m *= this.mK;
      const th = this.th.tick(t > this.muteN && t < this.muteN + this.thN ? this.vb * F.thA : 0);
      out[i] += rail(this.res.tick(this.pulse.tick()) * (fl + (1 - fl) * this.m) + th) * lvl;
    }
  }
}
