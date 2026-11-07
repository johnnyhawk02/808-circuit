#include "Mna.h"
#include <algorithm>
#include <set>
#include <stdexcept>

namespace t8 {

static constexpr double FREEZE_V = -0.1, WAKE_V = 0.3, CALM = 48;
static constexpr double KNEE = 0.8;

static double clipOut(double x, double vsat, double& slope) {
    const double xl = KNEE * vsat, ax = std::abs(x);
    if (ax <= xl) { slope = 1; return x; }
    const double w = vsat - xl, t = std::tanh((ax - xl) / w);
    slope = 1 - t * t;
    return (x > 0 ? 1.0 : x < 0 ? -1.0 : 0.0) * (xl + w * t);
}

static double linErr(double dv, double nvt) {
    const double u = dv / nvt;
    if (u > -0.5 && u < 0.5) return std::abs(nvt * u * u * (0.5 + u * (1.0 / 6 + u * (1.0 / 24 + u / 120))));
    return std::abs(nvt * (std::exp(std::min(u, 80.0)) - 1 - u));
}

static double pnjlim(double vnew, double vold, double vt, double vcrit) {
    if (vnew > vcrit && std::abs(vnew - vold) > 2 * vt) {
        if (vold > 0) {
            const double arg = 1 + (vnew - vold) / vt;
            vnew = arg > 0 ? vold + vt * std::log(arg) : vcrit;
        } else {
            vnew = vt * std::log(vnew / vt);
        }
    }
    return vnew;
}

Circuit::Circuit(const std::vector<std::string>& nodeNames) : names(nodeNames), n((int) nodeNames.size()) {
    for (int i = 0; i < n; i++) idx[nodeNames[(size_t) i]] = i;
    v.assign((size_t) n, 0.0);
    A.assign((size_t) (n * n), 0.0);
    base.assign((size_t) (n * n), 0.0);
    bBase.assign((size_t) n, 0.0);
    perm.assign((size_t) n, 0);
}

int Circuit::node(const std::string& name) const {
    if (name == "gnd") return -1;
    auto it = idx.find(name);
    if (it == idx.end()) throw std::runtime_error("unknown node " + name);
    return it->second;
}

Res* Circuit::R(const std::string& a, const std::string& b, double ohms) {
    res.push_back({ node(a), node(b), 1 / ohms });
    return &res.back();
}
Src* Circuit::Rsrc(const std::string& a, double ohms, double volts) {
    Src s; s.a = node(a); s.g = 1 / ohms; s.v = volts; s.on = true;
    srcs.push_back(std::move(s));
    return &srcs.back();
}
Cap* Circuit::C(const std::string& a, const std::string& b, double farads) {
    Cap c; c.a = node(a); c.b = node(b); c.c = farads;
    caps.push_back(c);
    return &caps.back();
}
Diode* Circuit::D(const std::string& anode, const std::string& cathode, DiodeModel m) {
    const double nvt = m.n * VT;
    Diode d; d.a = node(anode); d.k = node(cathode); d.Is = m.Is; d.nvt = nvt;
    d.vcrit = nvt * std::log(nvt / (M_SQRT2 * m.Is));
    diodes.push_back(d);
    R(anode, cathode, 1 / GMIN);
    return &diodes.back();
}
Bjt* Circuit::bjt(const std::string& b, const std::string& c, const std::string& e, PartModel m, int pol) {
    Bjt q; q.b = node(b); q.c = node(c); q.e = node(e); q.Is = m.Is; q.bf = m.bf; q.br = m.br; q.pol = pol;
    q.vcrit = VT * std::log(VT / (M_SQRT2 * m.Is));
    bjts.push_back(q);
    R(b, e, 1 / GMIN); R(b, c, 1 / GMIN);
    return &bjts.back();
}
OpAmp* Circuit::Op(const std::string& plus, const std::string& minus, const std::string& out, PARTS::OpAmpModel m) {
    OpAmp o; o.p = node(plus); o.m = node(minus); o.o = node(out); o.A = m.A; o.g = 1 / m.ro; o.vsat = m.vsat;
    o.wp = 2 * M_PI * m.gbw / m.A; o.Ae = m.A;
    opamps.push_back(o);
    return &opamps.back();
}
Dyn* Circuit::DynEl(const std::string& a, const char* b, double vb) {
    Dyn d; d.a = node(a); d.b = b ? node(b) : -1; d.fixed = b == nullptr; d.vb = vb;
    dyn.push_back(d);
    return &dyn.back();
}

void Circuit::buildK() {
    std::set<int> set;
    auto add = [&](int i) { if (i >= 0) set.insert(i); };
    for (auto& d : diodes) if (!d.frozen) { add(d.a); add(d.k); }
    for (auto& q : bjts) if (!q.frozen) { add(q.b); add(q.c); add(q.e); }
    for (auto& o : opamps) if (!o.lin) { add(o.p); add(o.m); add(o.o); }
    for (auto& d : dyn) { add(d.a); if (!d.fixed) add(d.b); }
    K.assign(set.begin(), set.end());
    k = (int) K.size();
    std::vector<int> loc((size_t) n, -1);
    for (int i = 0; i < k; i++) loc[(size_t) K[(size_t) i]] = i;
    auto L = [&](int i) { return i >= 0 ? loc[(size_t) i] : -1; };
    for (auto& d : diodes) { d.la = L(d.a); d.lk = L(d.k); }
    for (auto& q : bjts) { q.lb = L(q.b); q.lc = L(q.c); q.le = L(q.e); }
    for (auto& o : opamps) { o.lp = L(o.p); o.lm = L(o.m); o.lo = L(o.o); }
    for (auto& d : dyn) { d.la = L(d.a); d.lb = d.fixed ? -1 : L(d.b); }
    std::set<int> pat;
    auto pr = [&](int r, std::initializer_list<int> cs) { if (r < 0) return; for (int c : cs) if (c >= 0) pat.insert(r * k + c); };
    for (auto& d : diodes) if (!d.frozen) { pr(d.la, { d.la, d.lk }); pr(d.lk, { d.la, d.lk }); }
    for (auto& q : bjts) if (!q.frozen) for (int r : { q.lb, q.lc, q.le }) pr(r, { q.lb, q.lc, q.le });
    for (auto& o : opamps) if (!o.lin) pr(o.lo, { o.lo, o.lp, o.lm });
    for (auto& d : dyn) { pr(d.la, { d.la, d.lb }); pr(d.lb, { d.la, d.lb }); }
    patIdx.assign(pat.begin(), pat.end());
    patRow.resize(patIdx.size()); patCol.resize(patIdx.size());
    for (size_t i = 0; i < patIdx.size(); i++) { patRow[i] = patIdx[i] / k; patCol[i] = patIdx[i] % k; }
    nDev = diodes.size() + bjts.size() + opamps.size() + dyn.size();
    Z.assign((size_t) (n * k), 0.0);
    Zkk.assign((size_t) (k * k), 0.0);
    Nk.assign((size_t) (k * k), 0.0); rk.assign((size_t) k, 0.0);
    Ak.assign((size_t) (k * k), 0.0); wk.assign((size_t) k, 0.0); bk.assign((size_t) k, 0.0);
    perm.assign((size_t) n, 0); permK.assign((size_t) k, 0);
    y.assign((size_t) n, 0.0); e.assign((size_t) n, 0.0);
    Gi.assign((size_t) (n * n), 0.0);
    haveK = true;
}

void Circuit::buildBase() {
    std::vector<double>& M = base;
    if (!haveK || kDirty || nDev != diodes.size() + bjts.size() + opamps.size() + dyn.size()) { buildK(); kDirty = false; }
    std::fill(M.begin(), M.end(), 0.0);
    auto G = [&](int a, int b, double g) {
        if (a >= 0) M[(size_t) (a * n + a)] += g;
        if (b >= 0) M[(size_t) (b * n + b)] += g;
        if (a >= 0 && b >= 0) { M[(size_t) (a * n + b)] -= g; M[(size_t) (b * n + a)] -= g; }
    };
    for (auto& r : res) G(r.a, r.b, r.g);
    for (auto& s : srcs) if (s.on && s.a >= 0) M[(size_t) (s.a * n + s.a)] += s.g;
    for (auto& o : opamps) {
        const double a = o.wp * dt; o.Ae = (o.A * a) / (1 + a); o.a = a;
        if (!o.lin || o.o < 0) continue;
        const int r = o.o * n;
        M[(size_t) (r + o.o)] += o.g;
        if (o.p >= 0) M[(size_t) (r + o.p)] -= o.g * o.Ae;
        if (o.m >= 0) M[(size_t) (r + o.m)] += o.g * o.Ae;
    }
    for (auto& c : caps) { c.be = false; c.geq = (2 * c.c) / dt; G(c.a, c.b, c.geq); }
    for (int i = 0; i < n; i++) if (M[(size_t) (i * n + i)] == 0) M[(size_t) (i * n + i)] = GMIN;
    A = M; factor(A, perm, n);
    bool anyBE = false;
    for (auto& c : caps) {
        std::fill(e.begin(), e.end(), 0.0); if (c.a >= 0) e[(size_t) c.a] = 1; if (c.b >= 0) e[(size_t) c.b] = -1;
        lusolve(A, perm, n, e, y);
        const double rpar = (c.a >= 0 ? y[(size_t) c.a] : 0) - (c.b >= 0 ? y[(size_t) c.b] : 0);
        const double gth = 1 / rpar - c.geq;
        bool fb = false;
        for (auto& o : opamps) if ((o.o == c.a && o.m == c.b) || (o.o == c.b && o.m == c.a)) { fb = true; break; }
        if (fb || (gth > 0 && c.c / gth < dt / 4)) {
            c.be = true; anyBE = true;
            G(c.a, c.b, c.c / dt - c.geq); c.geq = c.c / dt;
        }
    }
    for (int i = 0; i < n; i++) if (M[(size_t) (i * n + i)] == 0) M[(size_t) (i * n + i)] = GMIN;
    if (anyBE) { A = M; factor(A, perm, n); }
    for (int j = 0; j < n; j++) {
        std::fill(e.begin(), e.end(), 0.0); e[(size_t) j] = 1;
        lusolve(A, perm, n, e, y);
        for (int i = 0; i < n; i++) Gi[(size_t) (i * n + j)] = y[(size_t) i];
    }
    for (int j = 0; j < k; j++) { const int g = K[(size_t) j]; for (int i = 0; i < n; i++) Z[(size_t) (i * k + j)] = Gi[(size_t) (i * n + g)]; }
    for (int a = 0; a < k; a++) for (int j = 0; j < k; j++) Zkk[(size_t) (a * k + j)] = Z[(size_t) (K[(size_t) a] * k + j)];
    dirty = false;
}

bool Circuit::step(int maxIter, double tolerance) {
    if (dirty) buildBase();
    std::vector<double>& rb = bBase; std::fill(rb.begin(), rb.end(), 0.0);
    for (auto& s : srcs) if (s.on && s.a >= 0) rb[(size_t) s.a] += s.g * s.v;
    for (auto& c : caps) {
        const double ieq = (c.ieq = c.geq * c.vPrev + (c.be ? 0 : c.i));
        if (c.a >= 0) rb[(size_t) c.a] += ieq;
        if (c.b >= 0) rb[(size_t) c.b] -= ieq;
    }
    for (auto& d : dyn) if (d.a >= 0) rb[(size_t) d.a] += d.i + (d.fixed ? d.g * d.vb : 0);
    for (auto& o : opamps) {
        o.x0 = o.xPrev / (1 + o.a);
        if (o.lin && o.o >= 0) rb[(size_t) o.o] += o.g * o.x0;
    }
    bool ok = true;
    for (int pass = 0; pass < 4; pass++) {
        ok = newton(rb, maxIter, tolerance);
        if (!wake() || pass == 3) break;
        buildBase();
    }
    for (auto& o : opamps) {
        const double x = o.x0 + o.Ae * ((o.p >= 0 ? v[(size_t) o.p] : 0) - (o.m >= 0 ? v[(size_t) o.m] : 0)), lim = 1.2 * o.vsat, ax = std::abs(x);
        o.xPrev = x > lim ? lim : x < -lim ? -lim : x;
        if (o.lin) { if (ax > KNEE * o.vsat) { o.lin = false; o.calm = 0; kDirty = dirty = true; } }
        else if (ax < 0.6 * o.vsat) { if (++o.calm > 64) { o.lin = true; kDirty = dirty = true; } }
        else o.calm = 0;
    }
    for (auto& c : caps) {
        const double vc = (c.a >= 0 ? v[(size_t) c.a] : 0) - (c.b >= 0 ? v[(size_t) c.b] : 0);
        c.i = c.geq * vc - c.ieq;
        c.vPrev = vc;
    }
    maybeFreeze();
    return ok;
}

bool Circuit::newton(std::vector<double>& rb, int maxIter, double tolerance) {
    for (int i = 0, r = 0; i < n; i++, r += n) {
        double s = 0;
        const double* G = &Gi[(size_t) r];
        for (int j = 0; j < n; j++) s += G[j] * rb[(size_t) j];
        y[(size_t) i] = s;
    }
    bool ok = true; int it = 0;
    std::vector<double>& w = wk;
    if (k > 0) {
        ok = false;
        const size_t np = patIdx.size(); const int kk = k * k;
        for (; it < maxIter; it++) {
            for (size_t p = 0; p < np; p++) Nk[(size_t) patIdx[p]] = 0;
            for (int a = 0; a < k; a++) rk[(size_t) a] = 0;
            stampDyn(Nk, k);
            stampNonlinear(Nk, rk, k);
            for (int i = 0; i < kk; i++) Ak[(size_t) i] = 0;
            for (int a = 0; a < k; a++) { Ak[(size_t) (a * k + a)] = 1; bk[(size_t) a] = rk[(size_t) a]; }
            for (size_t p = 0; p < np; p++) {
                const double nm = Nk[(size_t) patIdx[p]]; if (nm == 0) continue;
                const int m = patCol[p], row = patRow[p] * k, zr = m * k;
                bk[(size_t) patRow[p]] -= nm * y[(size_t) K[(size_t) m]];
                for (int j = 0; j < k; j++) Ak[(size_t) (row + j)] += nm * Zkk[(size_t) (zr + j)];
            }
            factor(Ak, permK, k);
            lusolve(Ak, permK, k, bk, w);
            for (int a = 0; a < k; a++) {
                double s = y[(size_t) K[(size_t) a]];
                const int zr = a * k;
                for (int j = 0; j < k; j++) s += Zkk[(size_t) (zr + j)] * w[(size_t) j];
                v[(size_t) K[(size_t) a]] = s;
            }
            if (linError() < tolerance) { ok = true; break; }
        }
        for (int i = 0, zr = 0; i < n; i++, zr += k) {
            double s = y[(size_t) i];
            for (int j = 0; j < k; j++) s += Z[(size_t) (zr + j)] * w[(size_t) j];
            v[(size_t) i] = s;
        }
    } else v = y;
    itersN = it;
    return ok;
}

bool Circuit::wake() {
    bool woke = false;
    for (auto& d : diodes) {
        if (!d.frozen) continue;
        const double vdv = (d.a >= 0 ? v[(size_t) d.a] : 0) - (d.k >= 0 ? v[(size_t) d.k] : 0);
        if (vdv > WAKE_V) { d.frozen = false; d.calm = 0; d.vd = std::min(vdv, 0.5); woke = true; }
    }
    for (auto& q : bjts) {
        if (!q.frozen) continue;
        const double vb = q.b >= 0 ? v[(size_t) q.b] : 0;
        const double vbe = q.pol * (vb - (q.e >= 0 ? v[(size_t) q.e] : 0)), vbc = q.pol * (vb - (q.c >= 0 ? v[(size_t) q.c] : 0));
        if (vbe > WAKE_V || vbc > WAKE_V) { q.frozen = false; q.calm = 0; q.vbe = std::min(vbe, 0.5); q.vbc = std::min(vbc, 0.5); woke = true; }
    }
    if (woke) kDirty = dirty = true;
    return woke;
}
void Circuit::maybeFreeze() {
    if (!freezing) return;
    bool froze = false;
    for (auto& d : diodes) {
        if (d.frozen) continue;
        if (d.vd < FREEZE_V) { if (++d.calm > CALM) { d.frozen = true; froze = true; } } else d.calm = 0;
    }
    for (auto& q : bjts) {
        if (q.frozen) continue;
        if (q.vbe < FREEZE_V && q.vbc < FREEZE_V) { if (++q.calm > CALM) { q.frozen = true; froze = true; } } else q.calm = 0;
    }
    if (froze) kDirty = dirty = true;
}

void Circuit::stampDyn(std::vector<double>& M, int nn) {
    for (auto& d : dyn) {
        const double g = d.g; if (g == 0) continue;
        const int a = d.la, b = d.lb;
        if (a >= 0) M[(size_t) (a * nn + a)] += g;
        if (!d.fixed && b >= 0) { M[(size_t) (b * nn + b)] += g; if (a >= 0) { M[(size_t) (a * nn + b)] -= g; M[(size_t) (b * nn + a)] -= g; } }
    }
}

double Circuit::linError() {
    double err = 0, x;
    for (auto& d : diodes) {
        if (d.frozen) continue;
        const double f = linErr((d.a >= 0 ? v[(size_t) d.a] : 0) - (d.k >= 0 ? v[(size_t) d.k] : 0) - d.vd, d.nvt);
        x = f * d.gd * 1e4; if (x > f) x = f; if (x > err) err = x;
    }
    for (auto& q : bjts) {
        if (q.frozen) continue;
        const double vb = q.b >= 0 ? v[(size_t) q.b] : 0;
        const double ube = q.pol * (vb - (q.e >= 0 ? v[(size_t) q.e] : 0)) - q.vbe;
        const double ubc = q.pol * (vb - (q.c >= 0 ? v[(size_t) q.c] : 0)) - q.vbc;
        const double dbe = linErr(ube, VT), dbc = linErr(ubc, VT);
        x = dbe * q.gf * 1e4; if (x > dbe) x = dbe; if (x > err) err = x;
        x = dbc * q.gr * 1e4; if (x > dbc) x = dbc; if (x > err) err = x;
    }
    for (auto& o : opamps) {
        const double d = (o.p >= 0 ? v[(size_t) o.p] : 0) - (o.m >= 0 ? v[(size_t) o.m] : 0);
        if (o.lin) continue;
        double sl;
        x = std::abs(clipOut(o.x0 + o.Ae * d, o.vsat, sl) - (o.f + o.fp * (d - o.dl))) * 1e-2;
        if (x > err) err = x;
    }
    return err;
}

void Circuit::stampNonlinear(std::vector<double>& M, std::vector<double>& rhs, int nn) {
    for (auto& d : diodes) {
        if (d.frozen) continue;
        double vdv = (d.a >= 0 ? v[(size_t) d.a] : 0) - (d.k >= 0 ? v[(size_t) d.k] : 0);
        vdv = pnjlim(vdv, d.vd, d.nvt, d.vcrit); d.vd = vdv;
        const double ex = std::exp(std::min(vdv / d.nvt, 80.0));
        const double id = d.Is * (ex - 1), gd = (d.Is * ex) / d.nvt + 1e-12; d.gd = gd;
        const double ieq = id - gd * vdv;
        const int a = d.la, kk = d.lk;
        if (a >= 0) { M[(size_t) (a * nn + a)] += gd; rhs[(size_t) a] -= ieq; if (kk >= 0) M[(size_t) (a * nn + kk)] -= gd; }
        if (kk >= 0) { M[(size_t) (kk * nn + kk)] += gd; rhs[(size_t) kk] += ieq; if (a >= 0) M[(size_t) (kk * nn + a)] -= gd; }
    }
    for (auto& q : bjts) {
        if (q.frozen) continue;
        const int p = q.pol; const double vb = q.b >= 0 ? v[(size_t) q.b] : 0;
        double vbe = p * (vb - (q.e >= 0 ? v[(size_t) q.e] : 0)), vbc = p * (vb - (q.c >= 0 ? v[(size_t) q.c] : 0));
        vbe = pnjlim(vbe, q.vbe, VT, q.vcrit); vbc = pnjlim(vbc, q.vbc, VT, q.vcrit);
        q.vbe = vbe; q.vbc = vbc;
        const double ef = std::exp(std::min(vbe / VT, 80.0)), er = std::exp(std::min(vbc / VT, 80.0));
        const double If = q.Is * (ef - 1), Ir = q.Is * (er - 1);
        const double gf = (q.Is * ef) / VT + 1e-12, gr = (q.Is * er) / VT + 1e-12; q.gf = gf; q.gr = gr;
        const double kr = 1 + 1 / q.br;
        const double Ic = If - Ir * kr, Ib = If / q.bf + Ir / q.br;
        const double cA = gf, cB = -gr * kr, bA = gf / q.bf, bB = gr / q.br;
        bjtRow(M, rhs, nn, q.lc, q, p * Ic, cA, cB, vbe, vbc);
        bjtRow(M, rhs, nn, q.lb, q, p * Ib, bA, bB, vbe, vbc);
        bjtRow(M, rhs, nn, q.le, q, -p * (Ic + Ib), -(cA + bA), -(cB + bB), vbe, vbc);
    }
    for (auto& o : opamps) {
        if (o.lin) continue;
        double d = vd(o.p, o.m);
        const double xo = o.x0 + o.Ae * o.dl, xn = o.x0 + o.Ae * d;
        if (xo * xn < 0 && std::abs(xn - xo) > 6 * o.vsat) d = -o.x0 / o.Ae;
        o.dl = d;
        double slope;
        const double c = clipOut(o.x0 + o.Ae * d, o.vsat, slope);
        const double f = c, fp = o.Ae * slope; o.f = f; o.fp = fp;
        const int r = o.lo;
        if (r < 0) continue;
        M[(size_t) (r * nn + r)] += o.g;
        if (o.lp >= 0) M[(size_t) (r * nn + o.lp)] -= o.g * fp;
        if (o.lm >= 0) M[(size_t) (r * nn + o.lm)] += o.g * fp;
        rhs[(size_t) r] += o.g * (f - fp * d);
    }
}
void Circuit::bjtRow(std::vector<double>& M, std::vector<double>& rhs, int nn, int r, const Bjt& q, double I0, double a, double b, double vbe, double vbc) {
    if (r < 0) return;
    const int p = q.pol, row = r * nn;
    if (q.lb >= 0) M[(size_t) (row + q.lb)] += a + b;
    if (q.le >= 0) M[(size_t) (row + q.le)] -= a;
    if (q.lc >= 0) M[(size_t) (row + q.lc)] -= b;
    rhs[(size_t) r] -= I0 - a * p * vbe - b * p * vbc;
}

void Circuit::factor(std::vector<double>& M, std::vector<int>& prm, int nn) {
    for (int kk = 0; kk < nn; kk++) {
        int piv = kk; double mx = std::abs(M[(size_t) (kk * nn + kk)]);
        for (int i = kk + 1; i < nn; i++) { const double a = std::abs(M[(size_t) (i * nn + kk)]); if (a > mx) { mx = a; piv = i; } }
        prm[(size_t) kk] = piv;
        if (piv != kk) for (int j = 0; j < nn; j++) std::swap(M[(size_t) (kk * nn + j)], M[(size_t) (piv * nn + j)]);
        double d = M[(size_t) (kk * nn + kk)]; if (d == 0 || d != d) d = 1e-18; M[(size_t) (kk * nn + kk)] = d;
        for (int i = kk + 1; i < nn; i++) {
            const double f = M[(size_t) (i * nn + kk)] / d;
            M[(size_t) (i * nn + kk)] = f;
            if (f == 0) continue;
            double* Ri = &M[(size_t) (i * nn)]; const double* Rk = &M[(size_t) (kk * nn)];
            for (int j = kk + 1; j < nn; j++) Ri[j] -= f * Rk[j];
        }
    }
}
void Circuit::lusolve(const std::vector<double>& M, const std::vector<int>& prm, int nn, const std::vector<double>& b, std::vector<double>& x) {
    for (int i = 0; i < nn; i++) x[(size_t) i] = b[(size_t) i];
    for (int kk = 0; kk < nn; kk++) { const int p = prm[(size_t) kk]; if (p != kk) std::swap(x[(size_t) kk], x[(size_t) p]); }
    for (int i = 0; i < nn; i++) { double s = x[(size_t) i]; for (int j = 0; j < i; j++) s -= M[(size_t) (i * nn + j)] * x[(size_t) j]; x[(size_t) i] = s; }
    for (int i = nn - 1; i >= 0; i--) { double s = x[(size_t) i]; for (int j = i + 1; j < nn; j++) s -= M[(size_t) (i * nn + j)] * x[(size_t) j]; x[(size_t) i] = s / M[(size_t) (i * nn + i)]; }
}

void Circuit::settle(int steps) {
    const double d = dt;
    setTimestep(1e4);
    for (int i = 0; i < 30; i++) step(300, 1e-9);
    for (auto& cap : caps) cap.i = 0;
    setTimestep(d);
    for (int i = 0; i < steps; i++) step();
}

} // namespace t8
