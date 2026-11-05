// AudioWorklet host for the kit. Triggers carry an AudioContext time so the
// sequencer is sample-accurate. Every ~0.5 s it reports how much of the
// real-time budget rendering used (the circuit models are expensive).
import { Kit } from './dsp/kit.js';

class TR808Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.kit = new Kit(sampleRate);
    this.busy = 0; this.frames = 0;
    this.port.onmessage = ({ data: m }) => {
      if (m.t === 'trig') this.kit.trigger(m.id, m.accent, m.when != null ? Math.round(m.when * sampleRate) : undefined);
      else if (m.t === 'set') this.kit.set(m.id, m.param, m.value);
      else if (m.t === 'master') this.kit.master = m.value;
      else if (m.t === 'model') this.kit.setModel(m.id, m.value);
      else if (m.t === 'cache') this.kit.loadCache(m.id, m.info, new Int16Array(m.pcm));
      else if (m.t === 'bdModel') this.kit.setBdModel(m.value);
      else if (m.t === 'stop') this.kit.queue.length = 0;
    };
  }
  process(_in, outputs) {
    const out = outputs[0], t0 = Date.now();
    this.kit.frame = currentFrame;
    this.kit.render(out[0], out[0].length);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    this.busy += Date.now() - t0; this.frames += out[0].length;
    if (this.frames >= sampleRate / 2) {
      this.port.postMessage({ t: 'load', value: this.busy / (1000 * this.frames / sampleRate) });
      this.busy = 0; this.frames = 0;
    }
    return true;
  }
}
registerProcessor('tr808', TR808Processor);
