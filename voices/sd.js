// SD — Snare Drum, behavioural model (manual p.6, schematic p.9 "SNARE DRUM").
//
// A cheap stand-in for voices/sd-circuit.js, fitted to its output
// (test/fit.mjs). Same signal flow, simple blocks:
//  * two damped resonators for the IC14 bridged-T networks, kicked by the
//    1 ms trigger; they follow SD_REVISION (later boards' "PORTION CHANGED"
//    parts, ~173 + 337 Hz, or the original ~250 + 500 Hz)
//  * VR8 (TONE) is the loaded pot between the two, computed as in the
//    circuit: Thevenin source into R204 100k
//  * SNAPPY: the VR9 wiper drives Q47 one Vbe down, so below about 1/10 of
//    the travel there is no noise at all; above it the noise envelope grows
//    with the wiper voltage. The envelope is C51 charged during the trigger,
//    smoothed by R184/C52 (attack) and discharging (decay)
//  * the gated white noise goes through the C66/C67 Sallen-Key high-pass
//    (2.75 kHz, Q 0.73, from the parts) and C69/R205 into the mixer
//  * IC13a's 220p feedback cap is the final low-pass
import { Voice, BridgedT, Pulse, Biquad, OnePole, Noise, rail, clamp, decayCoef, lerp } from '../dsp/core.js';
import { busVoltage } from '../dsp/mna.js';
import { SD_REVISION } from './sd-circuit.js';

export const meta = { id: 'sd', name: 'Snare Drum', short: 'SD' };

// Fitted to the circuit model (node test/fit.mjs sd ...).
export const FIT = {
  fLo: 173.8, qLo: 15.67, fHi: 322, qHi: 10.21,   // revised parts
  fLoO: 249, fHiO: 499,                   // original parts
  kLo: 0.3536, kHi: 0.5941,   // ring amplitude per volt of trigger bus
  nK: 1.161,               // noise per volt of Q47 drive
  nAtt: 0.001383, nDec: 0.02758, // snappy envelope attack / decay time constants, s
  nLp: 5061,             // Q48 collector roll-off, Hz
  outLp: 5175,           // IC13a R210 || VR7 with C70
  drum: 1, snap: 1,      // mixer gains (R204 vs R205 paths)
};

export class SD extends Voice {
  constructor(sr) {
    super(sr, [
      { id: 'level', name: 'Level', def: 0.8 },
      { id: 'tone', name: 'Tone', def: 0.5 },
      { id: 'snappy', name: 'Snappy', def: 0.5 },
    ]);
    this.vppNormal = 3; this.vppAccent = 10;
    const F = FIT, orig = SD_REVISION === 'original';
    this.lo = new BridgedT(sr); this.lo.set(orig ? F.fLoO : F.fLo, F.qLo);
    this.hi = new BridgedT(sr); this.hi.set(orig ? F.fHiO : F.fHi, F.qHi);
    this.pLo = new Pulse(sr); this.pHi = new Pulse(sr);
    this.noise = new Noise(808);
    this.nHp = new Biquad(sr, 'hp', 1 / (2 * Math.PI * 1.8e-9 * Math.sqrt(22e3 * 47e3)), 0.5 * Math.sqrt(47e3 / 22e3));
    this.nHp2 = new OnePole(sr, 1 / (2 * Math.PI * 27e3 * 0.01e-6), 'hp'); // C69 / R205
    this.nLp = new OnePole(sr, F.nLp, 'lp');
    this.out = new OnePole(sr, F.outLp, 'lp');
    this.att = decayCoef(F.nAtt, sr); this.dec = decayCoef(F.nDec, sr);
    this.eC = 0; this.eS = 0;
    this.onParam();
  }
  onParam() {
    // VR8 100k: wiper at the low drum for TONE 0, at the high drum for 1
    const t = clamp(this.p.tone, 0, 1), R = 100e3;
    const ra = Math.max(1, t * R), rb = Math.max(1, R - ra); // ra: A1 (low) to wiper
    const load = 100e3 / ((ra * rb) / R + 100e3);
    this.gLo = (rb / R) * load; this.gHi = (ra / R) * load;
  }
  trigger(accent = 0) {
    const F = FIT, vb = busVoltage(accent), a = lerp(this.trimN, this.trimA, clamp(accent, 0, 1));
    this.pLo.fire(this.lo.pulseHeight(vb * F.kLo * a, 1e-3), 1e-3);
    this.pHi.fire(this.hi.pulseHeight(vb * F.kHi * a, 1e-3), 1e-3);
    // Q47 emitter: wiper volts minus a Vbe
    const s = clamp(this.p.snappy, 0, 1), drive = Math.max(0, vb * (1e3 + 10e3 * s) / 11e3 - 0.6);
    this.eC = drive * F.nK * a; // C51 charge
  }
  render(out, n) {
    const F = FIT, lvl = this.levelGain(), gLo = this.gLo * F.drum, gHi = this.gHi * F.drum;
    const att = this.att, dec = this.dec;
    for (let i = 0; i < n; i++) {
      const drum = gLo * this.lo.tick(this.pLo.tick()) + gHi * this.hi.tick(this.pHi.tick());
      this.eC *= dec;                       // C51 discharging
      this.eS = this.eC + (this.eS - this.eC) * att; // R184/C52 smoothing
      let y = drum;
      if (this.eS > 1e-5 || this.eC > 1e-5) {
        const nz = this.nLp.tick(this.noise.white() * this.eS);
        y += this.nHp2.tick(this.nHp.tick(nz)) * F.snap;
      }
      out[i] += rail(this.out.tick(y)) * lvl;
    }
  }
}
