// C++ port of the parts of dsp/core.js the circuit and cached voices use.
#pragma once
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

namespace t8 {

inline double clamp(double x, double lo, double hi) { return x < lo ? lo : x > hi ? hi : x; }
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }

constexpr double PITCH_SEMIS = 12, DECAY_SPAN = 3;
constexpr double VSAT = 13.5, KNEE = 0.8;
inline double railClip(double x, double vsat = VSAT) {
    const double xl = KNEE * vsat, ax = std::abs(x);
    if (ax <= xl) return x;
    const double w = vsat - xl;
    return (x > 0 ? 1.0 : x < 0 ? -1.0 : 0.0) * (xl + w * std::tanh((ax - xl) / w));
}
constexpr double DRIVE_PEAK = 4;
inline double driveGain(double v) { const double c = std::max(0.0, std::min(1.0, v)); return 1 + 23 * std::pow(c, 2); }
inline double driveComp(double k) { return DRIVE_PEAK / railClip(k * DRIVE_PEAK); }
// (v ?? 0.5): callers pass the knob value
inline double pitchMul(double v) { return std::pow(2.0, ((clamp(v, 0, 1) - 0.5) * 2 * PITCH_SEMIS) / 12); }
inline double decayMul(double v) { return std::pow(DECAY_SPAN, (clamp(v, 0, 1) - 0.5) * 2); }
inline double amtMul(double v) { return 2 * clamp(v, 0, 1); }
inline double spanMul(double v, double span) { return std::pow(span, (clamp(v, 0, 1) - 0.5) * 2); }
inline double spreadExp(double v) { v = clamp(v, 0, 1); return v < 0.5 ? lerp(0.25, 1, v * 2) : lerp(1, 2.5, v * 2 - 1); }

// spreadFactors(freqs, s, idx): idx empty = all
inline std::vector<double> spreadFactors(const std::vector<double>& freqs, double s, const std::vector<int>& idxIn) {
    std::vector<int> idx = idxIn;
    if (idx.empty()) for (int i = 0; i < (int) freqs.size(); i++) idx.push_back(i);
    double acc = 0; for (int i : idx) acc = acc + std::log(freqs[(size_t) i]);
    const double gm = std::exp(acc / (double) idx.size());
    std::vector<double> out;
    for (int i = 0; i < (int) freqs.size(); i++) {
        bool in = false; for (int j : idx) if (j == i) in = true;
        out.push_back(in ? std::pow(freqs[(size_t) i] / gm, s - 1) : 1.0);
    }
    return out;
}

class OnePole {
public:
    OnePole(double sr_, double f = 1000, bool hp_ = false) : sr(sr_), hp(hp_) { set(f); }
    void set(double f) { a = 1 - std::exp((-2 * M_PI * std::min(f, sr * 0.45)) / sr); }
    double tick(double x) { z += a * (x - z); return hp ? x - z : z; }
    double sr, a = 0, z = 0; bool hp;
};

struct ParamSpec { std::string id, name; double def; };

inline ParamSpec P_PITCH() { return { "pitch", "Pitch", 0.5 }; }
inline ParamSpec P_DECAY() { return { "decay", "Decay", 0.5 }; }
inline ParamSpec P_DRIVE() { return { "drive", "Drive", 0 }; }
inline ParamSpec knobSpec(const char* id, const char* name) { return { id, name, 0.5 }; }

// Voice: the knob list (DRIVE appended) and values, as in dsp/core.js
class Voice {
public:
    Voice(double sr_, std::vector<ParamSpec> spec) : sr(sr_) {
        bool hasDrive = false; for (auto& q : spec) if (q.id == "drive") hasDrive = true;
        params = std::move(spec);
        if (!hasDrive) params.push_back(P_DRIVE());
        for (auto& s : params) pv.push_back(s.def);
    }
    virtual ~Voice() = default;
    int find(const char* id) const { for (size_t i = 0; i < params.size(); i++) if (params[i].id == id) return (int) i; return -1; }
    // the value of knob id (def if the voice has no such knob: the JS reads undefined and each caller defaults it)
    double p(const char* id, double dflt = 0.5) const { int i = find(id); return i < 0 ? dflt : pv[(size_t) i]; }
    bool has(const char* id) const { return find(id) >= 0; }
    virtual void set(const std::string& id, double v) {
        int i = find(id.c_str());
        if (i < 0) { extra.push_back({ id, v }); onParam(); return; } // (a knob the voice doesn't list: kept, as the JS keeps any key)
        pv[(size_t) i] = v; onParam();
    }
    virtual void onParam() {}
    virtual void trigger(double accent) = 0;
    virtual void render(float* out, int n) = 0;
    virtual bool awake() const { return true; }
    virtual bool ownsDriveFlag() const { return false; }
    virtual void choke() {}

    double sr;
    std::vector<ParamSpec> params;
    std::vector<double> pv;
    std::vector<std::pair<std::string, double>> extra;
};

} // namespace t8
