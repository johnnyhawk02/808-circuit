// Small modified-nodal-analysis circuit simulator for component-level voices.
//
// Each sample: capacitors become trapezoidal companion models, then Newton-
// Raphson solves the nonlinear node equations with a dense LU:
//   Shockley diodes, Ebers-Moll NPN/PNP transistors, op-amps (finite gain,
//   soft saturation near the rails).
// Fast switching parts whose state can lag by one sample without audible
// effect (comparators, Schmitt gates, the JFET mute switch, the OTA) are
// "explicit" elements: a conductance and/or current that the voice updates
// from the previous sample's node voltages.
// Node index -1 is ground. Supplies are resistors to fixed voltages.

const VT = 0.02585; // thermal voltage at ~27 C
const GMIN = 1e-9;
// device freezing thresholds (see _wake / _maybeFreeze)
const FREEZE_V = -0.1, WAKE_V = 0.3, CALM = 48;
// op-amp output law: linear up to KNEE*vsat, then a tanh knee into vsat
const KNEE = 0.8;
let CLIP_SLOPE = 1;
function clipOut(x, vsat) {
  const xl = KNEE * vsat, ax = Math.abs(x);
  if (ax <= xl) { CLIP_SLOPE = 1; return x; }
  const w = vsat - xl, t = Math.tanh((ax - xl) / w);
  CLIP_SLOPE = 1 - t * t;
  return Math.sign(x) * (xl + w * t);
}  // S across every junction, as in SPICE (1 nA per volt)

// linearisation error of an exponential junction after a step dv, as an
// equivalent voltage: nVt (e^u - 1 - u), u = dv / nVt
const OLD_CONV = !!globalThis.MNA_OLD_CONV;
function linErr(dv, nvt) {
  const u = dv / nvt;
  if (u > -0.5 && u < 0.5) return Math.abs(nvt * u * u * (0.5 + u * (1 / 6 + u * (1 / 24 + u / 120))));
  return Math.abs(nvt * (Math.exp(Math.min(u, 80)) - 1 - u));
}

function pnjlim(vnew, vold, vt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(vnew / vt);
    }
  }
  return vnew;
}

// Part models used across the kit (datasheet-typical values).
export const PARTS = {
  // 2SC945 / 2SC1815 small-signal NPN, 2SA733 PNP (manual p.8 note)
  npn: { Is: 2e-14, bf: 250, br: 3 },
  pnp: { Is: 2e-14, bf: 200, br: 3 },
  // 1S2473 / 1S1588 switching diode
  diode: { Is: 2.52e-9, n: 1.752 },
  // uPC4558C op-amp on +-15 V
  opamp: { A: 2e4, ro: 75, vsat: 13.5, gbw: 3e6 },
};

export class Circuit {
  constructor(nodeNames) {
    this.names = nodeNames;
    this.n = nodeNames.length;
    this.idx = Object.fromEntries(nodeNames.map((s, i) => [s, i]));
    this.res = []; this.caps = []; this.diodes = []; this.bjts = []; this.opamps = []; this.srcs = [];
    this.dyn = []; // explicit conductances / currents
    this.v = new Float64Array(this.n);
    const n = this.n;
    this.A = new Float64Array(n * n);
    this.base = new Float64Array(n * n);
    this.b = new Float64Array(n);
    this.bBase = new Float64Array(n);
    this.x = new Float64Array(n);
    this.cols = new Int32Array(n);
    this.dirty = true;
    this.iters = 0;
    this.tol = 1e-5; // V; stages driven by noise can use a looser value
    this.freezing = true;
  }
  node(name) {
    if (name === 'gnd') return -1;
    const i = this.idx[name];
    if (i === undefined) throw new Error(`unknown node ${name}`);
    return i;
  }
  V(name) { const i = this.node(name); return i < 0 ? 0 : this.v[i]; }

  // ---- elements (each returns a handle so values can change later)
  R(a, b, ohms) { const e = { a: this.node(a), b: this.node(b), g: 1 / ohms }; this.res.push(e); return e; }
  // resistor from node a to a fixed voltage (supply rail or a low-impedance source)
  Rsrc(a, ohms, volts) { const e = { a: this.node(a), g: 1 / ohms, v: volts, on: true }; this.srcs.push(e); return e; }
  C(a, b, farads) { const e = { a: this.node(a), b: this.node(b), c: farads, i: 0, vPrev: 0 }; this.caps.push(e); return e; }
  D(anode, cathode, { Is, n } = PARTS.diode) {
    const nvt = n * VT;
    const e = { a: this.node(anode), k: this.node(cathode), Is, nvt, vcrit: nvt * Math.log(nvt / (Math.SQRT2 * Is)), vd: 0, gd: 1 };
    this.diodes.push(e);
    this.R(anode, cathode, 1 / GMIN); // gmin: keeps nodes behind off junctions well defined
    return e;
  }
  NPN(b, c, e, m = PARTS.npn) { return this._bjt(b, c, e, m, 1); }
  PNP(b, c, e, m = PARTS.pnp) { return this._bjt(b, c, e, m, -1); }
  _bjt(b, c, e, { Is, bf, br }, pol) {
    const q = { b: this.node(b), c: this.node(c), e: this.node(e), Is, bf, br, pol,
      vcrit: VT * Math.log(VT / (Math.SQRT2 * Is)), vbe: 0, vbc: 0, gf: 1, gr: 1 };
    this.bjts.push(q);
    this.R(b, e, 1 / GMIN); this.R(b, c, 1 / GMIN);
    return q;
  }
  OpAmp(plus, minus, out, m = PARTS.opamp) {
    const o = { p: this.node(plus), m: this.node(minus), o: this.node(out), A: m.A, g: 1 / m.ro, vsat: m.vsat, wp: 2 * Math.PI * m.gbw / m.A, dl: 0, f: 0, fp: 0, xPrev: 0, x0: 0, Ae: m.A, a: 1, lin: true, calm: 0 };
    this.opamps.push(o); return o;
  }
  // explicit element: conductance g between a and b (b may be a fixed
  // voltage `vb` when b === null), plus current i injected into a.
  Dyn(a, b = null, vb = 0) {
    const e = { a: this.node(a), b: b === null ? -1 : this.node(b), fixed: b === null, vb, g: 0, i: 0 };
    this.dyn.push(e); return e;
  }

  setTimestep(dt) { this.dt = dt; this.dirty = true; }
  touch() { this.dirty = true; }

  // Nodes touched by nonlinear or explicit elements. Only these change
  // between Newton iterations, so the linear part is factored once and each
  // iteration solves a small k x k system (Woodbury / compensation method).
  _buildK() {
    const set = new Set(), add = (i) => { if (i >= 0) set.add(i); };
    for (const d of this.diodes) if (!d.frozen) { add(d.a); add(d.k); }
    for (const q of this.bjts) if (!q.frozen) { add(q.b); add(q.c); add(q.e); }
    for (const o of this.opamps) if (!o.lin) { add(o.p); add(o.m); add(o.o); }
    for (const d of this.dyn) { add(d.a); if (!d.fixed) add(d.b); }
    const K = [...set].sort((x, y) => x - y), k = K.length, loc = new Int32Array(this.n).fill(-1);
    K.forEach((g, i) => { loc[g] = i; });
    const L = (i) => (i >= 0 ? loc[i] : -1);
    for (const d of this.diodes) { d.la = L(d.a); d.lk = L(d.k); }
    for (const q of this.bjts) { q.lb = L(q.b); q.lc = L(q.c); q.le = L(q.e); }
    for (const o of this.opamps) { o.lp = L(o.p); o.lm = L(o.m); o.lo = L(o.o); }
    for (const d of this.dyn) { d.la = L(d.a); d.lb = d.fixed ? -1 : L(d.b); }
    // sparsity pattern of the device stamps (local row, local column)
    const pat = new Set(), pr = (r, cs) => { if (r < 0) return; for (const c of cs) if (c >= 0) pat.add(r * k + c); };
    for (const d of this.diodes) if (!d.frozen) { pr(d.la, [d.la, d.lk]); pr(d.lk, [d.la, d.lk]); }
    for (const q of this.bjts) if (!q.frozen) for (const r of [q.lb, q.lc, q.le]) pr(r, [q.lb, q.lc, q.le]);
    for (const o of this.opamps) if (!o.lin) pr(o.lo, [o.lo, o.lp, o.lm]);
    for (const d of this.dyn) { pr(d.la, [d.la, d.lb]); pr(d.lb, [d.la, d.lb]); }
    const P = [...pat].sort((x, y) => x - y);
    this.patIdx = Int32Array.from(P);                   // index into the k x k N
    this.patRow = Int32Array.from(P, (x) => Math.floor(x / k));
    this.patCol = Int32Array.from(P, (x) => x % k);
    this.K = Int32Array.from(K); this.k = k; this.nDev = this.diodes.length + this.bjts.length + this.opamps.length + this.dyn.length;
    this.Z = new Float64Array(this.n * k);      // G^-1 restricted to the K columns
    this.Zkk = new Float64Array(k * k);
    this.Nk = new Float64Array(k * k); this.rk = new Float64Array(k);
    this.Ak = new Float64Array(k * k); this.wk = new Float64Array(k); this.bk = new Float64Array(k);
    this.perm = new Int32Array(this.n); this.permK = new Int32Array(k);
    this.y = new Float64Array(this.n); this.e = new Float64Array(this.n);
    this.Gi = new Float64Array(this.n * this.n);       // G^-1, row major
  }

  _buildBase() {
    const n = this.n, M = this.base;
    if (!this.K || this.kDirty || this.nDev !== this.diodes.length + this.bjts.length + this.opamps.length + this.dyn.length) { this._buildK(); this.kDirty = false; }
    M.fill(0);
    const G = (a, b, g) => {
      if (a >= 0) M[a * n + a] += g;
      if (b >= 0) M[b * n + b] += g;
      if (a >= 0 && b >= 0) { M[a * n + b] -= g; M[b * n + a] -= g; }
    };
    for (const r of this.res) G(r.a, r.b, r.g);
    for (const s of this.srcs) if (s.on && s.a >= 0) M[s.a * n + s.a] += s.g;
    // op-amps in their linear region are linear elements: out = x0 + Ae*vd
    for (const o of this.opamps) {
      const a = o.wp * this.dt; o.Ae = (o.A * a) / (1 + a); o.a = a;
      if (!o.lin || o.o < 0) continue;
      const r = o.o * n;
      M[r + o.o] += o.g;
      if (o.p >= 0) M[r + o.p] -= o.g * o.Ae;
      if (o.m >= 0) M[r + o.m] += o.g * o.Ae;
    }
    // Trapezoidal companions, except for capacitors that are stiff at this
    // timestep (the resistance they see, R_th, gives R_th*C < dt/4, e.g. an
    // emitter bypass cap across 100 R): trapezoidal makes those ring at
    // Nyquist, so they use backward Euler. R_th comes from the factored
    // linear network with every capacitor in place.
    for (const c of this.caps) { c.be = false; c.geq = (2 * c.c) / this.dt; G(c.a, c.b, c.geq); }
    for (let i = 0; i < n; i++) if (M[i * n + i] === 0) M[i * n + i] = GMIN;
    this.A.set(M); this._factor(this.A, this.perm, n);
    const e = this.e, y = this.y;
    let anyBE = false;
    for (const c of this.caps) {
      e.fill(0); if (c.a >= 0) e[c.a] = 1; if (c.b >= 0) e[c.b] = -1;
      this._lusolve(this.A, this.perm, n, e, y);
      const rpar = (c.a >= 0 ? y[c.a] : 0) - (c.b >= 0 ? y[c.b] : 0);
      const gth = 1 / rpar - c.geq;                 // remove the cap itself
      // a capacitor straight from an op-amp output to its own (-) input is
      // inside an algebraic loop: trapezoidal can lock into a Nyquist limit
      // cycle once the op-amp clips, so it is integrated with backward Euler
      const fb = this.opamps.some((o) => (o.o === c.a && o.m === c.b) || (o.o === c.b && o.m === c.a));
      if (fb || (gth > 0 && c.c / gth < this.dt / 4)) {
        c.be = true; anyBE = true;
        G(c.a, c.b, c.c / this.dt - c.geq); c.geq = c.c / this.dt;
      }
    }
    // a node with nothing linear on it (only junctions) gets gmin to ground
    for (let i = 0; i < n; i++) if (M[i * n + i] === 0) M[i * n + i] = GMIN;
    // factor G (LU in place in this.A, row permutation in perm)
    if (anyBE) { this.A.set(M); this._factor(this.A, this.perm, n); }
    // G^-1 explicitly (a matrix-vector product per sample is cheaper than
    // the two triangular solves), and Z = G^-1 [e_K1 .. e_Kk]
    const k = this.k, Z = this.Z, Gi = this.Gi;
    for (let j = 0; j < n; j++) {
      e.fill(0); e[j] = 1;
      this._lusolve(this.A, this.perm, n, e, y);
      for (let i = 0; i < n; i++) Gi[i * n + j] = y[i];
    }
    for (let j = 0; j < k; j++) { const g = this.K[j]; for (let i = 0; i < n; i++) Z[i * k + j] = Gi[i * n + g]; }
    for (let a = 0; a < k; a++) for (let j = 0; j < k; j++) this.Zkk[a * k + j] = Z[this.K[a] * k + j];
    this.dirty = false;
  }
  _vd(a, b) { const v = this.v; return (a >= 0 ? v[a] : 0) - (b >= 0 ? v[b] : 0); }

  // Advance one timestep. Returns true if Newton converged.
  step(maxIter = 30, tol = this.tol) {
    if (this.dirty) this._buildBase();
    const n = this.n, v = this.v, k = this.k, K = this.K;
    const rb = this.bBase; rb.fill(0);
    const S = this.srcs, Cs = this.caps, Dy = this.dyn, O = this.opamps;
    for (let i = 0; i < S.length; i++) { const s = S[i]; if (s.on && s.a >= 0) rb[s.a] += s.g * s.v; }
    for (let i = 0; i < Cs.length; i++) {
      const c = Cs[i];
      const ieq = (c.ieq = c.geq * c.vPrev + (c.be ? 0 : c.i)); // trapezoidal / backward Euler
      if (c.a >= 0) rb[c.a] += ieq;
      if (c.b >= 0) rb[c.b] -= ieq;
    }
    for (let i = 0; i < Dy.length; i++) {
      const d = Dy[i];
      if (d.a >= 0) rb[d.a] += d.i + (d.fixed ? d.g * d.vb : 0);
    }
    for (let i = 0; i < O.length; i++) {
      const o = O[i];
      o.x0 = o.xPrev / (1 + o.a);
      if (o.lin && o.o >= 0) rb[o.o] += o.g * o.x0;
    }
    let ok = true, it = 0;
    for (let pass = 0; pass < 4; pass++) {
      ok = this._newton(rb, maxIter, tol);
      it = this.itersN;
      // a device that was switched off (frozen) and is now being driven on
      // is put back into the Newton set and the step is solved again
      if (!this._wake() || pass === 3) break;
      this._buildBase();
    }
    this.iters = it + 1;
    for (let i = 0; i < O.length; i++) {
      const o = O[i];
      const x = o.x0 + o.Ae * ((o.p >= 0 ? v[o.p] : 0) - (o.m >= 0 ? v[o.m] : 0)), lim = 1.2 * o.vsat, ax = Math.abs(x);
      o.xPrev = x > lim ? lim : x < -lim ? -lim : x; // recovers from saturation within a sample or two
      // switch between the linear stamp and the clipping model
      if (o.lin) { if (ax > KNEE * o.vsat) { o.lin = false; o.calm = 0; this.kDirty = this.dirty = true; } }
      else if (ax < 0.6 * o.vsat) { if (++o.calm > 64) { o.lin = true; this.kDirty = this.dirty = true; } }
      else o.calm = 0;
    }
    for (let i = 0; i < Cs.length; i++) {
      const c = Cs[i];
      const vc = (c.a >= 0 ? v[c.a] : 0) - (c.b >= 0 ? v[c.b] : 0);
      c.i = c.geq * vc - c.ieq;
      c.vPrev = vc;
    }
    this._maybeFreeze();
    return ok;
  }

  _newton(rb, maxIter, tol) {
    const n = this.n, v = this.v, k = this.k, K = this.K;
    const y = this.y, Gi = this.Gi;
    // linear response y = G^-1 rb
    for (let i = 0, r = 0; i < n; i++, r += n) {
      let s = 0;
      for (let j = 0; j < n; j++) s += Gi[r + j] * rb[j];
      y[i] = s;
    }
    let ok = true, it = 0;
    const w = this.wk;
    if (k > 0) {
      ok = false;
      const N = this.Nk, r = this.rk, Ak = this.Ak, bk = this.bk, Zkk = this.Zkk;
      const pI = this.patIdx, pR = this.patRow, pC = this.patCol, np = pI.length, kk = k * k;
      for (; it < maxIter; it++) {
        for (let p = 0; p < np; p++) N[pI[p]] = 0;
        for (let a = 0; a < k; a++) r[a] = 0;
        this._stampDyn(N, k);
        this._stampNonlinear(N, r, k);
        // (I + N Zkk) w = r - N yK, over the nonzeros of N only
        for (let i = 0; i < kk; i++) Ak[i] = 0;
        for (let a = 0; a < k; a++) { Ak[a * k + a] = 1; bk[a] = r[a]; }
        for (let p = 0; p < np; p++) {
          const nm = N[pI[p]]; if (nm === 0) continue;
          const m = pC[p], row = pR[p] * k, zr = m * k;
          bk[pR[p]] -= nm * y[K[m]];
          for (let j = 0; j < k; j++) Ak[row + j] += nm * Zkk[zr + j];
        }
        this._factor(Ak, this.permK, k);
        this._lusolve(Ak, this.permK, k, bk, w);
        for (let a = 0; a < k; a++) {
          let s = y[K[a]];
          const zr = a * k;
          for (let j = 0; j < k; j++) s += Zkk[zr + j] * w[j];
          v[K[a]] = s;
        }
        if (this._linError() < tol) { ok = true; break; }
      }
      const Z = this.Z;
      for (let i = 0, zr = 0; i < n; i++, zr += k) {
        let s = y[i];
        for (let j = 0; j < k; j++) s += Z[zr + j] * w[j];
        v[i] = s;
      }
    } else v.set(y);
    this.itersN = it;
    return ok;
  }

  // Device freezing. A junction device that has been firmly off for a while
  // carries only leakage, so it is taken out of the Newton set (its gmin
  // resistors stay in the linear network). After each solve the frozen ones
  // are checked; one that would now conduct is put back and the step redone.
  _wake() {
    const v = this.v; let woke = false;
    for (const d of this.diodes) {
      if (!d.frozen) continue;
      const vd = (d.a >= 0 ? v[d.a] : 0) - (d.k >= 0 ? v[d.k] : 0);
      if (vd > WAKE_V) { d.frozen = false; d.calm = 0; d.vd = Math.min(vd, 0.5); woke = true; }
    }
    for (const q of this.bjts) {
      if (!q.frozen) continue;
      const vb = q.b >= 0 ? v[q.b] : 0;
      const vbe = q.pol * (vb - (q.e >= 0 ? v[q.e] : 0)), vbc = q.pol * (vb - (q.c >= 0 ? v[q.c] : 0));
      if (vbe > WAKE_V || vbc > WAKE_V) { q.frozen = false; q.calm = 0; q.vbe = Math.min(vbe, 0.5); q.vbc = Math.min(vbc, 0.5); woke = true; }
    }
    if (woke) this.kDirty = this.dirty = true;
    return woke;
  }
  _maybeFreeze() {
    if (!this.freezing) return;
    let froze = false;
    for (const d of this.diodes) {
      if (d.frozen) continue;
      if (d.vd < FREEZE_V) { if (++d.calm > CALM) { d.frozen = true; froze = true; } } else d.calm = 0;
    }
    for (const q of this.bjts) {
      if (q.frozen) continue;
      if (q.vbe < FREEZE_V && q.vbc < FREEZE_V) { if (++q.calm > CALM) { q.frozen = true; froze = true; } } else q.calm = 0;
    }
    if (froze) this.kDirty = this.dirty = true;
  }

  // Stamps below write into the k x k matrix in local (K) indices.
  _stampDyn(M, n) {
    for (const d of this.dyn) {
      const g = d.g; if (g === 0) continue;
      const a = d.la, b = d.lb;
      if (a >= 0) M[a * n + a] += g;
      if (!d.fixed && b >= 0) { M[b * n + b] += g; if (a >= 0) { M[a * n + b] -= g; M[b * n + a] -= g; } }
    }
  }

  // Converged when the linearised junction currents the last solve used
  // match the true (exponential) currents at the voltages it found, to
  // within tol volts of equivalent junction voltage (or ~1 nA x tol/1e-5
  // for junctions that are barely conducting). The error of the
  // linearisation is quadratic in the step, f(u) = nVt (e^u - 1 - u) with
  // u = dv / nVt, so a small step is accepted without another solve.
  // (OLD_CONV: the earlier test, which needed the step itself below tol and
  // so always took one more solve than necessary.)
  _linError() {
    let e = 0, x;
    const v = this.v;
    const D = this.diodes, Q = this.bjts, O = this.opamps;
    for (let i = 0; i < D.length; i++) {
      const d = D[i];
      if (d.frozen) continue;
      const dv = Math.abs((d.a >= 0 ? v[d.a] : 0) - (d.k >= 0 ? v[d.k] : 0) - d.vd);
      const f = OLD_CONV ? dv : linErr((d.a >= 0 ? v[d.a] : 0) - (d.k >= 0 ? v[d.k] : 0) - d.vd, d.nvt);
      x = f * d.gd * 1e4; if (x > f) x = f; if (x > e) e = x;
    }
    for (let i = 0; i < Q.length; i++) {
      const q = Q[i];
      if (q.frozen) continue;
      const vb = q.b >= 0 ? v[q.b] : 0;
      const ube = q.pol * (vb - (q.e >= 0 ? v[q.e] : 0)) - q.vbe;
      const ubc = q.pol * (vb - (q.c >= 0 ? v[q.c] : 0)) - q.vbc;
      const dbe = OLD_CONV ? Math.abs(ube) : linErr(ube, VT);
      const dbc = OLD_CONV ? Math.abs(ubc) : linErr(ubc, VT);
      x = dbe * q.gf * 1e4; if (x > dbe) x = dbe; if (x > e) e = x;
      x = dbc * q.gr * 1e4; if (x > dbc) x = dbc; if (x > e) e = x;
    }
    // op-amps: error between the true output law and its linearisation, in
    // volts (scaled down: an output volt matters less than a junction volt)
    for (let i = 0; i < O.length; i++) {
      const o = O[i];
      const d = (o.p >= 0 ? v[o.p] : 0) - (o.m >= 0 ? v[o.m] : 0);
      if (o.lin) continue;
      x = Math.abs(clipOut(o.x0 + o.Ae * d, o.vsat) - (o.f + o.fp * (d - o.dl))) * 1e-2;
      if (x > e) e = x;
    }
    return e;
  }

  _stampNonlinear(M, rhs, n) {
    const v = this.v, Dd = this.diodes, Q = this.bjts, O = this.opamps;
    for (let i = 0; i < Dd.length; i++) {
      const d = Dd[i];
      if (d.frozen) continue;
      let vd = (d.a >= 0 ? v[d.a] : 0) - (d.k >= 0 ? v[d.k] : 0);
      vd = pnjlim(vd, d.vd, d.nvt, d.vcrit); d.vd = vd;
      const ex = Math.exp(Math.min(vd / d.nvt, 80));
      const id = d.Is * (ex - 1), gd = (d.Is * ex) / d.nvt + 1e-12; d.gd = gd;
      const ieq = id - gd * vd;
      const a = d.la, k = d.lk;
      if (a >= 0) { M[a * n + a] += gd; rhs[a] -= ieq; if (k >= 0) M[a * n + k] -= gd; }
      if (k >= 0) { M[k * n + k] += gd; rhs[k] += ieq; if (a >= 0) M[k * n + a] -= gd; }
    }
    for (let i = 0; i < Q.length; i++) {
      const q = Q[i];
      if (q.frozen) continue;
      const p = q.pol, vb = q.b >= 0 ? v[q.b] : 0;
      let vbe = p * (vb - (q.e >= 0 ? v[q.e] : 0)), vbc = p * (vb - (q.c >= 0 ? v[q.c] : 0));
      vbe = pnjlim(vbe, q.vbe, VT, q.vcrit); vbc = pnjlim(vbc, q.vbc, VT, q.vcrit);
      q.vbe = vbe; q.vbc = vbc;
      const ef = Math.exp(Math.min(vbe / VT, 80)), er = Math.exp(Math.min(vbc / VT, 80));
      const If = q.Is * (ef - 1), Ir = q.Is * (er - 1);
      const gf = (q.Is * ef) / VT + 1e-12, gr = (q.Is * er) / VT + 1e-12; q.gf = gf; q.gr = gr;
      const kr = 1 + 1 / q.br;
      const Ic = If - Ir * kr, Ib = If / q.bf + Ir / q.br;
      const cA = gf, cB = -gr * kr, bA = gf / q.bf, bB = gr / q.br;
      this._bjtRow(M, rhs, n, q.lc, q, p * Ic, cA, cB, vbe, vbc);
      this._bjtRow(M, rhs, n, q.lb, q, p * Ib, bA, bB, vbe, vbc);
      this._bjtRow(M, rhs, n, q.le, q, -p * (Ic + Ib), -(cA + bA), -(cB + bB), vbe, vbc);
    }
    for (let i = 0; i < O.length; i++) {
      const o = O[i];
      if (o.lin) continue;
      // dominant pole (GBW / A): internal state x follows A*vd through a
      // backward-Euler lag; output = clip(x): linear to 80% of the rail,
      // then a tanh knee into vsat
      let d = this._vd(o.p, o.m);
      // limiting: a jump from one rail's saturation to the other's would have
      // zero slope at both ends and never converge, so pass through x = 0
      const xo = o.x0 + o.Ae * o.dl, xn = o.x0 + o.Ae * d;
      if (xo * xn < 0 && Math.abs(xn - xo) > 6 * o.vsat) d = -o.x0 / o.Ae;
      o.dl = d;
      const c = clipOut(o.x0 + o.Ae * d, o.vsat);
      const f = c, fp = o.Ae * CLIP_SLOPE; o.f = f; o.fp = fp;
      const r = o.lo;
      if (r < 0) continue;
      M[r * n + r] += o.g;
      if (o.lp >= 0) M[r * n + o.lp] -= o.g * fp;
      if (o.lm >= 0) M[r * n + o.lm] += o.g * fp;
      rhs[r] += o.g * (f - fp * d);
    }
  }
  // Row r gets the linearised current I = I0 + a*(vbe_actual - p*vbe) + b*(vbc_actual - p*vbc)
  _bjtRow(M, rhs, n, r, q, I0, a, b, vbe, vbc) {
    if (r < 0) return;
    const p = q.pol, row = r * n;
    if (q.lb >= 0) M[row + q.lb] += a + b;
    if (q.le >= 0) M[row + q.le] -= a;
    if (q.lc >= 0) M[row + q.lc] -= b;
    rhs[r] -= I0 - a * p * vbe - b * p * vbc;
  }

  // LU with partial pivoting, in place; perm[k] = row swapped into k.
  _factor(M, perm, n) {
    for (let k = 0; k < n; k++) {
      let piv = k, mx = Math.abs(M[k * n + k]);
      for (let i = k + 1; i < n; i++) { const a = Math.abs(M[i * n + k]); if (a > mx) { mx = a; piv = i; } }
      perm[k] = piv;
      if (piv !== k) for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[piv * n + j]; M[piv * n + j] = t; }
      const d = M[k * n + k] || 1e-18; M[k * n + k] = d;
      for (let i = k + 1; i < n; i++) {
        const f = M[i * n + k] / d;
        M[i * n + k] = f;
        if (f === 0) continue;
        for (let j = k + 1; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      }
    }
  }
  _lusolve(M, perm, n, b, x) {
    for (let i = 0; i < n; i++) x[i] = b[i];
    for (let k = 0; k < n; k++) { const p = perm[k]; if (p !== k) { const t = x[k]; x[k] = x[p]; x[p] = t; } }
    for (let i = 0; i < n; i++) { let s = x[i]; for (let j = 0; j < i; j++) s -= M[i * n + j] * x[j]; x[i] = s; }
    for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j]; x[i] = s / M[i * n + i]; }
  }

  // DC operating point: capacitors open, many Newton iterations.
  settle(steps = 2000) {
    const dt = this.dt;
    this.setTimestep(1e4);
    for (let i = 0; i < 30; i++) this.step(300, 1e-9);
    for (const cap of this.caps) cap.i = 0;
    this.setTimestep(dt);
    for (let i = 0; i < steps; i++) this.step();
  }
}

// --- Shared trigger bus -----------------------------------------------------
// Main board accent circuit (p.8, Q31-Q34, VR3 AC LEVEL): the common trigger
// bus is the emitter of follower Q32. Normal hits: Q34 holds Q32's base at the
// 5 V line. Accented hits: Q34 is off and the base follows VR3's wiper
// (5 V..15 V). One Vbe below that is the bus.
export function busVoltage(accent) {
  const vbe = 0.66, a = Math.max(0, Math.min(1, accent));
  // normal: base at 5.1 V (Q34 saturated); accent: VR3 wiper, 5 V..15 V
  return (a > 0 ? Math.max(5.1, 5 + 10 * a) : 5.1) - vbe;
}
export const TRIG_WIDTH = 1e-3; // instrument trigger pulse
