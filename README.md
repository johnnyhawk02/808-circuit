# TR-808 voice prototypes (JavaScript)

Each TR-808 voice circuit from the 1981 service notes, rebuilt as plain JS DSP
that runs in an AudioWorklet (with a ScriptProcessor fallback) or in Node.

## Layout

Every voice exists twice: a behavioural model (`voices/<id>.js`, light,
calibrated to the manual) and a component-level circuit model
(`voices/<id>-circuit.js`) that solves the schematic every sample.

```
index.html            test bench: pads, knobs, Circuit/Behavioural switch per card,
                      16-step pattern, scope, DSP load readout
app.js                UI + audio host
worklet.js            AudioWorkletProcessor wrapping the kit; reports DSP load
dsp/kit.js            both models of all 16 voices, sample-accurate trigger queue,
                      per-voice model switch (setModel / setAllModels), OH choke
dsp/mna.js            circuit simulator: modified nodal analysis, trapezoidal caps
                      (backward Euler where stiff), Newton on diodes / Ebers-Moll BJTs
                      only (Woodbury update on a pre-factored linear network),
                      single-pole saturating op-amps (uPC4558: 3 MHz GBW), switched-off
                      junctions dropped from the Newton set until they wake up
dsp/noise.js          shared noise source + IC24b pink filter, as a circuit
dsp/metal-circuit.js  the six 40106 oscillators (from their RC parts) + IC3 band split
voices/circuit-voice.js  base class: stages, links between stages, trigger switch, sleep
voices/circuits.js    registry of the 16 circuit voices
voices/bd-circuit.js  BD    Q40-Q43, IC12, D52/D53
voices/sd-circuit.js  SD    two bridged-Ts, snappy envelope, Q48 noise VCA, Q49 HP, IC13a
voices/tom-circuit.js LT MT HT LC MC HC  (part tables per voice, SW8-SW10)
voices/rscl-circuit.js RS / CL  IC20/IC21, Q61 mute timer, Q62 VCA, Q63 HP, Q74 FET mute
voices/cpma-circuit.js CP / MA  IC21 band-pass, IC23 comparators + sawtooth, Q71/Q72 + BA662
                      OTA VCA, Q70 reverb tail; MA noise gate Q65, Q68 HP
voices/cb-circuit.js  CB    Q14/Q15, IC2b band-pass; voicing-board trigger buffer IC2a
voices/cy-circuit.js  CY    Q19/Q20 envelopes, Q16/Q17/Q18 VCAs, IC5 high-passes, VR4, IC6
voices/hats-circuit.js OH / CH  Q21-Q31, choke via R173/Q23, IC7
dsp/core.js, dsp/metal.js, voices/*.js   the behavioural models
dsp/calibration.js    output trims for the behavioural models
test/measure.mjs      both models vs the manual's voice-check table; writes renders/
test/circuit-check.mjs one circuit voice: Vpp, peaks, decay, CPU
test/bd-compare.mjs   BD decay sweep, both models
test/cpu.mjs          real-time cost of a busy pattern (circuit or behavioural)
```

## Voice API

```js
const v = new BD(sampleRate, metalBank); // metalBank only used by CB/CY/OH/CH
v.set('decay', 0.7);                     // all params are 0..1 (12 o'clock = 0.5)
v.trigger(accent);                       // 0 = normal, 1 = full accent
v.render(float32Array, n);               // adds n samples, in volts
```

Signals are kept in volts so the manual's Vpp figures apply directly; the kit
scales to digital at the end (12 V peak ≈ -6 dBFS).

## Checking against the manual

`node test/measure.mjs` renders every voice the way the manual's CHECKING
VOICES procedure does (p.14: level full, other knobs at 12 o'clock), prints
Vpp / pitch / decay for the circuit model, the behavioural model and the
manual side by side, and writes `renders/<id>-circuit.wav` and
`renders/<id>-behavioural.wav` (normal hit, then accent hit).

`node test/measure.mjs --calibrate` re-solves `dsp/calibration.js` after you
change a voice's internals, so the normal and accent levels keep matching the
table.

Current result: every voice lands on its Vpp; pitches are within ~5% (the
toms read slightly sharp because the diode pitch sag is included); decays are
within ~20% except SD, which reads 82 ms against 60 ms because the snappy noise
tail is counted.

## Where the manual didn't give a number (behavioural models)

- The four non-cowbell metal oscillator frequencies are derived from their RC
  parts (R40-R43, C1-C4) with one constant calibrated on the cowbell pair.
- CP band-pass (IC21) values are partly off the scan: modelled at ~1 kHz.
- The clap's accent figure in the table reads 2 Vpp, which looks like a typo;
  accent is treated like the other voices (10 Vpp).
- Envelope time constants that aren't readable from the schematic were set to
  hit the table's decay times.

Hosting: `.github/workflows/pages.yml` publishes the bench to GitHub Pages
(https://johnnyhawk02.github.io/tr808/) on every push to `main`. One-time
setup: Settings > Pages > Source: "GitHub Actions".

Running locally: any static server, e.g. `python3 -m http.server`, then open
`index.html` (module scripts and worklets don't load from `file://`).

## Component-level models

Each circuit voice is built from the schematic's part list (header comments
name every part). Nothing about the sound is scripted: pitch glides, double
hits, clap teeth, chokes and accents come out of the network. Large voices are
split into stages at low-impedance points (op-amp outputs, emitter followers)
so each solve stays small. Only the trigger-bus voltages (5 V normal / 15 V
accent minus the switch drop, re-buffered by IC2a on the voicing board) are
taken from the main-board accent circuit rather than solved.

`node test/measure.mjs` (level full, other knobs at 12 o'clock):

| voice | Vpp normal / accent | pitch Hz | decay to 1/10 | manual |
|---|---|---|---|---|
| BD | 3.9 / 11.7 | 59 falling to 49 | 298 ms | 3.5 / 10, 56 Hz, 300 ms |
| SD | 3.7 / 13.5 | 173 + 337 (revised parts; 250 + 496 original) | 62 ms | 3 / 10, 238 + 476 Hz, 60 ms |
| LT | 2.4 / 12.2 | 87 | 190 ms | 3.5 / 12, 90 Hz, 200 ms |
| MT | 2.4 / 12.6 | 134 | 128 ms | 3 / 11, 135 Hz, 130 ms |
| HT | 2.7 / 13.9 | 182 | 100 ms | 3.5 / 12, 185 Hz, 100 ms |
| LC | 3.2 / 11.0 | 192 | 186 ms | 3.5 / 12, 185 Hz, 180 ms |
| MC | 2.0 / 7.2 | 275 | 98 ms | 3 / 10, 280 Hz, 100 ms |
| HC | 3.4 / 10.4 | 403 | 90 ms | 3.5 / 12, 400 Hz, 80 ms |
| RS | 2.8 / 10.7 | 459 + 1763 | 10 ms | 3 / 10, 455 + 1667 Hz, 10 ms |
| CL | 3.2 / 9.9 | 2475 | 26 ms | 2.5 / 8, 2500 Hz, 25 ms |
| CP | 5.8 / 9.0 | noise | 112 ms | 6 / -, 100 ms |
| MA | 4.2 / 4.9 | noise | 28 ms | 3 / 5, 30 ms |
| CB | 3.8 / 7.6 | 547 + 809 | 110 ms | 3.5 / 12, 540 + 800 Hz, 50 ms |
| CY | 3.0 / 7.0 | metal | 454 ms | 3.5 / 7, 800 ms |
| OH | 5.3 / 9.2 | metal | 386 ms | 3.5 / 7, 450 ms |
| CH | 3.0 / 4.9 | metal | 42 ms | 3 / 6, 50 ms |

Good: every pitch the manual gives (BD aside) lands within ~4% from part values
alone, and the BD, tom/conga and OH decays are within ~10%.

Known misses (2026-11-04, after adding R53, the 1k load on the metal bus that
had been left out): OH runs ~1.5x hot and CY's normal hit decays in ~450 ms
against 800; CB rings longer than the table says (CB checked 2026-11-04 against Werner et al., "More Cowbell",
AES 2014: the circuit itself gives the longer two-stage decay and the 2x
accent); CP's bursts come ~13 ms apart (R365 82k / C144 .47u) where the
manual's Fig. 13 sketch shows ~11 ms; BD settles 12% flat.

SD uses the schematic's "PORTION CHANGED" values (C58 .056u, C61 .015u, R191
10k, R200 shorted) by default; set `SD_REVISION = 'original'` in
voices/sd-circuit.js for the values the voice-check table was measured on.
C54 sits from Q48's collector to ground (it was across R188 before
2026-11-04, which stretched the snappy tail to 144 ms).

Assumed where the scan is unreadable: C140 .027u (CP), R324 180k (RS, set
to meet the table; Q62's base and collector were swapped before 2026-11-04), Q74
as a 2SK30A with Vp -3.5 V and 875 R (set so the claves, whose tail Q74
mutes, meet the table's 25 ms), the CP trim TM3 wiper at 0.61 (set by the manual's TM3 adjustment: 6 Vpp
bursts dropping to ~0.5 Vpp between them), Q18's bias
parts (CY) copied from Q16, the BA662 bias pin.

Cost (Node, one core, 48 kHz): a single voice is 2-50% of a core; the bench's
demo pattern needs about 110-130% and a hit on all 16 voices every bar about
170-190% (measured on this cloud machine; a fast desktop may manage it). The
page shows the DSP load and suggests switching the heaviest voices (CY, MA, CP,
SD, CB) to Behavioural. The behavioural kit uses about 14%. Circuit voices
sleep 0.2 s after their output goes quiet.
