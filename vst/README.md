# 808 Circuit as a plugin (VST3, AU, standalone)

The web app (`elixir/`, at the site's root) as a JUCE plugin, the same in every way that can be:

- **The UI is the app's own page.** The editor is a web view showing the built `elixir/index.html` (every page, knob
  and menu as on the site), with two small scripts put into it (`ui/shim.js`, `ui/boot.js`).
- **The sound is the app's player, in C++** (`src/dsp/`): the 808 voices (circuit and cached hits, picked at random
  each hit, 48 kHz), the kit's FX bus (delay, distortion, compressor), the IR reverb with its gate, the master
  compressor and kick duck, the 64-step patterns and the generator, rush, the mixer and the recorder. It takes the
  page's messages exactly as the browser's AudioWorklet does, and was checked against the JavaScript sample by
  sample (`tests/`): 14 s of a scripted session matches to 176 dB SNR, with the same 712 events in the same order.
- **Presets save everything**, as in the app; the plugin also saves the whole page state with the project, so a
  project reopens as it was left, with or without the editor open.
- **Host sync:** the host's tempo is the tempo; its play/stop starts and stops the sequencer, locked to the host's bar
  position (it follows loops and jumps).
- **MIDI:** C0 to G0 (notes 24 to 31) pick the grid's patterns 1 to 8, as keys 1 to 8 do; the General MIDI drum
  notes (36 kick, 38 snare, 42/46 hats, toms, 49 cymbal...) play the tracks.
- Storage: what the page keeps in the browser is kept by the plugin. This instance's sound, patterns and mix go with
  the project; the preset library and settings are shared by every instance, in `808 Circuit/storage.json` in the
  user's application data folder. A new instance starts from the last state used.
- Files the page would download (recordings, kits, favourites) open a save dialog.

## Build

Needs CMake 3.22+ and a C++17 compiler (on macOS the Command Line Tools are enough; Xcode works too). JUCE 8.0.10
is fetched.

```sh
cd vst
cmake -B build -DCMAKE_BUILD_TYPE=Release     # (or -G Xcode); on macOS this builds universal (arm64 + x86_64)
cmake --build build --config Release -j8
cmake --build build --config Release --target T8Install   # macOS: copies the VST3 (to VST3/Johnny Hawk) and AU to ~/Library/Audio/Plug-Ins
```

The bundles carry the page and what it loads in `Contents/Resources/app` (the built `elixir/index.html`, its IRs,
icons and help, the shipped cached hits from `cache/`). Rebuild `elixir/index.html` (`node elixir/build.mjs`) before
building the plugin to pick up app changes.

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libasound2-dev libcurl4-openssl-dev` and the usual JUCE packages;
`patches/` fixes JUCE's Linux web view for a page this big (applied to the fetched JUCE automatically).

## Tests

```sh
node tests/ref-voices.mjs /tmp/refv && cmake --build build --target t8_voices && build/t8_voices /tmp/refv
node tests/ref-player.mjs /tmp/refp && cmake --build build --target t8_player && build/t8_player /tmp/refp
# the plugin in a test host (Linux, e.g. under Xvfb): plays 14 s with the host transport and a MIDI pattern change,
# saves, and renders the saved state in a new instance
cmake -B build -DT8_TEST_HOST=ON && cmake --build build --target t8_host && build/t8_host_artefacts/Release/t8_host /tmp/out.wav 14
```

## Known differences from the browser

- A voice set to cached whose hits haven't loaded plays the circuit model (the browser plays the behavioural synth
  model). The shipped hits are loaded when the plugin starts, so this only matters for a moment, if at all.
- The kit LFOs' random wave isn't the browser's exact random sequence (the browser's shares its generator with the
  silent LXR voices); it is the same kind of random.
- The kit FX slot's ring modulator isn't ported (the app always uses the slot as the delay).
- The metal voices (cymbal, hats, cowbell) can drift from the browser's samples after a while, because the C++ maths
  library and the browser's round their last bit differently; their sound and envelopes are the same.
