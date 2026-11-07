// C++ port of voices/circuit-voice.js: the base of the component-level voices (stages, links, trigger switch, sleep).
#pragma once
#include "Shared.h"
#include <map>

namespace t8 {

// Audio (A) taper: 10% of the resistance at mid rotation
inline double aTaper(double x) { x = clamp(x, 0, 1); return (std::exp(4.394 * x) - 1) / (std::exp(4.394) - 1); }

class Pot {
public:
    Pot(Circuit& c_, const char* a, const char* w, const char* b, double R_) : c(&c_), R(R_) {
        top = a ? c->R(a, w, R / 2) : nullptr;
        bot = b ? c->R(w, b, R / 2) : nullptr;
    }
    void set(double pos) {
        const double r = clamp(pos, 0, 1) * R;
        if (top) top->g = 1 / std::max(1.0, R - r);
        if (bot) bot->g = 1 / std::max(1.0, r);
        c->touch();
    }
    Circuit* c; double R; Res* top; Res* bot;
};

class CircuitVoice : public Voice {
public:
    CircuitVoice(double sr_, std::vector<ParamSpec> spec, Shared sh) : Voice(sr_, std::move(spec)), shared(sh), dcBlock(sr_, 2, true) {}

    struct PartRef { Circuit* c; Res* r; Cap* cap; double v0; };
    template <class T> T* part(Circuit& c, T* el, const std::string& group);
    void scale(const std::string& group, double k) {
        auto it = parts.find(group); if (it == parts.end()) return;
        for (auto& q : it->second) {
            if (q.cap) q.cap->c = q.v0 * k; else q.r->g = 1 / (q.v0 * k);
            q.c->touch();
        }
    }
    void pitchMetal(double m, bool ic3, double spread, const std::vector<int>& idx = {}) {
        if (std::abs(m - 1) < 1e-6 && std::abs(spread - 1) < 1e-6) { ownMetal.reset(); return; }
        if (!ownMetal) {
            ownMetal = std::make_unique<MetalCircuit>(sr);
            ownMetal->active = [ic3] { return ic3; };
        }
        ownMetal->setPitch(m, spread, idx);
    }
    void set(const std::string& id, double v) override {
        if (id == "drive") {
            pv[(size_t) find("drive")] = v; dk = driveGain(v); dComp = driveComp(dk);
            scale("fbR", dk); scale("fbC", 1 / dk);
        }
        Voice::set(id, v);
    }
    Circuit& stage(const std::vector<std::string>& nodes) {
        stages.push_back(std::make_unique<Circuit>(nodes));
        auto& c = *stages.back();
        c.setTimestep(1 / sr);
        return c;
    }
    Src* feed(Circuit& c, const char* node, double ohms, std::function<double(int)> get) {
        Src* s = c.Rsrc(node, ohms, 0); s->get = std::move(get); c.feeds.push_back(s); return s;
    }
    Src* link(Circuit& c, const char* node, double ohms, Circuit& from, const char* fromNode) {
        const int k = from.idx.at(fromNode); Circuit* f = &from;
        return feed(c, node, ohms, [f, k](int) { return f->v[(size_t) k]; });
    }
    Src* rail(Circuit& c, const char* node, double volts) { return c.Rsrc(node, 1, volts); }
    Src* addTrigger(Circuit& c, const char* node, double ohms = 100) {
        Src* s = c.Rsrc(node, ohms, 0); s->on = false; s->c = &c; switches.push_back(s); return s;
    }
    virtual double triggerVolts(double accent) { return busVoltage(accent); }
    MetalCircuit& mc() { return warmBank ? *warmBank : ownMetal ? *ownMetal : *shared.metal; }
    void finish(int steps = 3000, double warmSecs = 0) {
        onParam();
        for (auto& cp : stages) {
            Circuit& c = *cp;
            const double d = c.dt; c.setTimestep(1e4);
            for (int i = 0; i < 30; i++) { feedAll(c, 0); c.step(300, 1e-9); }
            for (auto& cap : c.caps) cap.i = 0;
            c.setTimestep(d);
        }
        for (int i = 0; i < steps; i++) tick(0);
        if (warmSecs > 0) {
            auto bank = std::make_unique<MetalCircuit>(sr);
            warmBank = bank.get();
            for (int i = 0, n = (int) jsround(warmSecs * sr); i < n; i++) { bank->render(1); tick(0); }
            warmBank = nullptr;
        }
        idle = 1e9;
    }
    void feedAll(Circuit& c, int i) { for (Src* s : c.feeds) s->v = s->get(i); }
    void tick(int i) {
        for (Src* s : switches) if (s->on && --s->left <= 0) { s->on = false; s->c->touch(); }
        pre(i);
        for (auto& c : stages) { feedAll(*c, i); c->step(); }
    }
    void fire(Src* sw, double accent, double width = TRIG_WIDTH) {
        sw->v = triggerVolts(accent); sw->on = true; sw->left = (int) std::max(1.0, jsround(width * sr));
        sw->c->touch();
        idle = 0; quiet = 0;
    }
    void trigger(double accent) override { fire(switches[0], accent); }
    bool awake() const override { return !(idle > minAwake * sr && quiet > sleepAfter * sr); }
    bool ownsDriveFlag() const override { return true; }
    virtual double output() = 0;
    virtual void pre(int) {}
    virtual void post(int, int, bool) {}
    virtual void preRender(int) {}
    void render(float* out, int n) override {
        preRender(n);
        if (!awake()) { post(0, n, false); return; }
        if (ownMetal) ownMetal->render(n);
        for (int i = 0; i < n; i++) {
            tick(i);
            const double y = dcBlock.tick(dk == 1 ? output() : railClip(output()) * dComp);
            out[i] += y;
            post(i, 1, true);
            quiet = std::abs(y) < 5e-3 ? quiet + 1 : 0;
            idle++;
        }
    }

    Shared shared;
    std::vector<std::unique_ptr<Circuit>> stages;
    std::vector<Src*> switches;
    double idle = 1e9, quiet = 0, sleepAfter = 0.2, minAwake = 0.25;
    OnePole dcBlock;
    std::map<std::string, std::vector<PartRef>> parts;
    std::unique_ptr<MetalCircuit> ownMetal;
    MetalCircuit* warmBank = nullptr;
    double dk = 1, dComp = 1;
};

template <> inline Res* CircuitVoice::part<Res>(Circuit& c, Res* el, const std::string& group) {
    parts[group].push_back({ &c, el, nullptr, 1 / el->g }); return el;
}
template <> inline Cap* CircuitVoice::part<Cap>(Circuit& c, Cap* el, const std::string& group) {
    parts[group].push_back({ &c, nullptr, el, el->c }); return el;
}

} // namespace t8
