// Minimal 16-bit PCM WAV reader (mono or first channel). Works on an
// ArrayBuffer in the browser, the worklet and Node.
export function parseWav(buf) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset ?? 0, buf.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, ch = 1, sr = 44100, bits = 16;
  while (o + 8 <= dv.byteLength) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { ch = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
    if (id === 'data') {
      if (bits !== 16) throw new Error('only 16-bit WAV supported');
      const n = Math.floor(Math.min(size, dv.byteLength - o - 8) / (2 * ch)), x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = dv.getInt16(o + 8 + i * 2 * ch, true) / 32768;
      return { sr, data: x };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}
