// C++ ports of dsp/noise.js (NoiseBus) and dsp/metal-circuit.js (MetalCircuit): the main board's noise generator
// and the voicing board's six Schmitt oscillators with the IC3 band split.
#pragma once
#include "Core.h"
#include "Mna.h"
#include <array>
#include <functional>
#include <memory>

namespace t8 {

inline double jsround(double x) { return std::floor(x + 0.5); }

class NoiseBus {
public:
    explicit NoiseBus(double sr_, uint32_t seed = 0x808) : sr(sr_), s(seed), wn(128, 0.f), pn(128, 0.f),
        ckt({ "W", "A", "B", "P" }) {
        src = ckt.Rsrc("W", 10, 0);
        ckt.R("W", "A", 22e3); ckt.R("A", "B", 22e3);
        ckt.C("A", "P", 0.039e-6); ckt.C("B", "gnd", 0.018e-6);
        ckt.Op("B", "P", "P");
        ckt.setTimestep(1 / sr); ckt.settle(10);
        P = ckt.idx["P"];
    }
    double u() { uint32_t x = s; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s = x; return ((double) x + 1) / 4294967297.0; }
    double gauss() { const double a = u(); const double b = u(); return std::sqrt(-2 * std::log(a)) * std::cos(2 * M_PI * b); }
    void render(int n) {
        if ((int) wn.size() < n) { wn.assign((size_t) n, 0.f); pn.assign((size_t) n, 0.f); }
        for (int i = 0; i < n; i++) {
            const double w = gauss() * rms;
            wn[(size_t) i] = (float) w; src->v = w;
            ckt.step(4, 1e-4);
            pn[(size_t) i] = (float) ckt.v[(size_t) P];
        }
    }
    double sr; uint32_t s; std::vector<float> wn, pn;
    Circuit ckt; Src* src; int P; double rms = 0.13;
};

class MetalCircuit {
public:
    static constexpr double VDD = 5, VTH = 2.8, VTL = 2.2;
    static constexpr std::array<std::array<double, 2>, 6> OSC { { { 560e3, 0.018e-6 }, { 680e3, 0.01e-6 }, { 560e3, 0.01e-6 },
        { 220e3, 0.018e-6 }, { 150e3 + 22.4e3, 0.022e-6 }, { 100e3 + 42.2e3, 0.018e-6 } } };
    struct Osc {
        Osc(double sr, double R, double C, double phase) : dt(1 / sr), tau(R * C), vc(VTL + (VTH - VTL) * phase) {}
        double tick() {
            double t = dt, before = 0, after = 0;
            while (t > 0) {
                const double target = out ? VDD : 0, th = out ? VTH : VTL;
                const double tc = tau * std::log((vc - target) / (th - target));
                if (!(tc <= t)) { vc = target + (vc - target) * std::exp(-t / tau); break; }
                t -= tc; vc = th; out ^= 1;
                const double h = out ? VDD : -VDD, f = t / dt;
                after -= (h / 2) * (1 - f) * (1 - f);
                before += (h / 2) * f * f;
            }
            const double emit = held + before;
            held = out * VDD + after;
            return emit;
        }
        double dt, tau; int out = 1; double vc; double held = VDD;
    };
    explicit MetalCircuit(double sr_) : sr(sr_), ckt({ "MIX", "N11", "Mh", "Ph", "H", "N10", "Ml", "Pl", "L" }) {
        for (int i = 0; i < 6; i++) osc.emplace_back(sr, OSC[(size_t) i][0], OSC[(size_t) i][1], std::fmod(i * 0.37 + 0.11, 1.0));
        v.assign(6, std::vector<float>(128, 0.f)); hi.assign(128, 0.f); lo.assign(128, 0.f);
        for (int i = 0; i < 6; i++) src[(size_t) i] = ckt.Rsrc("MIX", 120e3, 0);
        auto& c = ckt;
        c.R("MIX", "gnd", 1e3);
        c.C("MIX", "N11", 0.001e-6); c.R("N11", "Ph", 22e3);
        c.R("Mh", "gnd", 560);
        c.C("Mh", "Ph", 0.0033e-6); c.C("Mh", "H", 0.0033e-6);
        c.R("Ph", "H", 82e3);
        c.Op("gnd", "Ph", "H");
        c.C("MIX", "N10", 0.0033e-6); c.R("N10", "Pl", 33e3);
        c.R("Ml", "gnd", 560);
        c.C("Ml", "Pl", 0.0068e-6); c.C("Ml", "L", 0.0068e-6);
        c.R("Pl", "L", 82e3);
        c.Op("gnd", "Pl", "L");
        c.setTimestep(1 / sr);
        c.settle(100);
        iH = c.idx["H"]; iL = c.idx["L"];
        active = [] { return true; };
    }
    void setPitch(double m, double spread, const std::vector<int>& idx) {
        std::vector<double> fr; for (auto& rc : OSC) fr.push_back(1 / (rc[0] * rc[1]));
        auto k = spreadFactors(fr, spread, idx);
        for (int i = 0; i < 6; i++) osc[(size_t) i].tau = (OSC[(size_t) i][0] * OSC[(size_t) i][1]) / (m * k[(size_t) i]);
    }
    void render(int n) {
        if ((int) hi.size() < n) { v.assign(6, std::vector<float>((size_t) n, 0.f)); hi.assign((size_t) n, 0.f); lo.assign((size_t) n, 0.f); }
        const bool run = active();
        for (int i = 0; i < n; i++) {
            for (int k = 0; k < 6; k++) { const double y = osc[(size_t) k].tick(); v[(size_t) k][(size_t) i] = (float) y; src[(size_t) k]->v = y; }
            if (run) { ckt.step(8, 1e-5); hi[(size_t) i] = (float) ckt.v[(size_t) iH]; lo[(size_t) i] = (float) ckt.v[(size_t) iL]; }
            else { hi[(size_t) i] = 0; lo[(size_t) i] = 0; }
        }
    }
    double sr; std::vector<Osc> osc; std::vector<std::vector<float>> v; std::vector<float> hi, lo;
    Circuit ckt; std::array<Src*, 6> src {}; int iH, iL;
    std::function<bool()> active;
};

struct Shared { NoiseBus* noise; MetalCircuit* metal; };

} // namespace t8
