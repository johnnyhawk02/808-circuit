// Runs the engine and the step sequencer, and resamples 44 140 Hz to the output rate.
// Used inside the AudioWorklet (or a ScriptProcessor fallback).
// bar conditions: 0 every bar; n = only the last bar of every n; -n = every bar except that one;
// 100 + n = only the first bar of every n (the bar after a fill)
function barOk(b, bar) {
  if (!b) return true;
  if (b > 100) return bar % (b - 100) === 0;
  if (b > 0) return bar % b === b - 1;
  return bar % -b !== -b - 1;
}
// the tempo-synced delay: 1/128 of a bar at 0, a whole bar at 1, evenly in octaves between
const delaySamples = (pos, bpm) => 240 / bpm * Math.pow(2, -7 * (1 - pos)) * LXR.REAL_FS;
const VERB_MAKEUP = 1;
// ---- the reverb: convolution with an impulse response (a recorded room, hall or reverb unit) ----
// radix-2 complex FFT in place (inv: the inverse, unscaled); twiddles and bit reversal kept a size
const FFT_T = {};
function fftTab(n) {
  if (FFT_T[n]) return FFT_T[n];
  const bits = Math.log2(n), rev = new Uint32Array(n), c = new Float64Array(n / 2), s = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let k = 0; k < n / 2; k++) { c[k] = Math.cos(2 * Math.PI * k / n); s[k] = Math.sin(2 * Math.PI * k / n); }
  return (FFT_T[n] = { rev, c, s });
}
function fft(re, im, inv) {
  const n = re.length, T = fftTab(n), rev = T.rev, C = T.c, S = T.s, sg = inv ? 1 : -1;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1, st = n / size;
    for (let i = 0; i < n; i += size) for (let k = 0, w = 0; k < h; k++, w += st) {
      const wr = C[w], wi = sg * S[w], a = i + k, b = a + h;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
// Two stages of uniformly partitioned overlap-save convolution, mono in, stereo out: the IR's first 4096 samples in
// 64-sample parts (no latency: each 64-sample block is convolved as it comes), the rest in 2048-sample parts, whose
// work is spread over the 32 blocks after each 2048 samples of input and lands exactly when it's due (2 x 2048 after).
// IrVerb.prepare (on the page) cuts the IR into those parts' spectra; the player swaps them in.
const IRV_B1 = 64, IRV_N1 = 128, IRV_K1 = 65, IRV_P1 = 64, IRV_B2 = 2048, IRV_N2 = 4096, IRV_K2 = 2049;
// the gate's lengths, in bars (4/4): off, 1/64, 1/32, 1/16T, 1/16, 1/8T, 1/16., 1/8, 1/4T, 1/8., 1/4, 1/2T, 1/4., 1/2, 1/2., 1 bar
const VERB_GATE = [0, 1 / 64, 1 / 32, 1 / 24, 1 / 16, 1 / 12, 3 / 32, 1 / 8, 1 / 6, 3 / 16, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 3 / 4, 1];
const IRV_MAX = 5 * 44140, IRV_P2MAX = Math.ceil((IRV_MAX - IRV_B1 * IRV_P1) / IRV_B2) + 1;
class IrVerb {
  // L, R: the IR at the engine's rate (R may be L); frac: how much of it to keep (the length knob, faded out over the last
  // 30% of what's kept). Scaled to unit energy, so a long IR is no louder than a short one
  static prepare(L, R, frac = 1) {
    R = R || L;
    const n = Math.max(64, Math.min(IRV_MAX, Math.round(L.length * frac))), fd = Math.round(n * 0.3);
    const ch = [L, R].map((x) => { const y = new Float64Array(n); for (let i = 0; i < n; i++) y[i] = (x[i] || 0) * (i > n - fd ? 0.5 + 0.5 * Math.cos(Math.PI * (i - (n - fd)) / fd) : 1); return y; });
    let e = 0; for (const y of ch) for (let i = 0; i < n; i++) e += y[i] * y[i];
    const g = 0.8 / Math.sqrt(e / 2 + 1e-12); // (about as loud as the firmware reverb it replaced)
    const part = (y, off, B, N, K, P) => {
      const re = new Float32Array(P * K), im = new Float32Array(P * K), r = new Float64Array(N), m = new Float64Array(N);
      for (let p = 0; p < P; p++) {
        r.fill(0); m.fill(0);
        for (let i = 0; i < B; i++) { const k = off + p * B + i; if (k < n) r[i] = y[k] * g; }
        fft(r, m, false); re.set(r.subarray(0, K), p * K); im.set(m.subarray(0, K), p * K);
      }
      return { re, im };
    };
    const p2 = Math.max(0, Math.ceil((n - IRV_B1 * IRV_P1) / IRV_B2));
    return { n, p2, h1: ch.map((y) => part(y, 0, IRV_B1, IRV_N1, IRV_K1, IRV_P1)), h2: ch.map((y) => part(y, IRV_B1 * IRV_P1, IRV_B2, IRV_N2, IRV_K2, p2)) };
  }
  constructor(fs) {
    this.fs = fs; this.h = null;
    this.x1re = new Float32Array(IRV_P1 * IRV_K1); this.x1im = new Float32Array(IRV_P1 * IRV_K1); this.pos1 = 0;
    this.x2re = new Float32Array(IRV_P2MAX * IRV_K2); this.x2im = new Float32Array(IRV_P2MAX * IRV_K2); this.pos2 = 0;
    this.prev1 = new Float64Array(IRV_B1);
    this.seg = new Float64Array(IRV_B2); this.prevSeg = new Float64Array(IRV_B2); this.jobWin = new Float64Array(IRV_N2);
    this.job = false; this.blk = 0;
    this.out2 = [new Float32Array(IRV_B2), new Float32Array(IRV_B2)]; this.pend = [new Float32Array(IRV_B2), new Float32Array(IRV_B2)];
    this.r1 = new Float64Array(IRV_N1); this.i1 = new Float64Array(IRV_N1); this.r2 = new Float64Array(IRV_N2); this.i2 = new Float64Array(IRV_N2);
    this.y1 = [new Float64Array(IRV_K1), new Float64Array(IRV_K1), new Float64Array(IRV_K1), new Float64Array(IRV_K1)];
    this.y2 = [new Float64Array(IRV_K2), new Float64Array(IRV_K2), new Float64Array(IRV_K2), new Float64Array(IRV_K2)];
    // pre-delay (up to 150 ms), low cut on the way in; tone (a low-pass) and width on the way out
    this.pd = new Float32Array(8192); this.pdW = 0; this.pre = 0;
    this.lcA = 0; this.lcS = 0; this.lpA = 1; this.lpL = 0; this.lpR = 0; this.width = 1;
    this.idle = Infinity; this.v = new Float64Array(64);
    // the gate: each hit into the reverb (after the pre-delay) opens it for its length, a note division at the tempo plus
    // its fine tune; then it shuts (1 ms open, 6 ms shut). gate 0 = off
    this.gate = 0; this.gFine = 0; this.bpm = 120; this.gEnvF = 0; this.gEnvS = 0; this.gLeft = 0; this.gG = 1; this.gt = new Float32Array(64);
    this.gkF = Math.exp(-1 / (0.002 * fs)); this.gkS = Math.exp(-1 / (0.08 * fs)); this.gA = 1 - Math.exp(-1 / (0.001 * fs)); this.gR = 1 - Math.exp(-1 / (0.006 * fs));
    this.set({ pre: 10, low: 50, tone: 100, width: 64 });
  }
  // the knobs, 0..127: pre-delay 0..150 ms, low cut 20..500 Hz, tone 1..20 kHz (a one-pole low-pass), width 0..200%
  set(v) {
    if (v.pre !== undefined) this.pre = Math.min(this.pd.length - 64, Math.round(v.pre / 127 * 0.15 * this.fs));
    if (v.low !== undefined) this.lcA = Math.exp(-2 * Math.PI * 20 * Math.pow(25, v.low / 127) / this.fs);
    if (v.tone !== undefined) this.lpA = 1 - Math.exp(-2 * Math.PI * Math.min(0.45 * this.fs, 1000 * Math.pow(20, v.tone / 127)) / this.fs);
    if (v.width !== undefined) this.width = v.width / 64;
    if (v.gate !== undefined) this.gate = Math.max(0, Math.min(VERB_GATE.length - 1, v.gate | 0));
    if (v.gfine !== undefined) this.gFine = v.gfine;
  }
  load(h) { this.h = h; }
  clear() {
    this.x1re.fill(0); this.x1im.fill(0); this.x2re.fill(0); this.x2im.fill(0); this.prev1.fill(0); this.seg.fill(0); this.prevSeg.fill(0);
    for (const b of [...this.out2, ...this.pend]) b.fill(0);
    this.job = false; this.lcS = 0; this.lpL = 0; this.lpR = 0; this.pd.fill(0);
  }
  // one 64-sample block: x (mono, float) in; the wet signal added into L and R at gain g0 ramping to g1
  process(x, L, R, g0, g1) {
    const h = this.h; if (!h) return;
    let any = false; for (let i = 0; i < 64; i++) if (x[i]) { any = true; break; }
    const gone = h.n + 3 * IRV_B2 + this.pre;
    if (any) { if (this.idle > gone) this.clear(); this.idle = 0; }
    else if ((this.idle += 64) > gone) return;
    // pre-delay and low cut (a one-pole high-pass)
    const pd = this.pd, M = pd.length - 1, xin = this.r1, gt = this.gt;
    const gLen = this.gate ? Math.max(64, VERB_GATE[this.gate] * 240 / this.bpm * this.fs * (1 + this.gFine / 100)) : 0;
    for (let i = 0; i < 64; i++) {
      pd[this.pdW] = x[i];
      const d = pd[(this.pdW - this.pre) & M]; this.pdW = (this.pdW + 1) & M;
      this.lcS = d + this.lcA * (this.lcS - d); xin[i] = d - this.lcS;
      if (gLen) {
        // a hit: the fast envelope jumps over the slow one (and over a floor)
        const a = Math.abs(d); this.gEnvF = Math.max(a, this.gEnvF * this.gkF);
        if (this.gEnvF > 1.6 * this.gEnvS + 1e-4 && this.gLeft <= 0) this.gLeft = gLen;
        this.gEnvS = Math.max(this.gEnvF, this.gEnvS * this.gkS);
        const to = this.gLeft-- > 0 ? 1 : 0;
        this.gG += (to - this.gG) * (to ? this.gA : this.gR); gt[i] = this.gG;
      } else gt[i] = 1;
    }
    if (!gLen) { this.gG = 1; this.gLeft = 0; }
    const v = this.v; v.set(xin.subarray(0, 64));
    // stage 1: [previous block, this block] -> spectrum into the ring; the sum over parts; back
    const r1 = this.r1, i1 = this.i1;
    r1.set(this.prev1, 0); r1.set(v, 64); i1.fill(0); this.prev1.set(v);
    fft(r1, i1, false);
    const o1 = this.pos1 * IRV_K1; this.x1re.set(r1.subarray(0, IRV_K1), o1); this.x1im.set(i1.subarray(0, IRV_K1), o1);
    const [aLr, aLi, aRr, aRi] = this.y1; aLr.fill(0); aLi.fill(0); aRr.fill(0); aRi.fill(0);
    this.mac(this.x1re, this.x1im, IRV_P1, this.pos1, IRV_K1, h.h1, 0, IRV_P1, this.y1);
    this.pos1 = (this.pos1 + 1) % IRV_P1;
    this.back(this.y1, r1, i1, IRV_N1);
    // stage 2: this block of the segment in, its output out (computed during the segment before)
    const b = this.blk, s = b * 64;
    this.seg.set(v, s);
    if (this.job) {
      if (b === 0) {
        const r2 = this.r2, i2 = this.i2; r2.set(this.jobWin); i2.fill(0); fft(r2, i2, false);
        const o2 = this.pos2 * IRV_K2; this.x2re.set(r2.subarray(0, IRV_K2), o2); this.x2im.set(i2.subarray(0, IRV_K2), o2);
        for (const y of this.y2) y.fill(0);
      }
      const P = Math.min(h.p2, IRV_P2MAX), p0 = Math.floor(b * P / 32), p1 = Math.floor((b + 1) * P / 32);
      if (p1 > p0) this.mac(this.x2re, this.x2im, IRV_P2MAX, this.pos2, IRV_K2, h.h2, p0, p1, this.y2);
      if (b === 31) {
        this.back(this.y2, this.r2, this.i2, IRV_N2);
        for (let i = 0; i < IRV_B2; i++) { this.pend[0][i] = this.r2[IRV_B2 + i]; this.pend[1][i] = this.i2[IRV_B2 + i]; }
        this.pos2 = (this.pos2 + 1) % IRV_P2MAX;
      }
    }
    // out: both stages, tone and width
    const o2L = this.out2[0], o2R = this.out2[1], a = this.lpA, w = this.width;
    let lL = this.lpL, lR = this.lpR;
    for (let i = 0; i < 64; i++) {
      const yl = r1[64 + i] + o2L[s + i], yr = i1[64 + i] + o2R[s + i];
      lL += a * (yl - lL); lR += a * (yr - lR);
      const m = (lL + lR) / 2, d = (lL - lR) / 2 * w, g = (g0 + (g1 - g0) * (i + 1) / 64) * gt[i];
      L[i] += (m + d) * g; R[i] += (m - d) * g;
    }
    this.lpL = lL; this.lpR = lR;
    if (b === 31) {
      // the segment's in: its job starts next block; the finished job's output plays over the next segment
      if (this.job) { const t = this.out2; this.out2 = this.pend; this.pend = t; } else { o2L.fill(0); o2R.fill(0); }
      this.jobWin.set(this.prevSeg, 0); this.jobWin.set(this.seg, IRV_B2); this.prevSeg.set(this.seg);
      this.job = h.p2 > 0;
    }
    this.blk = (b + 1) & 31;
  }
  // y += sum over parts p0..p1 of X[pos - p] * H[p], both channels
  mac(Xr, Xi, ring, pos, K, H, p0, p1, y) {
    const [yLr, yLi, yRr, yRi] = y, HL = H[0], HR = H[1];
    for (let p = p0; p < p1; p++) {
      const xo = ((pos - p + ring) % ring) * K, ho = p * K;
      for (let k = 0; k < K; k++) {
        const xr = Xr[xo + k], xi = Xi[xo + k], lr = HL.re[ho + k], li = HL.im[ho + k], rr = HR.re[ho + k], ri = HR.im[ho + k];
        yLr[k] += xr * lr - xi * li; yLi[k] += xr * li + xi * lr;
        yRr[k] += xr * rr - xi * ri; yRi[k] += xr * ri + xi * rr;
      }
    }
  }
  // both channels' half spectra -> one inverse FFT (left in the real part, right in the imaginary), scaled
  back(y, re, im, N) {
    const [Lr, Li, Rr, Ri] = y, H = N / 2;
    for (let k = 0; k <= H; k++) { re[k] = Lr[k] - Ri[k]; im[k] = Li[k] + Rr[k]; }
    for (let k = H + 1; k < N; k++) { const j = N - k; re[k] = Lr[j] + Ri[j]; im[k] = Rr[j] - Li[j]; }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}
// the 808 voices' gain from the bench's digital level (volts / 24) to Elixir's: about as loud as the LXR voices
const G808 = 2.4;
// each 808 voice's track when the grid's lanes play (and the mixer channel it takes: tracks 5 and 6 share the hats'):
// the kick on drum 1 (the sidechain's key), toms on drum 2, congas and the small percussion on drum 3, snare, rim shot
// and clap on the snare, cymbal, then the hats
const BUS808 = { bd: 0, lt: 1, mt: 1, ht: 1, lc: 2, mc: 2, hc: 2, cl: 2, ma: 2, cb: 2, sd: 3, rs: 3, cp: 3, cy: 4, ch: 5, oh: 6 };
// snare rush: a fixed hash of (track, page, step) in 0..1; a hit whose hash is under the rush amount goes to the snare,
// so the hits it takes stay put and more join as it goes up
function rushHash(t, pg, s) {
  let h = Math.imul(t * 131 + pg * 17 + s + 1, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca77); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
class Player {
  constructor(outRate) {
    this.e = new LXR.LxrEngine();
    this.e.loadInitKit();
    this.ratio = LXR.REAL_FS / outRate;
    this.A = [new Float32Array(64), new Float32Array(64)];
    this.B = [new Float32Array(64), new Float32Array(64)];
    this.idx = 0; this.frac = 0;
    this.pattern = { on: [], acc: [], bar: [] };
    this.playing = false; this.bpm = 120; this.vel = 100; this.accGain = 0.5;
    this.step = 0; this.bar = 0; this.toNext = 0; this.atBar = [];
    // groove: per track and step, how far its hits sit off the grid in 16ths (+ late, - early)
    this.groove = { off: Array.from({ length: 7 }, () => new Array(16).fill(0)) };
    this.queue = []; this.sched = []; this.fresh = false; this.rec = null;
    // count-in: a beep then three boops over the bar before a take, with the mix turned down under them
    this.cntStep = 0; this.cntGain = 1; this.clk = null;
    // accent: unaccented sequencer hits are turned down by the accent amount, after the engine
    this.gain = new Float32Array(6).fill(1); this.gainTo = new Float32Array(6).fill(1);
    this.fxGain = new Float32Array(6); this.fxAmt = new Float32Array(6).fill(1);
    // mixer mute: the sequencer skips a muted voice's steps; pads, MIDI and anything still ringing play on
    this.muted = new Uint8Array(6);
    // snare rush 0..100: up to 98 the other tracks' hits go to the snare (the hats by 80), above 75 a snare roll that doubles
    // in two bands up to 80, then above 80 a free roll off the grid: a phase that runs at 2 to 16 hits a step and fires a hit at each whole
    // number, so it speeds up smoothly as the fader moves (rushHead: an accent waiting for the next free hit; rushLog: the
    // roll's rate in log2 hits a step, gliding toward the fader's so a move never steps)
    // rs: its break points and glides, from the rush settings popup (these are the defaults; top: log2 of the free roll's
    // hits a step at 100, 4 = 256ths; hpTop in Hz, the glides' time constants in ms)
    this.rs = { start: 75, p32: 80, top: 4, hats: 80, only: 98, kicks: 90, first: 95, hp: 90, hpTop: 1500, rollMs: 40, hpMs: 40 };
    // rushT: the track the rush hands the hits to and rolls on (3, the snare, unless another is picked; Elixir Mobile)
    this.rushT = 3;
    this.rush = 0; this.rushPh = null; this.rushLog = 1; this.rushHead = null; this.rushGap = 0; this.clock = 0; this.snareAt = -1e9;
    // and above 90 a high-pass on the whole mix, before the master compressor: 30 Hz at 90 up to 1.5 kHz at 100
    // (hpLog: its cutoff in log Hz, gliding; hpMix: how much of it is heard, faded in and out so it never clicks;
    // hpOn false: off and its state cleared, the mix untouched)
    this.hpOn = false; this.hpLog = Math.log(30); this.hpMix = 0; this.hpG = 0; this.hpS = new Float64Array(4);
    // master: drum 1 ducks the other voices (before the FX bus), then a compressor
    // on the whole mix, the same design as the LXR-02's FX compressor
    this.master = { comp: true, thresh: -12, ratio: 3, attack: 5, release: 120, makeup: 0, duck: 0.4, duckRelease: 150, duckFx: false, duckOn: true, space: 0 };
    // the sidechain's spacer (after Trackspacer): drum 1 also carves room for itself in the other voices, band by band.
    // Eight band-passes an octave apart from 60 Hz run on drum 1 and on the others' mix; where drum 1 has energy in a band,
    // that band of the others is turned down, by up to space (100 = -20 dB). Each band is a peaking cut, x + (gain - 1)
    // times its band-pass, so with drum 1 quiet the others pass untouched. The cut follows drum 1 with a 3 ms attack and
    // the sidechain's release
    this.spF = Array.from({ length: 8 }, (_, k) => Math.tan(Math.PI * 60 * Math.pow(2, k * 1.1) / LXR.REAL_FS));
    this.spS = new Float64Array(48); this.spEnv = new Float32Array(8); this.spG = new Float32Array(8).fill(1);
    this.spL = new Float32Array(64); this.spR = new Float32Array(64); this.spKey = new Float32Array(64); this.spOn = false;
    // delay: tempo-synced time, 0 = 1/128 .. 1 = one bar, and run as a send effect (all wet,
    // the voices keep their dry path); not in the firmware
    this.delayPos = 1 + Math.log2(3 / 16) / 7;
    this.echoSync = true; this.echoFree = 0.25; this.echoFine = 0;
    // two more of the firmware's FX: the reverb (written for it but never switched on) as the second send bus (wet only, the
    // voices keep their dry path; the engine's own FX bus is the echo), and in Elixir Mobile the distortion as an insert
    // on the whole mix, before the compressor. (Send 2 was the ring mod; its sends, sendR, now feed the reverb)
    this.dist = new LXR.FxBus(); this.dist.fxType = LXR.FX_DISTORTION; this.dist.forceWet = true;
    this.verb = new IrVerb(LXR.REAL_FS); this.verbIn = new Float32Array(64);
    this.fxRng = new LXR.Rng(0x2545f491);
    this.sendD = new Float32Array(6); this.sendR = new Float32Array(6); this.echoWidth = 1;
    this.distMix = 0; this.distAt = 0;
    this.busIn = new Float32Array(128); this.busOut = new Int16Array(128);
    this.duckEnv = 0; this.duckAt = 1; this.compEnv = 0; this.gr = 0; this.duckMin = 1;
    // level meters: each voice's peak after its fader, accent, mute and duck
    this.lvl = new Float32Array(6); this.lvlN = 0; this.lvlOn = false;
    this.events = [];
    // the TR-808 voices (app/tr808.js): a track set to one plays it instead of its LXR voice
    this.k808 = null; this.t808 = new Array(7).fill(null); this.want808 = {}; this.b808 = {}; this.lanes = null; this.lanePages = 1;
    // each 808 sound's own mix (the mix page, app/tr808-mix.js): level, pan, echo and reverb sends; its dry signal this
    // block (int16 scale, at its level) and peak
    this.vmix = {}; this.vbuf = {}; this.vpk = {}; this.fxExtra = new Float32Array(128);
    this.vlv = {}; // (and each sound's own meter peak, for the grid's level fader)
    this._render(this.A); this._render(this.B);
  }
  msg(m) {
    if (m.type === 'param') this.e.setParam(m.par, m.value);
    else if (m.type === 'kit') this.e.loadKit(m.values);
    else if (m.type === 'trig') { this.hit(m.voice, m.vel, m.vel >= 127); this.gainTo[Math.min(m.voice, 5)] = 1; }
    else if (m.type.endsWith('808')) this.msg808(m);
    else if (m.type === 'rush') { this.rush = m.v; if (m.t !== undefined) this.rushT = m.t; }
    else if (m.type === 'rushSet') Object.assign(this.rs, m.set);
    else if (m.type === 'mute') m.muted.forEach((v, n) => { this.muted[n] = v ? 1 : 0; });
    else if (m.type === 'xmod') return; // (Elixir 808: no crossfeed)
    else if (m.type === 'delay') this.delayPos = m.pos;
    else if (m.type === 'verbIr') this.verb.load(m.h);
    else if (m.type === 'atBar') { if (this.playing) this.atBar.push(m.m); else this.msg(m.m); }
    else if (m.type === 'mix') {
      if (m.master) Object.assign(this.master, m.master);
      if (m.dist) {
        this.dist.distortion.type = m.dist.type;
        m.dist.p.forEach((v, i) => this.dist.setParameter(i, v / 127));
        this.distMix = (m.dist.mix || 0) / 100;
        if (m.verb) this.verb.set(m.verb);
        this.sendD.set(m.sendD); this.sendR.set(m.sendR); this.echoWidth = m.echo.pct / 100;
        // the echo's time: tempo-synced (the position, as before) or free (milliseconds, 1..2000, linear in the TIME knob); fine
        // tunes either by up to 1% (-100..100 hundredths of a percent)
        this.echoSync = m.echo.sync !== false; this.echoFree = m.echo.free ?? 0.25; this.echoFine = m.echo.fine || 0;
      } this.fxAmt.set(m.fx); }
    else if (m.type === 'rec') {
      // recorder: free starts now; a loop waits for the first step of a bar and stops after its bars
      // with a count-in, the take starts on the bar after a counted one (from stop the count keeps its own time)
      this.rec = { loop: m.bars > 0, bars: m.bars, on: !(m.bars > 0) && !m.count, count: m.count ? (this.playing ? 'wait' : 'run') : null,
        done: 0, L: new Float32Array(16384), R: new Float32Array(16384), n: 0 };
      if (this.rec.count === 'run') { this.cntStep = 0; this.toNext = 0; }
      this.events.push({ type: 'rec', state: this.rec.on ? 'on' : this.rec.count === 'run' ? 'count' : 'wait' });
    } else if (m.type === 'recStop') { if (this.rec) this.recEnd(); }
    else if (m.type === 'seq') {
      // a live pattern change (the perform sliders, the grid) wins over one still waiting for the bar
      this.atBar = this.atBar.filter((q) => q.type !== 'seq');
      this.pattern = m.pattern; this.patternOn = m.patternOn !== false; this.bpm = m.bpm;
      if (m.groove) this.groove = m.groove; this.vel = m.vel; this.e.bpm = m.bpm;
      this.accGain = Math.pow(10, -m.accentDb / 20);
      if (m.playing && !this.playing) { this.rushPh = null; this.rushHead = null; this.step = 0; this.bar = 0; this.toNext = 0; this.queue = []; this.fresh = true; }
      const was = this.playing; this.playing = m.playing;
      // stopping ends a loop or a count-in (a count from stop is not playing yet, so it carries on)
      if (!this.playing) { this.flushBar(); if (this.rec && (this.rec.loop || this.rec.count) && (was || this.rec.count !== 'run')) this.recEnd(); }
    }
  }
  recFlush() {
    const r = this.rec;
    if (r.n) this.events.push({ type: 'recData', L: r.L.slice(0, r.n), R: r.R.slice(0, r.n) });
    r.n = 0;
  }
  recEnd() { this.recFlush(); this.events.push({ type: 'rec', state: 'done', bars: this.rec.done, bpm: this.bpm }); this.rec = null; }
  // a preset loaded while playing: its messages wait for the first step of the next bar.
  // A queued pattern never starts or stops the transport.
  flushBar() {
    const q = this.atBar; this.atBar = [];
    for (const m of q) this.msg(m.type === 'seq' ? { ...m, playing: this.playing } : m);
  }
  // the hits of step s, each due `at` samples from now: the grid time of the step moved by the groove
  schedule(s, bar, at0) {
    const pg = this.pattern.pages ? bar % this.pattern.pages.length : 0;
    const P = this.pattern.pages ? this.pattern.pages[pg] : this.pattern; // pages: one bar each, in turn
    const hits = [], { on, acc, bar: cond } = P, G = this.groove, len = LXR.REAL_FS * 60 / this.bpm / 4;
    if (this.lanes) { // the grid's lanes: each voice on its track (BUS808), moved by that track's groove; a pattern of
      // several bars (lanePages, up to 4: 64 steps) plays its bars in turn
      for (const id in this.lanes) {
        const L = this.lanes[id], t = BUS808[id], k = (bar % this.lanePages) * 16 + s;
        if (!L.on[k] || t === undefined || this.muted[Math.min(t, 5)]) continue;
        this.queue.push({ at: Math.max(0, at0 + G.off[t][s] * len), t, lane: id, acc: !!L.acc[k] });
        hits.push(t);
      }
      this.sched[s] = hits; return;
    }
    if (this.rush && this.patternOn) { this.scheduleRush(s, bar, pg, P, at0, len, hits); return; }
    for (let t = 0; t < 7 && this.patternOn; t++) {
      if (!on[t][s] || !barOk(cond[t][s], bar) || this.muted[Math.min(t, 5)]) continue;
      const off = G.off[t][s];
      this.queue.push({ at: Math.max(0, at0 + off * len), t, acc: !!acc[t][s] });
      hits.push(t);
    }
    this.sched[s] = hits;
  }
  // schedule() with the snare rush up (the numbers here are rs's defaults, which move with the rush settings): the snare takes the other drums' hits under (rush/98)^2.5, so it comes in slowly
  // (all of them from 98; the hats, tracks 5 and 6, go faster, under (rush/80)^2.5, all of them from 80), one snare per step, accented if any hit it took was; the kick's off-beat hits go the same way,
  // but its hits on the beat (steps 0, 4, 8, 12) play on below 90; from 90 only the bar's first (step 0) plays, and from 95
  // none do, leaving just the roll.
  // Above 75 the snare plays only the roll: every step, once or twice (16ths, then 32nds above 77.5), on the straight grid
  // (the groove doesn't move it), every hit at one level that swells from 60% to full, so the pattern's own snares and the
  // hits it took don't stand out; only an accent they carried plays, on the step's first roll hit.
  // The roll's hits are tagged (roll 2 for a hit on a step the pattern plays, 1 for the rest): above 80 they don't play and
  // the free roll in _render takes over, the first free hit after a roll-2 hit taking its accent
  scheduleRush(s, bar, pg, P, at0, len, hits) {
    const rt = this.rushT; // (the track the rush rolls on: the snare unless set)
    const { on, acc, bar: cond } = P, G = this.groove, R = this.rush, S = this.rs;
    const p = Math.pow(Math.min(1, R / S.only), 2.5), pHat = Math.pow(Math.min(1, R / S.hats), 2.5);
    let snare = R > S.start, sAcc = false, orig = false;
    for (let t = 0; t < 7; t++) {
      if (!on[t][s] || !barOk(cond[t][s], bar)) continue;
      orig = true;
      const down = !t && !(s & 3);
      if (down && (R >= S.first || (R >= S.kicks && s))) continue; // the roll covers the step
      if (t === rt || (!down && rushHash(t, pg, s) < (t >= 5 ? pHat : p))) { snare = true; sAcc = sAcc || !!acc[t][s]; continue; } // a muted drum is still taken
      if (this.muted[Math.min(t, 5)]) continue;
      this.queue.push({ at: Math.max(0, at0 + G.off[t][s] * len), t, acc: !!acc[t][s] });
      hits.push(t);
    }
    if (snare && !this.muted[Math.min(rt, 5)]) {
      const n = R > (S.start + S.p32) / 2 ? 2 : 1, at = R > S.start ? at0 : at0 + G.off[rt][s] * len;
      const sw = R > S.start ? 0.6 + 0.4 * (R - S.start) / (100 - S.start) : 1;
      for (let i = 0; i < n; i++) {
        const first = !i && orig;
        this.queue.push({ at: Math.max(0, at + i * len / n), t: rt, acc: first && sAcc, sw, roll: R > S.start ? (first ? 2 : 1) : 0 });
      }
      hits.push(3);
    }
    this.sched[s] = hits;
  }
  // the spacer: each band's peak in the key, followed, sets that band's cut in the left and right of the others
  spacer(key, XL, XR) {
    const FS = LXR.REAL_FS, cut = this.master.space / 100 * 0.9, k = 1 / 1.4, S = this.spS;
    const att = 1 - Math.exp(-64 / (0.003 * FS)), rel = Math.exp(-64000 / (this.master.duckRelease * FS));
    for (let b = 0; b < 8; b++) {
      const g = this.spF[b], a = 1 / (1 + g * (g + k)), o = b * 6;
      // TPT state-variable band-pass (unity at the centre: k times bp); states o, o+1 the key, o+2.. the left and right
      let pk = 0, s1 = S[o], s2 = S[o + 1];
      for (let i = 0; i < 64; i++) {
        const hp = (key[i] - (g + k) * s1 - s2) * a, bp = g * hp + s1;
        s1 = g * hp + bp; s2 += 2 * g * bp;
        const m = bp < 0 ? -bp : bp; if (m > pk) pk = m;
      }
      S[o] = s1; S[o + 1] = s2;
      pk *= k;
      const e = this.spEnv[b] = pk > this.spEnv[b] ? this.spEnv[b] + (pk - this.spEnv[b]) * att : this.spEnv[b] * rel;
      // full cut once drum 1's band reaches about -28 dBFS; the gain ramps across the block
      const g0 = this.spG[b], g1 = 1 - cut * Math.min(1, e / 0.04);
      this.spG[b] = g1;
      if (g0 === 1 && g1 === 1) { // nothing to cut: keep the filters running so a cut starts clean
        for (let c = 0; c < 2; c++) {
          const X = c ? XR : XL; let t1 = S[o + 2 + 2 * c], t2 = S[o + 3 + 2 * c];
          for (let i = 0; i < 64; i++) { const hp = (X[i] - (g + k) * t1 - t2) * a, bp = g * hp + t1; t1 = g * hp + bp; t2 += 2 * g * bp; }
          S[o + 2 + 2 * c] = t1; S[o + 3 + 2 * c] = t2;
        }
        continue;
      }
      for (let c = 0; c < 2; c++) {
        const X = c ? XR : XL; let t1 = S[o + 2 + 2 * c], t2 = S[o + 3 + 2 * c];
        for (let i = 0; i < 64; i++) {
          const hp = (X[i] - (g + k) * t1 - t2) * a, bp = g * hp + t1;
          t1 = g * hp + bp; t2 += 2 * g * bp;
          X[i] += (g0 + (g1 - g0) * (i + 1) / 64 - 1) * bp * k;
        }
        S[o + 2 + 2 * c] = t1; S[o + 3 + 2 * c] = t2;
      }
    }
  }
  // ---- the TR-808 voices ----
  // messages from app/tr808.js: map808 (each track's 808 voice id, or null for its LXR voice), set808 (a knob, 0..1),
  // model808 ('circuit' or 'cached'), cache808 (a voice's cached hits: info and 16-bit PCM)
  msg808(m) {
    if (!this.k808) {
      if (typeof TR808 === 'undefined') return;
      this.k808 = new TR808.Kit(LXR.REAL_FS); this.k808.setAllModels('cached'); this.k808.master = 1;
      for (const [id] of TR808.VOICES) {
        this.b808[id] = new Float32Array(64); this.vbuf[id] = new Float32Array(64); this.vpk[id] = 0;
        this.vmix[id] ??= { vol: 1, pl: Math.sqrt(64 / 127), pr: Math.sqrt(63 / 127), echo: 0, verb: 0 };
      }
      this.k808.split = this.b808; this.mix808 = new Float32Array(64);
    }
    const K = this.k808;
    if (m.type === 'map808') this.t808 = m.map.slice(0, 7);
    // the grid's lanes, one an 808 voice ({ id: { on: [64], acc: [64] } }, pages: its bars), which play instead of the tracks' pattern; null: the tracks
    else if (m.type === 'lanes808') { this.lanes = m.lanes; this.lanePages = Math.max(1, Math.min(4, m.pages || 1)); }
    // a tap on a voice's name on the 808 page: play it now
    else if (m.type === 'hit808') { const t = this.t808.includes(m.id) ? this.t808.indexOf(m.id) : BUS808[m.id] ?? 3; this.hit(t, 127, m.acc, m.id); this.gainTo[Math.min(t, 5)] = 1; }
    else if (m.type === 'set808') K.set(m.id, m.param, m.value);
    else if (m.type === 'vmix808') this.vmix[m.id] = { vol: m.vol / 127, pl: Math.sqrt((127 - m.pan) / 127), pr: Math.sqrt(m.pan / 127), echo: m.echo / 100, verb: m.verb / 100 };
    else if (m.type === 'model808') { this.want808[m.id] = m.model; K.setModel(m.id, m.model); }
    else if (m.type === 'cache808') { K.loadCache(m.id, m.info, new Int16Array(m.pcm)); K.setModel(m.id, this.want808[m.id] || 'cached'); }
  }
  // a hit on track t: its 808 voice, accented or not (Elixir 808 plays no LXR voices). (The 808 voice takes the accent in
  // its circuit, as the TR-808 does, so the accent fader's turn-down of unaccented hits skips it)
  hit(t, vel, acc, lane) {
    const id = this.k808 && (lane || this.t808[t]);
    if (!id) return;
    // a voice set to cached whose hits are still loading stays silent (rather than playing the synth model meanwhile)
    if ((this.want808[id] || 'cached') === 'cached' && this.k808.model[id] !== 'cached') return;
    this.k808._fire(id, acc ? 1 : 0);
    // the 808 voice takes the track's pan as the LXR voice would on its trigger
    const e = this.e, v = [e.drums[0], e.drums[1], e.drums[2], e.snare, e.cymbal, e.hat][Math.min(t, 5)];
    v.triggeredPanL = Math.fround(Math.sqrt(Math.fround((127 - v.pan) / 127)));
    v.triggeredPanR = Math.fround(Math.sqrt(Math.fround(v.pan / 127)));
  }
  // each 808 sound renders on its own (kit.split), at its own level, into vbuf (int16 scale); the engine's channels stay
  // silent (no LXR voices) and _render mixes the sounds itself: each at its own pan and sends, ducked (all but the kick)
  // and turned down with its track (sw, the rush's swell; its channel for the meters and mutes)
  render808(out) {
    const K = this.k808, B = this.b808, V = this.vbuf;
    for (const id in B) B[id].fill(0);
    for (let c = 0; c < 6; c++) out[c].fill(0);
    K.render(this.mix808, 64);
    const g = TR808.VOLT_SCALE * G808 * 32768;
    for (const id in B) {
      const b = B[id], v = V[id], gv = g * this.vmix[id].vol;
      let pk = 0;
      for (let i = 0; i < 64; i++) { const x = b[i] * gv; v[i] = x; const a = x < 0 ? -x : x; if (a > pk) pk = a; }
      this.vpk[id] = pk;
    }
  }
  // a sound's track: the grid's lanes put each on its own (BUS808), the generator's tracks one each
  track808(id) { return !this.lanes && this.t808.includes(id) ? this.t808.indexOf(id) : BUS808[id]; }
  clickAt(hi) { this.clk = { n: 0, ph: 0, w: 2 * Math.PI * (hi ? 1760 : 880) / LXR.REAL_FS }; }
  _render(dst) {
    const rc = this.rec;
    if (!this.playing && rc && rc.count === 'run') {
      // a count-in from stop keeps its own time, then starts the transport at bar 1 for the take
      const len = LXR.REAL_FS * 60 / this.bpm / 4;
      while (this.toNext <= 0 && !this.playing) {
        if (this.cntStep === 16) {
          rc.count = 'end'; this.playing = true; this.step = 0; this.bar = 0; this.queue = []; this.fresh = true;
          this.events.push({ type: 'rec', state: 'play' });
        } else { if (this.cntStep % 4 === 0) this.clickAt(this.cntStep === 0); this.cntStep++; this.toNext += len; }
      }
      if (!this.playing) this.toNext -= 64;
    }
    if (this.playing) {
      if (this.toNext <= 0) {
        if (this.step === 0 && this.atBar.length) this.flushBar();
        if (this.step === 0 && this.rec) {
          // a count-in takes the bar before; then a loop (or a counted free take) starts on this one
          const r = this.rec;
          if (r.count === 'wait') { r.count = 'run'; this.events.push({ type: 'rec', state: 'count' }); }
          else if (!r.on) { r.on = true; r.count = null; this.events.push({ type: 'rec', state: 'on' }); }
          else if (!r.loop) r.done++;
          else if (++r.done >= r.bars) this.recEnd();
          if (this.rec && r.loop && r.on) this.events.push({ type: 'rec', state: 'bar', done: r.done });
        }
        if (this.rec && this.rec.count === 'run' && this.step % 4 === 0) this.clickAt(this.step === 0);
        const len = LXR.REAL_FS * 60 / this.bpm / 4;
        // on starting, this step's own hits; after that each tick books the next step's, a step ahead,
        // so a track pushed early can still come in before its grid time
        if (this.fresh) { this.fresh = false; this.schedule(this.step, this.bar, this.toNext); }
        const next = (this.step + 1) % 16;
        this.schedule(next, next === 0 ? this.bar + 1 : this.bar, this.toNext + len);
        this.events.push({ type: 'step', step: this.step, bar: this.bar, hits: this.sched[this.step] || [], gr: this.gr, duck: this.duckMin });
        this.sched[this.step] = [];
        this.gr = 0; this.duckMin = 1;
        this.step = next;
        if (this.step === 0) this.bar++;
        this.toNext += len;
      }
      this.toNext -= 64;
    } else if (this.queue.length) this.queue = [];
    // the free roll above the 1/32 point (80): 2 hits a step (32nds) there up to 16 (256ths, the top speed) at 100, tempo-relative, each where the phase
    // crosses a whole number; the rate glides toward the fader's in log2 with a 40 ms time constant, and never puts hits
    // closer than 256 samples (4 blocks), so at fast tempos the top speed is held back rather than smeared by the blocks
    const S = this.rs;
    if (this.playing && this.patternOn && this.rush > S.p32) {
      const len = LXR.REAL_FS * 60 / this.bpm / 4, target = Math.min(1 + (this.rush - S.p32) * (S.top - 1) / (100 - S.p32), Math.log2(len / 256));
      // it starts in step with the 32nd roll it takes over from (the next step starts toNext + 64 samples from this block)
      if (this.rushPh === null) { this.rushLog = target; this.rushPh = (2 * (1 - (this.toNext + 64) / len)) % 1; }
      else this.rushLog += (target - this.rushLog) * (1 - Math.exp(-64 / (S.rollMs / 1000 * LXR.REAL_FS)));
      const rate = Math.min(Math.pow(2, this.rushLog), len / 256), d = rate * 64 / len;
      const sw = 0.6 + 0.4 * (this.rush - S.start) / (100 - S.start);
      for (let k = Math.floor(this.rushPh) + 1; k <= this.rushPh + d; k++) {
        const h = this.rushHead; this.rushHead = null;
        this.queue.push({ at: (k - this.rushPh) / d * 64, t: this.rushT, acc: !!h && h.acc, sw, free: true });
      }
      this.rushPh = (this.rushPh + d) % 1; this.rushGap = len / rate / 2;
    } else { this.rushPh = null; this.rushHead = null; }
    // hits due in this block
    if (this.queue.length) {
      const keep = [];
      for (const q of this.queue) {
        // a voice muted after its step was booked is skipped too; above 80 the grid roll gives way to the free one, and
        // no snare plays within half a free-roll gap of the last
        if (q.at < 64 && this.rush > S.p32 && (q.roll || q.free) && (q.roll || this.clock - this.snareAt < this.rushGap)) { if (q.roll === 2) this.rushHead = q; }
        else if (q.at < 64) { if (q.t === this.rushT) this.snareAt = this.clock; if (!this.muted[Math.min(q.t, 5)]) { const sw = q.sw || 1; this.hit(q.t, q.acc ? 127 : Math.max(1, Math.round(this.vel * sw)), q.acc, q.lane); this.gainTo[Math.min(q.t, 5)] = q.acc ? 1 : this.k808 && (q.lane || this.t808[q.t]) ? sw : this.accGain * sw; } }
        else { q.at -= 64; keep.push(q); }
      }
      this.queue = keep;
    }
    this.clock += 64;
    const out = this.e.renderBlock(), e = this.e;
    if (this.k808) this.render808(out); else for (let c = 0; c < 6; c++) out[c].fill(0);
    const pans = [e.drums[0], e.drums[1], e.drums[2], e.snare, e.cymbal, e.hat];
    const [L, R] = dst;
    L.fill(0); R.fill(0);
    // sidechain: follow drum 1's level (instant attack, set release) and turn the rest down
    const M = this.master, k = out[0];
    const isDelay = e.fx.fxType === LXR.FX_DELAY;
    e.fx.forceWet = isDelay;
    const eTime = this.echoSync ? delaySamples(this.delayPos, this.bpm) : (1 + 1999 * this.echoFree) / 1000 * LXR.REAL_FS;
    e.fx.setDelaySync(isDelay ? eTime * (1 + this.echoFine / 10000) : null);
    let pk = 0;
    if (this.k808) pk = this.vpk.bd * this.gainTo[this.track808('bd')]; // (the kick keys it)
    else for (let i = 0; i < 64; i++) pk = Math.max(pk, Math.abs(k[i]));
    pk = pk / 32768 * (this.k808 ? 1 : this.gainTo[0]);
    this.duckEnv = Math.max(pk, this.duckEnv * Math.exp(-64000 / (M.duckRelease * LXR.REAL_FS)));
    const duck0 = this.duckAt, duck1 = 1 - (M.duckOn ? M.duck : 0) * Math.min(1, this.duckEnv / 0.3);
    this.duckAt = duck1; this.duckMin = Math.min(this.duckMin, duck1);
    // with the spacer on, the other voices mix apart from drum 1 first, so it can cut them
    const sp = M.duckOn && M.space > 0, XL = sp ? this.spL : L, XR = sp ? this.spR : R;
    if (sp) { XL.fill(0); XR.fill(0); } else if (this.spOn) { this.spS.fill(0); this.spEnv.fill(0); this.spG.fill(1); }
    this.spOn = sp;
    for (let n = 0; n < 6; n++) {
      // accent gain, ramped over the block, and the duck on every voice but drum 1
      const d0 = n ? duck0 : 1, d1 = n ? duck1 : 1;
      const g0 = this.gain[n] * d0, g1 = this.gainTo[n] * d1, dg = (g1 - g0) / 64;
      // every voice reaches the outputs; one routed to the echo bus also feeds it at its send
      const fa = e.audioRouting[n] === LXR.MIXER_ROUTING_FX_BUS ? this.fxAmt[n] : 0;
      const pl = pans[n].triggeredPanL / 32768, pr = pans[n].triggeredPanR / 32768;
      const o = out[n];
      let lv = 0;
      const OL = n ? XL : L, OR = n ? XR : R;
      for (let i = 0; i < 64; i++) { const v = o[i] * (g0 + dg * i); OL[i] += v * pl; OR[i] += v * pr; const a = v < 0 ? -v : v; if (a > lv) lv = a; }
      lv *= Math.max(pl, pr); if (lv > this.lvl[n]) this.lvl[n] = lv;
      this.fxGain[n] = g1 * fa;
      this.gain[n] = this.gainTo[n];
    }
    // the 808 sounds: each at its pan into the mix (the kick with drum 1, the rest ducked) and its echo send
    const fe = this.k808 ? this.fxExtra : null;
    if (fe) {
      fe.fill(0);
      for (const id in this.vbuf) {
        if (!this.vpk[id]) continue;
        const b = this.vbuf[id], M8 = this.vmix[id], t = this.track808(id), c = Math.min(t, 5), kick = id === 'bd';
        const a0 = this.gainTo[c] * (kick ? 1 : duck0), a1 = this.gainTo[c] * (kick ? 1 : duck1), da = (a1 - a0) / 64;
        const OL = kick ? L : XL, OR = kick ? R : XR, pl = M8.pl / 32768, pr = M8.pr / 32768, el = M8.pl * M8.echo, er = M8.pr * M8.echo;
        let lv = 0;
        for (let i = 0; i < 64; i++) {
          const v = b[i] * (a0 + da * i); OL[i] += v * pl; OR[i] += v * pr;
          if (el + er) { fe[2 * i] += v * el; fe[2 * i + 1] += v * er; }
          const a = v < 0 ? -v : v; if (a > lv) lv = a;
        }
        lv *= Math.max(pl, pr); if (lv > this.lvl[c]) this.lvl[c] = lv;
        if (lv > (this.vlv[id] || 0)) this.vlv[id] = lv;
      }
    }
    if (sp) {
      // L and R hold drum 1 alone here: its mono is the key
      const key = this.spKey;
      for (let i = 0; i < 64; i++) key[i] = (L[i] + R[i]) / 2;
      this.spacer(key, XL, XR);
      for (let i = 0; i < 64; i++) { L[i] += XL[i]; R[i] += XR[i]; }
    }
    if (++this.lvlN >= 16) {
      this.lvlN = 0;
      const on = this.lvl.some((v) => v > 1e-4);
      if (on || this.lvlOn) this.events.push({ type: 'lvl', l: Array.from(this.lvl), v: { ...this.vlv } });
      this.lvlOn = on; this.lvl.fill(0); for (const id in this.vlv) this.vlv[id] = 0;
    }
    // the firmware's FX bus (distortion, ring mod, compressor or delay), sample-exact
    const fx = e.renderFx(this.fxGain, this.echoWidth, fe);
    // with duck fx on, the three FX returns are ducked too (all of them, drum 1's sends included), ramped over the block
    const fd0 = M.duckFx ? duck0 : 1, fdd = M.duckFx ? (duck1 - duck0) / 64 : 0;
    // the reverb's bus: each voice panned in at its send
    for (const [bus, sends, mk] of [[this.verb, this.sendR, VERB_MAKEUP]]) {
      const bi = this.busIn; bi.fill(0);
      let any = false;
      for (let n = 0; n < 6; n++) {
        const g = sends[n] * this.gainTo[n] * (n ? duck1 : 1);
        if (!g) continue;
        any = true;
        const o = out[n], pl = pans[n].triggeredPanL * g, pr = pans[n].triggeredPanR * g;
        for (let i = 0; i < 64; i++) { bi[2 * i] += o[i] * pl; bi[2 * i + 1] += o[i] * pr; }
      }
      // (and each 808 sound at its reverb send)
      if (this.k808) for (const id in this.vbuf) {
        const M8 = this.vmix[id]; if (!M8.verb || !this.vpk[id]) continue;
        any = true;
        const b = this.vbuf[id], g = M8.verb * this.gainTo[Math.min(this.track808(id), 5)] * (id === 'bd' ? 1 : duck1), pl = M8.pl * g, pr = M8.pr * g;
        for (let i = 0; i < 64; i++) { bi[2 * i] += b[i] * pl; bi[2 * i + 1] += b[i] * pr; }
      }
      // the convolution reverb takes the bus in mono (as the firmware's reverb did) and adds its stereo wet into the mix
      const vi = this.verbIn;
      if (any) for (let i = 0; i < 64; i++) vi[i] = (bi[2 * i] + bi[2 * i + 1]) / 65536; else vi.fill(0);
      bus.bpm = this.bpm; bus.process(vi, L, R, mk * fd0, mk * (fd0 + fdd * 64));
    }
    for (let i = 0; i < 64; i++) { const g = (fd0 + fdd * i) / 32768; L[i] += fx[2 * i] * g; R[i] += fx[2 * i + 1] * g; }
    // the distortion, a master insert (not in the firmware's routing): the whole mix through the firmware's distortion,
    // blended in at its mix amount, ramped across the block, before the high-pass and the compressor; at 0 it's bypassed
    if (this.distMix || this.distAt) {
      const bi = this.dist.input;
      for (let i = 0; i < 64; i++) { bi[2 * i] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32768))); bi[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32768))); }
      const bo = this.busOut; bo.fill(0);
      this.dist.process(bo, 64, this.fxRng);
      const m0 = this.distAt, m1 = this.distMix;
      for (let i = 0; i < 64; i++) { const m = m0 + (m1 - m0) * (i + 1) / 64; L[i] += (bo[2 * i] / 32768 - L[i]) * m; R[i] += (bo[2 * i + 1] / 32768 - R[i]) * m; }
      this.distAt = m1;
    }
    if (this.rush > S.hp || this.hpOn) this.highPass(L, R);
    if (M.comp) {
      // peak detector in dB, attack/release smoothing, gain = over * (1/ratio - 1) + makeup
      const ca = Math.exp(-1000 / (M.attack * LXR.REAL_FS)), cr = Math.exp(-1000 / (M.release * LXR.REAL_FS));
      const slope = 1 / M.ratio - 1, mk = Math.pow(10, M.makeup / 20);
      let env = this.compEnv, gr = this.gr;
      for (let i = 0; i < 64; i++) {
        const peak = Math.max(Math.abs(L[i]), Math.abs(R[i])) + 1e-9;
        const over = Math.max(0, 20 * Math.log10(peak) - M.thresh);
        env = over + (over > env ? ca : cr) * (env - over);
        const g = Math.pow(10, env * slope / 20) * mk;
        L[i] *= g; R[i] *= g;
        gr = Math.max(gr, -env * slope);
      }
      this.compEnv = env; this.gr = gr;
    }
    // the recorder takes the finished mix at the engine's own rate
    const r = this.rec;
    if (r && r.on) { r.L.set(L, r.n); r.R.set(R, r.n); r.n += 64; if (r.n === r.L.length) this.recFlush(); }
    // the count-in is after the recorder, so neither its beeps nor the turned-down mix are in the take
    const to = r && r.count === 'run' ? 0.25 : 1;
    if (to !== 1 || this.cntGain !== 1 || this.clk) {
      let g = this.cntGain;
      for (let i = 0; i < 64; i++) {
        g += (to - g) * 0.003; if (Math.abs(to - g) < 1e-4) g = to;
        let c = 0, k = this.clk;
        if (k) {
          c = 0.35 * Math.sin(k.ph) * Math.min(1, k.n / 48) * Math.exp(-k.n / (0.04 * LXR.REAL_FS));
          k.ph += k.w; if (++k.n > 0.15 * LXR.REAL_FS) this.clk = k = null;
        }
        L[i] = L[i] * g + c; R[i] = R[i] * g + c;
      }
      this.cntGain = g;
    }
  }
  // the rush high-pass: a 12 dB/oct state-variable filter (TPT, Q 0.9) on both channels. Its cutoff glides in log Hz
  // from 30 Hz at the filter start (90) to the top cutoff (1.5 kHz) at 100, with a 40 ms time constant (the defaults; set in
  // the rush settings), ramped across each block; it fades in over about 10 ms when rush goes over the start, and once
  // rush is back at the start or under and the cutoff has settled at 30 Hz it
  // fades out, then turns off and clears its state
  highPass(L, R) {
    const FS = LXR.REAL_FS, rs = this.rs, lo = Math.log(30), up = this.rush > rs.hp;
    const target = up ? lo + Math.log(rs.hpTop / 30) * Math.min(1, (this.rush - rs.hp) / (100 - rs.hp)) : lo;
    if (!this.hpOn) { this.hpOn = true; this.hpLog = lo; this.hpMix = 0; this.hpS.fill(0); this.hpG = Math.tan(Math.PI * 30 / FS); }
    this.hpLog += (target - this.hpLog) * (1 - Math.exp(-64 / (rs.hpMs / 1000 * FS)));
    if (!up && this.hpLog - lo < 0.01) this.hpLog = lo;
    const g0 = this.hpG, g1 = Math.tan(Math.PI * Math.exp(this.hpLog) / FS), k = 1 / 0.9, S = this.hpS;
    const m0 = this.hpMix, m1 = up || this.hpLog > lo ? Math.min(1, m0 + 0.15) : Math.max(0, m0 - 0.15);
    for (let i = 0; i < 64; i++) {
      const g = g0 + (g1 - g0) * (i + 1) / 64, a = 1 / (1 + g * (g + k)), m = m0 + (m1 - m0) * (i + 1) / 64;
      for (let c = 0; c < 2; c++) {
        const X = c ? R : L, x = X[i], s1 = S[2 * c], s2 = S[2 * c + 1];
        const hp = (x - (g + k) * s1 - s2) * a, bp = g * hp + s1, lp = g * bp + s2;
        S[2 * c] = g * hp + bp; S[2 * c + 1] = g * bp + lp;
        X[i] = x + (hp - x) * m;
      }
    }
    this.hpG = g1; this.hpMix = m1;
    if (!m1 && !up) { this.hpOn = false; this.hpS.fill(0); }
  }
  process(L, R) {
    for (let n = 0; n < L.length; n++) {
      while (this.idx >= 64) {
        const t = this.A; this.A = this.B; this.B = t;
        this._render(this.B);
        this.idx -= 64;
      }
      const i = this.idx, fr = this.frac;
      const l0 = this.A[0][i], r0 = this.A[1][i];
      const l1 = i < 63 ? this.A[0][i + 1] : this.B[0][0];
      const r1 = i < 63 ? this.A[1][i + 1] : this.B[1][0];
      L[n] = l0 + (l1 - l0) * fr;
      R[n] = r0 + (r1 - r0) * fr;
      this.frac += this.ratio;
      const k = Math.floor(this.frac);
      this.idx += k; this.frac -= k;
    }
  }
}
