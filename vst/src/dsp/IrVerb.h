// C++ port of the player's convolution reverb (elixir/app/player.js: fft, IrVerb): two stages of uniformly partitioned
// overlap-save convolution, mono in, stereo out, with pre-delay, low cut, tone, width and the tempo gate.
#pragma once
#include <vector>
#include <array>
#include <memory>
#include <cstdint>

namespace t8 {

void fft(double* re, double* im, int n, bool inv);

constexpr int IRV_B1 = 64, IRV_N1 = 128, IRV_K1 = 65, IRV_P1 = 64, IRV_B2 = 2048, IRV_N2 = 4096, IRV_K2 = 2049;
constexpr int IRV_MAX = 5 * 44140;
constexpr int IRV_P2MAX = (IRV_MAX - IRV_B1 * IRV_P1 + IRV_B2 - 1) / IRV_B2 + 1;

// an IR cut into the two stages' parts' spectra (IrVerb.prepare)
struct IrSpectra {
    struct Part { std::vector<float> re, im; };
    int n = 0, p2 = 0;
    std::array<Part, 2> h1, h2;
    // L, R: the IR at the engine's rate (R may equal L); frac: how much of it to keep
    static std::shared_ptr<IrSpectra> prepare(const std::vector<float>& L, const std::vector<float>& R, double frac);
};

class IrVerb {
public:
    explicit IrVerb(double fs);
    struct Knobs { bool hasPre = false, hasLow = false, hasTone = false, hasWidth = false, hasGate = false, hasGfine = false;
                   double pre = 0, low = 0, tone = 0, width = 0, gate = 0, gfine = 0; };
    void set(const Knobs& v);
    void load(std::shared_ptr<const IrSpectra> h_) { h = std::move(h_); }
    void clear();
    // one 64-sample block: x (mono) in; the wet signal added into L and R at gain g0 ramping to g1
    void process(const float* x, float* L, float* R, double g0, double g1);
    double bpm = 120;
    std::shared_ptr<const IrSpectra> h;
private:
    void mac(const std::vector<float>& Xr, const std::vector<float>& Xi, int ring, int pos, int K, const std::array<IrSpectra::Part, 2>& H, int p0, int p1, std::array<std::vector<double>, 4>& y);
    void back(std::array<std::vector<double>, 4>& y, double* re, double* im, int N);
    double fs;
    std::vector<float> x1re, x1im, x2re, x2im; int pos1 = 0, pos2 = 0;
    std::vector<double> prev1, seg, prevSeg, jobWin; bool job = false; int blk = 0;
    std::array<std::vector<float>, 2> out2, pend;
    std::vector<double> r1, i1, r2, i2;
    std::array<std::vector<double>, 4> y1, y2;
    std::vector<float> pd; int pdW = 0, pre = 0;
    double lcA = 0, lcS = 0, lpA = 1, lpL = 0, lpR = 0, width = 1;
    double idle = 1e300; std::vector<double> v;
    int gate = 0; double gFine = 0, gEnvF = 0, gEnvS = 0, gLeft = 0, gG = 1; std::vector<float> gt;
    double gkF, gkS, gA, gR;
};

} // namespace t8
