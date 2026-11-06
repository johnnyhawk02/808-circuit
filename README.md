# TR-808 voice prototypes (JavaScript)

Each TR-808 voice circuit from the 1981 service notes, rebuilt as plain JS DSP
that runs in an AudioWorklet (with a ScriptProcessor fallback) or in Node.

## Layout

Every voice exists in four versions, and the bench switches between them per card:

- **Circuit**: a component-level model (`voices/<id>-circuit.js`) that solves
  the schematic every sample.
- **Cached**: hits pre-rendered by the circuit model, played back at almost
  no CPU (`dsp/cache.js`, see "Cached circuit hits" below).
- **Synth**: a light model built from a few oscillators, filters and
  envelopes (`voices/<id>.js`), fitted to the circuit model's output (see
  "Synth models" below). Same knobs, about a tenth of the CPU.
- **808**: recordings of a real TR-808 (`cache/808/`, see `cache/808/SOURCE.md`),
  played at the nearest recorded knob setting (`dsp/sampler.js`).

```
index.html            test bench: pads, knobs, Circuit / Cached / Synth / 808 switch per card,
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
dsp/core.js, dsp/metal.js, voices/*.js   the synth (behavioural) models
dsp/calibration.js    generated: synth trims, LEVEL pot law, sample scaling
dsp/sampler.js        808 sample voice; dsp/wav.js reads the WAVs
cache/808/            Michael Fischer's TR-808 recordings (116 WAVs)
test/measure.mjs      both models vs the manual's voice-check table; writes renders/
test/circuit-check.mjs one circuit voice: Vpp, peaks, decay, CPU
test/bd-compare.mjs   BD decay sweep, both models
test/cpu.mjs          real-time cost of a busy pattern (circuit or behavioural)
test/ref-render.mjs   caches circuit renders at every knob end (test/.cache/)
test/match.mjs        synth vs circuit score per voice; test/vs808.mjs vs the recordings
test/fit.mjs          fits a synth voice's FIT constants to the circuit
test/calibrate.mjs    regenerates dsp/calibration.js from the cached renders
test/analyze.mjs, env.mjs, wave.mjs   side-by-side detail for one knob case
test/profile.mjs      circuit kit cost per voice and per stage (Newton passes, rebuilds)
test/regress.mjs      circuit renders vs a saved reference (for solver changes)
test/cache-render.mjs renders the cached circuit hits into cache/
test/cache-check.mjs  cached kit: size, CPU
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

The synth voices are calibrated to the circuit models rather than to the
table (see below), so they land on the circuit's Vpp, not the manual's.

## Synth models

Each synth voice (`voices/<id>.js`) follows its circuit's signal flow with
cheap blocks: state-variable resonators for the bridged-T networks, one-pole
RC envelopes, swing VCAs, biquads computed from the part values where the
circuit has a plain filter. The numbers the parts don't give directly live
in an exported `FIT` object and were fitted to the circuit model:

```
node test/ref-render.mjs all      cache circuit renders (default, accent, every knob at both ends)
node test/fit.mjs bd f0 glide ... --write   Nelder-Mead on the listed FIT keys
node test/calibrate.mjs           output trims, LEVEL pot law, sample scaling
node test/match.mjs               score per voice
```

The score is in dB, lower is better, 0 is identical: level error + mean gap
of the RMS envelope (2 ms hop) + mean gap of a 1/3-octave spectrogram (5 ms
hop) + half the gap of a 1/12-octave spectrum, averaged over the knob cases.
"Floor" is the circuit against itself with the noise source and metal
oscillators in another state, i.e. the best a model of a noisy voice can do.
Roughly: under 5 is very close, 5-10 is the same sound with small
differences, over 15 is clearly different (not yet checked by ear).

| voice | floor | before | synth now |
|---|---|---|---|
| BD | 0 | 11.7 | 5.4 |
| SD | 2.5 | 18.2 | 5.9 |
| LT / MT / HT | 1.9-2.8 | 19.9 / 20.6 / 22.2 | 5.7 / 9.2 / 10.4 |
| LC / MC / HC | 0 | 8.8 / 13.4 / 11.2 | 3.3 / 4.2 / 4.8 |
| RS / CL | 0 | 27.8 / 24.8 | 11.6 / 11.8 |
| CP / MA | 4.7 / 3.5 | 16.9 / 30.6 | 9.3 / 13.2 |
| CB | 1.2 | 26.6 | 7.1 |
| CY | 3.7 | 22.9 | 14.8 |
| OH / CH | 2.9 / 4.6 | 30.3 / 21.9 | 7.8 / 7.3 |

Cost: the whole synth kit is 10-13% of one core in Node (the circuit kit
170-190%). `node test/vs808.mjs` scores both models against the real 808
recordings in `cache/808/`.

Hosting: `.github/workflows/pages.yml` publishes the bench to GitHub Pages
(https://johnnyhawk02.github.io/Tr808/) on every push to `main`. One-time
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
| CP | 3.3 / 8.1 | noise | 74 ms | 6 / -, 100 ms |
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
accent); CP is quieter than the table (3.3 Vpp against 6, see below); BD
settles 12% flat.

CP is set against the real TR-808 recording (2026-11-06, two passes; it
sounded clearly off). As printed, the circuit gave three smeared claps ~13 ms
apart, a brighter sound than the recording and a reverb tail that died too
early. R200 10k from Q70's emitter to -15 V is added (the schematic's
"PORTION CHANGED" note, missed before); nine more values are fitted to the
recording and listed in `CP_PARTS` (voices/cpma-circuit.js), several outside
normal tolerances. Distance to the recording (`node test/vs808.mjs cp`):
circuit 25.4 -> 7.2, synth 16.7 -> 10.9; the floor (the circuit against
itself with other noise) is ~4.7. Accented hits still run the claps together
more than normal ones (the sample set has no accented clap to fit against).
`node test/cp-score.mjs` prints the envelope and spectrum next to the
recording; `node test/cp-fit.mjs <parts>` refits; `node test/cp-probe.mjs`
shows the comparators, sawtooth and OTA current through one hit.

SD uses the schematic's "PORTION CHANGED" values (C58 .056u, C61 .015u, R191
10k, R200 shorted) by default; set `SD_REVISION = 'original'` in
voices/sd-circuit.js for the values the voice-check table was measured on.
C54 sits from Q48's collector to ground (it was across R188 before
2026-11-04, which stretched the snappy tail to 144 ms).

Assumed where the scan is unreadable: R324 180k (RS, set
to meet the table; Q62's base and collector were swapped before 2026-11-04), Q74
as a 2SK30A with Vp -3.5 V and 875 R (set so the claves, whose tail Q74
mutes, meet the table's 25 ms), Q18's bias
parts (CY) copied from Q16, the BA662 bias pin.

Cost (Node, one core, 48 kHz): a single voice is 2-50% of a core; the bench's
demo pattern needs about 140% and the dense all-voice pattern in
`test/cpu.mjs` about 210-220% (measured on this cloud machine, where the
same numbers before the Nov 5 solver changes were 165% and 255%; a fast
desktop may manage it). `node test/profile.mjs` breaks the cost down by voice
and stage. The
page shows the DSP load and suggests switching the heaviest voices (CY, MA, CP,
SD, CB) to Synth or 808. The synth kit uses about 10-13%. Circuit voices
sleep 0.2 s after their output goes quiet.

### Changing the solver

`dsp/mna.js` stops Newton when the linearised junction currents of the last
solve match the true exponential currents at the voltages it found (the
linearisation error, which shrinks with the square of the step), rather than
when the step itself is below the tolerance. That accepts most samples one
solve earlier and lands closer to a fully converged answer.

Before and after a solver change:

    node test/regress.mjs save                     # reference from the current code
    REF=truth TOL_SCALE=0.01 node test/regress.mjs save   # near-exact reference
    ...change dsp/mna.js...
    node test/regress.mjs                          # vs the saved reference
    REF=truth node test/regress.mjs                # vs the near-exact one
    node test/regress.mjs alt                      # hit-to-hit spread of each voice

The metal and noise voices (SD, CP, MA, CB, CY, OH, CH) are sensitive to the
solver tolerance at the waveform level, so for them judge the envelope and
spectrum columns against the `alt` spread, not the waveform error.

### Cached circuit hits

The **Cached** mode plays hits the circuit model rendered
offline: 16 normal and 16 accented hits per voice at the default knob
settings, each with the noise generator and metal oscillators in another
state and the trigger level +-1.5%. Every trigger picks one at random (never
the same twice in a row). LEVEL follows the circuit's own level curve, DECAY
(where the voice has one) shortens the hit with a fade below its default,
pitch and tone knobs are ignored, and a closed hat chokes a cached open hat.
The hits are stored at 32 kHz, 16-bit (`cache/<id>.wav` + `cache/index.json`):
21 MB in all, loaded per voice the first time Cached is picked, about 43 MB in
memory. The dense pattern costs about 5% of a core instead of ~215%.
Re-render after a circuit change with `node test/cache-render.mjs [ids]`
(about 3 minutes for all 16).
