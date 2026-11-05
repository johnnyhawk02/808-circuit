# Real TR-808 recordings

`cache/808/` holds Michael Fischer's "Roland TR-808 Rhythm Composer Sound Sample
Set 1.0.0" (Technopolis, 09/08/94), recorded straight from a real TR-808
(serial no. 103852). His notes are in `TR808.TXT`.

- Recorded dry from each voice's individual output, not the mix outs, with
  the voice LEVEL at full. No effects.
- 16-bit, 44.1 kHz, mono.
- Every knob other than LEVEL at 0, 2.5, 5, 7.5 and 10 of its 11 panel marks.
  The file name gives the positions in panel order (TONE / TUNING before
  DECAY / SNAPPY): `BD2575.WAV` is BD with TONE at 2.5 and DECAY at 7.5;
  `10` means the maximum position (10.0), not 1.0.
- No accented hits.

Source: the set as published on machines.hyperreal.org and repackaged in the
npm package `@fluid-music/tr-808` (ISC), whose README states the recordings
were distributed "with no licensing restrictions". Fischer's own notes
describe the set as "ABSOLUTELY FREE". The `BDTuned` folder and the REAPER
project files from that package are not included.

The bench plays the recording nearest the current knob settings
(`dsp/sampler.js`). Output is scaled to volts so the default-knob hit matches
the circuit model's level (`SAMPLE_CAL` in `dsp/calibration.js`), and accent
scales it by the circuit model's accent/normal ratio.
