// Features used to compare a behavioural render with the circuit render:
// level, a 2 ms RMS envelope, a 1/3-octave spectrogram (5 ms hop) and a
// 1/12-octave long-term spectrum. All in dB re 1 V.
export const SR = 48000;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], j = i + k + len / 2;
        const vr = re[j] * cr - im[j] * ci, vi = re[j] * ci + im[j] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[j] = ur - vr; im[j] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const db = (p) => 10 * Math.log10(p + 1e-12);

function bandEdges(fLo, fHi, perOct, N) {
  const edges = [];
  for (let f = fLo; f < fHi; f *= 2 ** (1 / perOct)) edges.push([f, f * 2 ** (1 / perOct)]);
  return edges.map(([a, b]) => [Math.max(1, Math.round(a * N / SR)), Math.max(1, Math.round(b * N / SR))])
    .map(([a, b]) => [a, Math.max(a + 1, b)]);
}

// power spectrum of one Hann frame starting at `start`
function frameSpec(x, start, N, win) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) { const k = start + i; re[i] = k >= 0 && k < x.length ? x[k] * win[i] : 0; }
  fft(re, im);
  const p = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) p[i] = (re[i] * re[i] + im[i] * im[i]);
  return p;
}
const hann = (N) => Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

export function features(x) {
  let lo = 0, hi = 0, e = 0;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; e += v * v; }
  // RMS envelope: 20 ms centred window (one BD period, so no ripple), 2 ms hop
  const env = [], half = 480, sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  for (let i = 0; i < x.length; i += 96) {
    const a = Math.max(0, i - half), b = Math.min(x.length, i + half);
    env.push(db((sq[b] - sq[a]) / (2 * half)));
  }
  // spectrogram: N=1024, hop 240, 1/3 octave 40 Hz..20 kHz
  const N = 1024, hop = 240, win = hann(N), wsum = win.reduce((a, b) => a + b * b, 0);
  const bands = bandEdges(40, 20000, 3, N), spg = [];
  const frames = Math.ceil(x.length / hop);
  for (let f = 0; f < frames; f++) {
    const p = frameSpec(x, f * hop - N / 2, N, win);
    spg.push(bands.map(([a, b]) => { let s = 0; for (let k = a; k < b; k++) s += p[k]; return db(s / wsum); }));
  }
  // long-term spectrum: N=8192 frames, hop 2048, summed, 1/12 octave 25 Hz..20 kHz
  const L = 8192, wl = hann(L), wls = wl.reduce((a, b) => a + b * b, 0), acc = new Float64Array(L / 2);
  for (let s = -L / 2; s < x.length; s += 2048) { const p = frameSpec(x, s, L, wl); for (let k = 0; k < L / 2; k++) acc[k] += p[k]; }
  const lb = bandEdges(25, 20000, 12, L);
  const lts = lb.map(([a, b]) => { let s = 0; for (let k = a; k < b; k++) s += acc[k]; return db(s / wls / (b - a)); });
  return { vpp: hi - lo, rms: db(e / x.length), env, spg, lts };
}

// mean |dB| difference over cells either signal fills, with a floor `range`
// dB under the reference's maximum
function cellDist(A, B, range) {
  let max = -1e9; for (const v of A) if (v > max) max = v;
  const floor = max - range; let s = 0, n = 0;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const a = Math.max(floor, A[i] ?? floor), b = Math.max(floor, B[i] ?? floor);
    if (a > floor || b > floor) { s += Math.abs(a - b); n++; }
  }
  return n ? s / n : 0;
}

// ref = circuit features, got = behavioural features
export function distance(ref, got) {
  const env = cellDist(ref.env, got.env, 50);
  const spg = cellDist(ref.spg.flat(), got.spg.flat(), 60);
  const lts = cellDist(ref.lts, got.lts, 50);
  const lvl = 20 * Math.log10(got.vpp / ref.vpp);
  return { env, spg, lts, lvl, score: env + spg + 0.5 * lts + Math.abs(lvl) };
}
