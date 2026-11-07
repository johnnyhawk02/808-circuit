#include "IrVerb.h"
#include <cmath>
#include <algorithm>
#include <map>
#include <mutex>

namespace t8 {

static const double PI = 3.141592653589793;
// the gate's lengths, in bars (4/4)
static const double VERB_GATE[16] = { 0, 1.0 / 64, 1.0 / 32, 1.0 / 24, 1.0 / 16, 1.0 / 12, 3.0 / 32, 1.0 / 8, 1.0 / 6, 3.0 / 16, 1.0 / 4, 1.0 / 3, 3.0 / 8, 1.0 / 2, 3.0 / 4, 1 };

struct FftTab { std::vector<uint32_t> rev; std::vector<double> c, s; };
static const FftTab& fftTab(int n) {
    // (built once per size, the first time; the sizes used are 128 and 4096, both made at start-up by IrVerb's constructor)
    static std::map<int, FftTab> tabs; static std::mutex m;
    std::lock_guard<std::mutex> lk(m);
    auto it = tabs.find(n);
    if (it != tabs.end()) return it->second;
    FftTab t; int bits = 0; while ((1 << bits) < n) bits++;
    t.rev.resize((size_t) n); t.c.resize((size_t) n / 2); t.s.resize((size_t) n / 2);
    for (int i = 0; i < n; i++) { uint32_t r = 0; for (int b = 0; b < bits; b++) r |= (uint32_t) ((i >> b) & 1) << (bits - 1 - b); t.rev[(size_t) i] = r; }
    for (int k = 0; k < n / 2; k++) { t.c[(size_t) k] = std::cos(2 * PI * k / n); t.s[(size_t) k] = std::sin(2 * PI * k / n); }
    return tabs.emplace(n, std::move(t)).first->second;
}
void fft(double* re, double* im, int n, bool inv) {
    const FftTab& T = fftTab(n);
    const double sg = inv ? 1 : -1;
    for (int i = 0; i < n; i++) { const int j = (int) T.rev[(size_t) i]; if (j > i) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); } }
    for (int size = 2; size <= n; size <<= 1) {
        const int h = size >> 1, st = n / size;
        for (int i = 0; i < n; i += size) for (int k = 0, w = 0; k < h; k++, w += st) {
            const double wr = T.c[(size_t) w], wi = sg * T.s[(size_t) w];
            const int a = i + k, b = a + h;
            const double tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
    }
}

std::shared_ptr<IrSpectra> IrSpectra::prepare(const std::vector<float>& L, const std::vector<float>& Rin, double frac) {
    const std::vector<float>& R = Rin.empty() ? L : Rin;
    const int n = std::max(64, std::min(IRV_MAX, (int) std::floor(L.size() * frac + 0.5))), fd = (int) std::floor(n * 0.3 + 0.5);
    std::array<std::vector<double>, 2> ch;
    for (int c = 0; c < 2; c++) {
        const std::vector<float>& x = c ? R : L;
        ch[(size_t) c].resize((size_t) n);
        for (int i = 0; i < n; i++)
            ch[(size_t) c][(size_t) i] = ((size_t) i < x.size() ? (double) x[(size_t) i] : 0.0) * (i > n - fd ? 0.5 + 0.5 * std::cos(PI * (i - (n - fd)) / fd) : 1);
    }
    double e = 0; for (auto& y : ch) for (int i = 0; i < n; i++) e += y[(size_t) i] * y[(size_t) i];
    const double g = 0.8 / std::sqrt(e / 2 + 1e-12);
    auto part = [&](const std::vector<double>& y, int off, int B, int N, int K, int P) {
        Part pt; pt.re.assign((size_t) P * K, 0.f); pt.im.assign((size_t) P * K, 0.f);
        std::vector<double> r((size_t) N), m((size_t) N);
        for (int p = 0; p < P; p++) {
            std::fill(r.begin(), r.end(), 0.0); std::fill(m.begin(), m.end(), 0.0);
            for (int i = 0; i < B; i++) { const int k = off + p * B + i; if (k < n) r[(size_t) i] = y[(size_t) k] * g; }
            fft(r.data(), m.data(), N, false);
            for (int k = 0; k < K; k++) { pt.re[(size_t) (p * K + k)] = (float) r[(size_t) k]; pt.im[(size_t) (p * K + k)] = (float) m[(size_t) k]; }
        }
        return pt;
    };
    auto h = std::make_shared<IrSpectra>();
    h->n = n;
    h->p2 = std::max(0, (int) std::ceil((n - IRV_B1 * IRV_P1) / (double) IRV_B2));
    for (int c = 0; c < 2; c++) {
        h->h1[(size_t) c] = part(ch[(size_t) c], 0, IRV_B1, IRV_N1, IRV_K1, IRV_P1);
        h->h2[(size_t) c] = part(ch[(size_t) c], IRV_B1 * IRV_P1, IRV_B2, IRV_N2, IRV_K2, h->p2);
    }
    return h;
}

IrVerb::IrVerb(double fs_) : fs(fs_) {
    x1re.assign((size_t) IRV_P1 * IRV_K1, 0.f); x1im.assign((size_t) IRV_P1 * IRV_K1, 0.f);
    x2re.assign((size_t) IRV_P2MAX * IRV_K2, 0.f); x2im.assign((size_t) IRV_P2MAX * IRV_K2, 0.f);
    prev1.assign(IRV_B1, 0); seg.assign(IRV_B2, 0); prevSeg.assign(IRV_B2, 0); jobWin.assign(IRV_N2, 0);
    for (auto& b : out2) b.assign(IRV_B2, 0.f);
    for (auto& b : pend) b.assign(IRV_B2, 0.f);
    r1.assign(IRV_N1, 0); i1.assign(IRV_N1, 0); r2.assign(IRV_N2, 0); i2.assign(IRV_N2, 0);
    for (auto& y : y1) y.assign(IRV_K1, 0);
    for (auto& y : y2) y.assign(IRV_K2, 0);
    pd.assign(8192, 0.f); v.assign(64, 0); gt.assign(64, 0.f);
    gkF = std::exp(-1 / (0.002 * fs)); gkS = std::exp(-1 / (0.08 * fs)); gA = 1 - std::exp(-1 / (0.001 * fs)); gR = 1 - std::exp(-1 / (0.006 * fs));
    fftTab(IRV_N1); fftTab(IRV_N2);
    Knobs k; k.hasPre = k.hasLow = k.hasTone = k.hasWidth = true; k.pre = 10; k.low = 50; k.tone = 100; k.width = 64;
    set(k);
}
void IrVerb::set(const Knobs& k) {
    if (k.hasPre) pre = (int) std::min((double) pd.size() - 64, std::floor(k.pre / 127 * 0.15 * fs + 0.5));
    if (k.hasLow) lcA = std::exp(-2 * PI * 20 * std::pow(25, k.low / 127) / fs);
    if (k.hasTone) lpA = 1 - std::exp(-2 * PI * std::min(0.45 * fs, 1000 * std::pow(20, k.tone / 127)) / fs);
    if (k.hasWidth) width = k.width / 64;
    if (k.hasGate) gate = std::max(0, std::min(15, (int) k.gate));
    if (k.hasGfine) gFine = k.gfine;
}
void IrVerb::clear() {
    std::fill(x1re.begin(), x1re.end(), 0.f); std::fill(x1im.begin(), x1im.end(), 0.f);
    std::fill(x2re.begin(), x2re.end(), 0.f); std::fill(x2im.begin(), x2im.end(), 0.f);
    std::fill(prev1.begin(), prev1.end(), 0.0); std::fill(seg.begin(), seg.end(), 0.0); std::fill(prevSeg.begin(), prevSeg.end(), 0.0);
    for (auto& b : out2) std::fill(b.begin(), b.end(), 0.f);
    for (auto& b : pend) std::fill(b.begin(), b.end(), 0.f);
    job = false; lcS = 0; lpL = 0; lpR = 0; std::fill(pd.begin(), pd.end(), 0.f);
}
void IrVerb::process(const float* x, float* L, float* R, double g0, double g1) {
    if (!h) return;
    const IrSpectra& H = *h;
    bool any = false; for (int i = 0; i < 64; i++) if (x[i] != 0) { any = true; break; }
    const double gone = H.n + 3 * IRV_B2 + pre;
    if (any) { if (idle > gone) clear(); idle = 0; }
    else if ((idle += 64) > gone) return;
    const int M = (int) pd.size() - 1;
    double* xin = r1.data();
    const double gLen = gate ? std::max(64.0, VERB_GATE[gate] * 240 / bpm * fs * (1 + gFine / 100)) : 0;
    for (int i = 0; i < 64; i++) {
        pd[(size_t) pdW] = x[i];
        const double d = pd[(size_t) ((pdW - pre) & M)]; pdW = (pdW + 1) & M;
        lcS = d + lcA * (lcS - d); xin[i] = d - lcS;
        if (gLen) {
            const double a = std::abs(d); gEnvF = std::max(a, gEnvF * gkF);
            if (gEnvF > 1.6 * gEnvS + 1e-4 && gLeft <= 0) gLeft = gLen;
            gEnvS = std::max(gEnvF, gEnvS * gkS);
            const double to = gLeft-- > 0 ? 1 : 0;
            gG += (to - gG) * (to ? gA : gR); gt[(size_t) i] = (float) gG;
        } else gt[(size_t) i] = 1;
    }
    if (!gLen) { gG = 1; gLeft = 0; }
    for (int i = 0; i < 64; i++) v[(size_t) i] = xin[i];
    // stage 1
    for (int i = 0; i < 64; i++) { r1[(size_t) i] = prev1[(size_t) i]; r1[(size_t) (64 + i)] = v[(size_t) i]; }
    std::fill(i1.begin(), i1.end(), 0.0);
    for (int i = 0; i < 64; i++) prev1[(size_t) i] = v[(size_t) i];
    fft(r1.data(), i1.data(), IRV_N1, false);
    const int o1 = pos1 * IRV_K1;
    for (int k = 0; k < IRV_K1; k++) { x1re[(size_t) (o1 + k)] = (float) r1[(size_t) k]; x1im[(size_t) (o1 + k)] = (float) i1[(size_t) k]; }
    for (auto& y : y1) std::fill(y.begin(), y.end(), 0.0);
    mac(x1re, x1im, IRV_P1, pos1, IRV_K1, H.h1, 0, IRV_P1, y1);
    pos1 = (pos1 + 1) % IRV_P1;
    back(y1, r1.data(), i1.data(), IRV_N1);
    // stage 2
    const int b = blk, s = b * 64;
    for (int i = 0; i < 64; i++) seg[(size_t) (s + i)] = v[(size_t) i];
    if (job) {
        if (b == 0) {
            for (int i = 0; i < IRV_N2; i++) r2[(size_t) i] = jobWin[(size_t) i];
            std::fill(i2.begin(), i2.end(), 0.0);
            fft(r2.data(), i2.data(), IRV_N2, false);
            const int o2 = pos2 * IRV_K2;
            for (int k = 0; k < IRV_K2; k++) { x2re[(size_t) (o2 + k)] = (float) r2[(size_t) k]; x2im[(size_t) (o2 + k)] = (float) i2[(size_t) k]; }
            for (auto& y : y2) std::fill(y.begin(), y.end(), 0.0);
        }
        const int P = std::min(H.p2, IRV_P2MAX), p0 = (int) std::floor(b * P / 32.0), p1 = (int) std::floor((b + 1) * P / 32.0);
        if (p1 > p0) mac(x2re, x2im, IRV_P2MAX, pos2, IRV_K2, H.h2, p0, p1, y2);
        if (b == 31) {
            back(y2, r2.data(), i2.data(), IRV_N2);
            for (int i = 0; i < IRV_B2; i++) { pend[0][(size_t) i] = (float) r2[(size_t) (IRV_B2 + i)]; pend[1][(size_t) i] = (float) i2[(size_t) (IRV_B2 + i)]; }
            pos2 = (pos2 + 1) % IRV_P2MAX;
        }
    }
    const std::vector<float>& o2L = out2[0]; const std::vector<float>& o2R = out2[1];
    const double a = lpA, w = width;
    double lL = lpL, lR = lpR;
    for (int i = 0; i < 64; i++) {
        const double yl = r1[(size_t) (64 + i)] + o2L[(size_t) (s + i)], yr = i1[(size_t) (64 + i)] + o2R[(size_t) (s + i)];
        lL += a * (yl - lL); lR += a * (yr - lR);
        const double m = (lL + lR) / 2, d = (lL - lR) / 2 * w, g = (g0 + (g1 - g0) * (i + 1) / 64) * gt[(size_t) i];
        L[i] = (float) (L[i] + (m + d) * g); R[i] = (float) (R[i] + (m - d) * g);
    }
    lpL = lL; lpR = lR;
    if (b == 31) {
        if (job) std::swap(out2, pend); else { std::fill(out2[0].begin(), out2[0].end(), 0.f); std::fill(out2[1].begin(), out2[1].end(), 0.f); }
        for (int i = 0; i < IRV_B2; i++) { jobWin[(size_t) i] = prevSeg[(size_t) i]; jobWin[(size_t) (IRV_B2 + i)] = seg[(size_t) i]; prevSeg[(size_t) i] = seg[(size_t) i]; }
        job = H.p2 > 0;
    }
    blk = (b + 1) & 31;
}
void IrVerb::mac(const std::vector<float>& Xr, const std::vector<float>& Xi, int ring, int pos, int K, const std::array<IrSpectra::Part, 2>& H, int p0, int p1, std::array<std::vector<double>, 4>& y) {
    double* yLr = y[0].data(); double* yLi = y[1].data(); double* yRr = y[2].data(); double* yRi = y[3].data();
    const auto& HL = H[0]; const auto& HR = H[1];
    for (int p = p0; p < p1; p++) {
        const size_t xo = (size_t) (((pos - p + ring) % ring) * K), ho = (size_t) (p * K);
        for (int k = 0; k < K; k++) {
            const double xr = Xr[xo + (size_t) k], xi = Xi[xo + (size_t) k], lr = HL.re[ho + (size_t) k], li = HL.im[ho + (size_t) k], rr = HR.re[ho + (size_t) k], ri = HR.im[ho + (size_t) k];
            yLr[k] += xr * lr - xi * li; yLi[k] += xr * li + xi * lr;
            yRr[k] += xr * rr - xi * ri; yRi[k] += xr * ri + xi * rr;
        }
    }
}
void IrVerb::back(std::array<std::vector<double>, 4>& y, double* re, double* im, int N) {
    const double* Lr = y[0].data(); const double* Li = y[1].data(); const double* Rr = y[2].data(); const double* Ri = y[3].data();
    const int H = N / 2;
    for (int k = 0; k <= H; k++) { re[k] = Lr[k] - Ri[k]; im[k] = Li[k] + Rr[k]; }
    for (int k = H + 1; k < N; k++) { const int j = N - k; re[k] = Lr[j] + Ri[j]; im[k] = Rr[j] - Li[j]; }
    fft(re, im, N, true);
    for (int i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

} // namespace t8
