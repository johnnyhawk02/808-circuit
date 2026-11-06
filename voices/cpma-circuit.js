// CP / MA — Hand Clap and Maracas, component-level (schematic p.9 "HAND
// CLAP / MARACAS"). One board, SW12 picks which line the trigger reaches;
// both voices share the IC19 mixer and the CP/MA LEVEL pot.
//
// CP
//  Noise band-pass: W.N. -> R332 27k || C127 .0018u -> (R333 10k) -> IC21
//    multiple-feedback band-pass, C128/C129 .0047u, R334 100k (~1.2 kHz).
//  Control (comparators of IC23, AN6912 = LM339 type, open collector to
//    -15 V; ladder R353/R352/R351 4.7k gives -5 V and -10 V):
//    CP line idles at -15 V through R360 27k / R361 22k; the trigger lifts
//    the divider above -10 V, so comparator 3 pulls OC low. OC recovers
//    through R350 1M / C140. While OC is below -5 V comparator 2 holds OB
//    low: the clap "window". In the window comparator 4 lets R365 82k
//    charge the C144 .47u sawtooth through D71; comparator 1 compares SAW
//    with the window level (R355 2.7k / R354 5.6k) and fires Q73, which dumps
//    SAW to -15 V: one clap per ramp. C141 / D70 / R357 dump it once more at
//    the end of the window, and that last ramp decays slowly (R368 + R371).
//  Q72/Q71 (PNP pair, R366 15k tail from +15 V) turn SAW (through R368 470k
//    / R371 15k) into the control current of the BA662 OTA (IC22, R374 10k).
//    The OTA multiplies the band-passed noise (C136 .022u, R372 39k / R382 1k)
//    and its buffer feeds C150 .001u / R378 100k into the mixer.
//  Reverb: Q70 amplifies the band-passed noise (R342 15k / R346 680, C137
//    .033u) with a slower envelope from Q69 / D69 / C139 / R348 / C138 / R349;
//    collector R363 10k, C146 .018u, out through C152 .0047u / R376 47k.
//  Mixer IC19: R375 470k, C149 220p, VR17 (LEVEL, 100k A) + C145 33u.
// MA
//  MA line -> D67 -> C135 .1u / R345 150k -> R344 220k -> Q67. Q67 drags
//  C134 .033u down through R341 470k (slow opening), D66 snaps it back when
//  Q67 lets go. Q66 (PNP follower) then lets Q65 — a PNP stage whose base the
//  W.N. bus drives through R335 6.8k / C130 .047u — pass current through D65.
//  High-pass C131 .01u / R338 15k, then the C132/C133 .001u, R339 3.3k,
//  R340 68k Sallen-Key around Q68 (R347 22k to -15 V), C151 .01u, R377 100k.
//
// Readings / assumptions. The schematic is read part by part, but the values
// in CP_PARTS below are set against the real TR-808 recording (cache/808/CP;
// test/cp-fit.mjs, score = test/vs808.mjs's distance plus the depth of the
// gaps between the claps), in five rounds on 2026-11-06:
//  * R200 10k, Q70 emitter to -15 V: from the schematic's "PORTION CHANGED"
//    note (p.9), not a fit. It biases the reverb transistor on.
//  * C144 .37u (printed .47/50, an electrolytic): the clap spacing, 11.5 ms
//    as on the recording.
//  * C140 .021u (printed .0027u; the manual's text gives a ~30 ms window,
//    which needs ~.02u): where the fourth clap lands.
//  * TM3 (C.P. OFFSET) 0.706, a trimmer taken as a 10k pot from gnd to
//    -15 V. Above the manual's p.14 setting (0.61, 6 Vpp bursts), where the
//    Q71/Q72 pair sits flat out at each dump and the claps run together.
//  * Q71/Q72 beta 400 (2SA733P: 200-400): the pair's base current shrinks
//    the sawtooth's swing at Q72 less, so the claps die away faster.
//  * C138 .07u / C139 .0163u (printed .047u / .018u): the reverb envelope
//    rises more slowly, so it doesn't fill the gaps between the claps.
//  * IC21: C128 = C129 5.8n (printed .0047u) puts the band-pass at ~1 kHz,
//    as on the recording; C127 1.24n (printed .0018u) trims its high shelf.
//  * C150 2.7n (printed .001u): less of the clap path's 1.6 kHz high-pass.
// Of these, C138, C128/C129 and C150 are outside usual tolerances: they are
// what the recording asks for, not readings.
// The BA662's bias pin sits two diodes above -15 V.
import { CircuitVoice, aTaper } from './circuit-voice.js';

const VT = 0.02585;

// Part values that are not plain readings of the schematic (see notes above).
export const CP_PARTS = { C144: 0.37e-6, C140: 0.021e-6, R200: 10e3, TM3: 0.706, C127: 1.24e-9, C128: 5.8e-9, C138: 0.07e-6, C139: 0.0163e-6, C150: 2.7e-9, BF72: 400 };

function mixer(v, m, level) {
  m.OpAmp('gnd', 'S', 'OUT');
  m.R('S', 'OUT', 470e3); m.C('S', 'OUT', 220e-12);           // R375, C149
  v.vr17 = m.R('S', 'NV', 100e3); m.C('NV', 'OUT', 33e-6);    // VR17, C145
  v.iOut = m.idx.OUT; v.mix = m;
}

export class CPCircuit extends CircuitVoice {
  constructor(sr, shared) {
    super(sr, [{ id: 'level', name: 'Level', def: 0.8 }], shared);
    // C.P. OFFSET trimmer TM3 (see CP_PARTS)
    this.tm3 = CP_PARTS.TM3;
    const wn = this.shared.noise;
    // ---- S1: noise band-pass IC21
    const f = (this.s1 = this.stage(['WNc', 'L', 'Nm', 'B']));
    this.feed(f, 'WNc', 1, (i) => wn.wn[i]);
    f.R('WNc', 'L', 27e3); f.C('WNc', 'L', CP_PARTS.C127); f.R('L', 'gnd', 10e3); // R332, C127, R333
    f.C('L', 'Nm', CP_PARTS.C128); f.C('L', 'B', CP_PARTS.C128); f.R('Nm', 'B', 100e3); // C128, C129, R334
    f.OpAmp('gnd', 'Nm', 'B');
    // ---- S2: CP line and envelopes
    const e = (this.s2 = this.stage(['CP', 'TH', 'P15', 'E69', 'N139', 'N138', 'N143']));
    this.addTrigger(e, 'CP');
    e.R('CP', 'TH', 27e3); e.Rsrc('TH', 22e3, -15);              // R360, R361
    this.rail(e, 'P15', 15);
    e.NPN('CP', 'P15', 'E69');                                   // Q69
    e.D('E69', 'N139'); e.C('N139', 'gnd', CP_PARTS.C139);            // D69, C139
    e.R('N139', 'N138', 1e6); e.C('N138', 'gnd', CP_PARTS.C138); // R348, C138
    e.D('E69', 'N143'); e.C('N143', 'gnd', 1e-6);                // D68, C143
    // ---- S3: comparators, sawtooth and the exponential pair
    const c = (this.s3 = this.stage(['OC', 'OB', 'Dm', 'OA', 'SAW', 'Dp', 'OD', 'N141', 'B73', 'C73', 'M15']));
    this.rail(c, 'M15', -15);
    c.R('OC', 'gnd', 1e6); c.C('OC', 'gnd', CP_PARTS.C140);           // R350, C140
    c.R('OB', 'Dm', 2.7e3); c.R('Dm', 'gnd', 5.6e3);             // R355, R354
    c.R('OA', 'gnd', 82e3); c.D('OA', 'SAW');                    // R365, D71
    c.C('SAW', 'gnd', CP_PARTS.C144);                                  // C144
    c.R('SAW', 'Dp', 1e6); c.C('OD', 'Dp', 220e-12);             // R356, C142
    c.R('OD', 'gnd', 10e3); c.R('OD', 'B73', 68e3);              // R359, R358
    c.C('OB', 'N141', 0.001e-6); c.D('M15', 'N141'); c.R('N141', 'B73', 68e3); // C141, D70, R357
    c.NPN('B73', 'C73', 'M15'); c.R('C73', 'SAW', 330);          // Q73, R367
    // the exponential pair in its own small stage (SAW, on .47u, drives it
    // through 470k; R362 330k links it to C143)
    const x = (this.s3x = this.stage(['B72', 'B71', 'EE', 'IA', 'M15']));
    this.rail(x, 'M15', -15);
    this.link(x, 'B72', 470e3, c, 'SAW'); this.link(c, 'SAW', 470e3, x, 'B72'); // R368
    x.R('B72', 'gnd', 15e3);                                     // R371
    x.R('B71', 'gnd', 2.2e3);                                    // R364
    this.feed(e, 'N143', 330e3, () => x.v[x.idx.B71]);           // R362 (both sides)
    this.link(x, 'B71', 330e3, e, 'N143');
    this.tm = x.Rsrc('B71', 47e3, 0);                            // R370 from TM3
    x.Rsrc('EE', 15e3, 15);                                      // R366
    { const q = { Is: 2e-14, bf: CP_PARTS.BF72, br: 3 }; x.PNP('B72', 'IA', 'EE', q); x.PNP('B71', 'M15', 'EE', q); }         // Q72, Q71
    x.Rsrc('IA', 10e3, -15 + 1.2);                               // R374 into the OTA bias pin
    this.cmp = ['OC', 'OB', 'OA', 'OD'].map((n) => c.Dyn(n, null, -15));
    // ---- S4: OTA, Q70 reverb, mixer
    const m = (this.s4 = this.stage(['Bc', 'K136', 'I2', 'O6', 'BUF', 'N150', 'V', 'B70', 'C70', 'E70', 'N152', 'S', 'OUT', 'NV']));
    this.link(m, 'Bc', 1, f, 'B');
    m.C('Bc', 'K136', 0.022e-6); m.R('K136', 'I2', 39e3); m.R('I2', 'gnd', 1e3); // C136, R372, R382
    m.R('O6', 'gnd', 82e3); this.ota = m.Dyn('O6');              // R383, OTA output current
    m.OpAmp('O6', 'BUF', 'BUF');                                 // BA662 buffer
    m.C('BUF', 'N150', CP_PARTS.C150); m.R('N150', 'S', 100e3);       // C150, R378
    this.link(m, 'V', 15e3, f, 'B'); m.R('V', 'gnd', 680);       // R342, R346
    m.C('V', 'B70', 0.033e-6);                                   // C137
    this.link(m, 'B70', 1e6, e, 'N138');                         // R349
    this.feed(e, 'N138', 1e6, () => m.v[m.idx.B70]);
    m.NPN('B70', 'C70', 'E70'); m.R('E70', 'gnd', 330);          // Q70, R369
    if (CP_PARTS.R200) m.Rsrc('E70', CP_PARTS.R200, -15);         // R200 (p.9 "PORTION CHANGED")
    m.Rsrc('C70', 10e3, 15); m.C('C70', 'gnd', 0.018e-6);        // R363, C146
    m.C('C70', 'N152', 0.0047e-6); m.R('N152', 'S', 47e3);       // C152, R376
    mixer(this, m);
    m.tol = 1e-4; f.tol = 1e-4;
    const I = (st, n) => st.idx[n];
    this.ix = { TH: I(e, 'TH'), OC: I(c, 'OC'), OB: I(c, 'OB'), Dm: I(c, 'Dm'), Dp: I(c, 'Dp'), IA: I(x, 'IA'), I2: I(m, 'I2') };
    this.finish(Math.round(sr * 1.2)); // C144 settles through R368 (tau ~0.23 s)
  }
  pre() {
    const x = this.ix, e = this.s2.v, c = this.s3.v, xv = this.s3x.v;
    const on = [e[x.TH] > -10, c[x.OC] < -5, c[x.OB] > -5, c[x.Dp] < c[x.Dm]];
    for (let k = 0; k < 4; k++) this.cmp[k].g = on[k] ? 1 / 100 : 0;
    // BA662: output current = Iabc * tanh((v+ - v-) / 2Vt); v+ is at gnd
    const iabc = Math.max(0, (xv[x.IA] + 13.8) / 10e3);
    this.ota.i = iabc * Math.tanh(-this.s4.v[x.I2] / (2 * VT));
  }
  onParam() {
    if (this.tm) { this.tm.v = -15 * this.tm3; }
    if (this.vr17) { this.vr17.g = 1 / Math.max(1, 100e3 * aTaper(this.p.level)); this.mix.touch(); }
  }
  output() { return this.mix.v[this.iOut]; }
}

export class MACircuit extends CircuitVoice {
  constructor(sr, shared) {
    super(sr, [{ id: 'level', name: 'Level', def: 0.8 }], shared);
    const wn = this.shared.noise;
    // stage 1: select line and gate (Q67, Q66)
    const a = (this.s1 = this.stage(['MA', 'N135', 'B67', 'N67', 'N134', 'E66']));
    this.addTrigger(a, 'MA');
    a.R('MA', 'gnd', 1e6);                                        // line leakage (switch off)
    a.D('MA', 'N135'); a.C('N135', 'gnd', 0.1e-6); a.R('N135', 'gnd', 150e3); // D67, C135, R345
    a.R('N135', 'B67', 220e3); a.NPN('B67', 'N67', 'gnd');        // R344, Q67
    a.Rsrc('N67', 100e3, 15);                                     // R343
    a.R('N67', 'N134', 470e3); a.D('N67', 'N134'); a.C('N134', 'gnd', 0.033e-6); // R341, D66, C134
    a.PNP('N134', 'gnd', 'E66');                                  // Q66
    // stage 2: noise transistor Q65 and the Q68 high-pass; R337 10k joins
    // the two stages (each side sees the other's previous-sample voltage)
    const b = (this.s1b = this.stage(['Z', 'N335', 'B65', 'C65', 'P15', 'F', 'F2', 'B68', 'E68']));
    this.link(b, 'Z', 10e3, a, 'E66'); this.link(a, 'E66', 10e3, b, 'Z'); // R337
    this.rail(b, 'P15', 15);
    this.feed(b, 'N335', 6.8e3, (i) => wn.wn[i]);                 // R335 from W.N.
    b.C('N335', 'B65', 0.047e-6); b.R('B65', 'gnd', 1e6);         // C130, R336
    b.PNP('B65', 'C65', 'P15'); b.D('C65', 'Z');                  // Q65, D65
    b.C('Z', 'F', 0.01e-6); b.R('F', 'gnd', 15e3);                // C131, R338
    b.C('F', 'F2', 0.001e-6); b.C('F2', 'B68', 0.001e-6);         // C132, C133
    b.R('F2', 'E68', 3.3e3); b.R('B68', 'gnd', 68e3);             // R339, R340
    b.NPN('B68', 'P15', 'E68'); b.Rsrc('E68', 22e3, -15);         // Q68, R347
    b.tol = 1e-3; // noise-driven
    const a2 = b;
    const m = (this.s2 = this.stage(['E68c', 'N151', 'S', 'OUT', 'NV']));
    this.link(m, 'E68c', 1, a2, 'E68');
    m.C('E68c', 'N151', 0.01e-6); m.R('N151', 'S', 100e3);        // C151, R377
    mixer(this, m);
    this.finish();
  }
  onParam() {
    if (this.vr17) { this.vr17.g = 1 / Math.max(1, 100e3 * aTaper(this.p.level)); this.mix.touch(); }
  }
  output() { return this.mix.v[this.iOut]; }
}
