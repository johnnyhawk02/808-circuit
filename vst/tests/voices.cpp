// Renders the same sequence as ref-voices.mjs with the C++ port and compares it with the JS renders.
//   voices <refdir> [sr] [seconds] [only]
#include "../src/dsp/Kit.h"
#include <chrono>
#include <cstdio>
#include <fstream>
using namespace t8;
static std::vector<float> readF32(const std::string& f) {
    std::ifstream in(f, std::ios::binary); std::vector<float> v;
    in.seekg(0, std::ios::end); size_t n = (size_t) in.tellg() / 4; in.seekg(0); v.resize(n);
    in.read((char*) v.data(), (std::streamsize) (n * 4)); return v;
}
int main(int argc, char** argv) {
    std::string ref = argc > 1 ? argv[1] : "/tmp/ref"; double sr = argc > 2 ? atof(argv[2]) : 44140, secs = argc > 3 ? atof(argv[3]) : 1.5;
    std::string only = argc > 4 ? argv[4] : "";
    auto t0 = std::chrono::steady_clock::now();
    Kit kit(sr);
    if (getenv("KNOBS")) { const double kv = atof(getenv("KNOBS")); for (int i = 0; i < 16; i++) for (auto q : kit.params(i)) kit.set(VOICE_IDS[i], q.id, q.id == "drive" ? kv / 2 : kv); }
    printf("kit built %.0f ms\n", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
    std::vector<std::vector<float>> split(16, std::vector<float>(64)); float* sp[16]; for (int i = 0; i < 16; i++) sp[i] = split[(size_t) i].data();
    int bad = 0;
    for (int v = 0; v < 16; v++) {
        std::string id = VOICE_IDS[v];
        if (!only.empty() && id != only) continue;
        const int n = (int) (std::floor(secs * sr / 64 + 0.5) * 64); std::vector<float> y((size_t) n);
        auto t1 = std::chrono::steady_clock::now();
        for (int b = 0; b < n / 64; b++) {
            if (b == 0) kit.fire(id, 0);
            if (b == (int) std::floor(0.6 * sr / 64 + 0.5)) kit.fire(id, 1);
            for (auto& s : split) std::fill(s.begin(), s.end(), 0.f);
            kit.render(sp, 64);
            std::copy(split[(size_t) v].begin(), split[(size_t) v].end(), y.begin() + b * 64);
        }
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t1).count();
        auto r = readF32(ref + "/" + id + ".f32");
        double pk = 0, err = 0, e2 = 0, s2 = 0; int first = -1;
        for (size_t i = 0; i < std::min(r.size(), y.size()); i++) {
            pk = std::max(pk, (double) std::abs(r[i])); const double d = std::abs((double) r[i] - y[i]);
            if (d > 0 && first < 0) first = (int) i; err = std::max(err, d); e2 += d * d; s2 += (double) r[i] * r[i];
        }
        const double snr = e2 > 0 ? 10 * std::log10(s2 / e2) : 999;
        // and the envelopes (10 ms RMS, dB), for the voices whose free-running oscillators drift apart in the last bit
        double envMax = 0; const int W = (int) (0.01 * sr);
        for (size_t s0 = 0; s0 + (size_t) W <= std::min(r.size(), y.size()); s0 += (size_t) W) {
            double a = 0, b = 0; for (int i = 0; i < W; i++) { a += (double) r[s0 + (size_t) i] * r[s0 + (size_t) i]; b += (double) y[s0 + (size_t) i] * y[s0 + (size_t) i]; }
            a = std::sqrt(a / W); b = std::sqrt(b / W);
            if (a > pk * 1e-2) envMax = std::max(envMax, std::abs(20 * std::log10((b + 1e-12) / (a + 1e-12))));
        }
        const bool ok = snr >= 60 || envMax < 1.5;
        printf("%s  %6.0f ms  peak %.3f V  max err %.3g  SNR %.1f dB  envelope within %.2f dB  first diff at %d%s\n", id.c_str(), ms, pk, err, snr, envMax, first, ok ? "" : "  <-- check");
        if (!ok) bad++;
    }
    return bad;
}
