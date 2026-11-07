#pragma once
#include "CircuitVoice.h"

namespace t8 {

double voicingTrigger(double accent);

class BDCircuit : public Voice {
public:
    explicit BDCircuit(double sr);
    void onParam() override;
    void trigger(double accent) override;
    void render(float* out, int n) override;
    bool awake() const override { return true; } // (no awake getter in the JS: the kit's `?? true`)
    bool ownsDriveFlag() const override { return true; }
    Circuit ckt; Src* sw; Cap* c38; Cap* c40; Cap* cT[2]; Res* vr6; Res* vr5;
    OnePole hp; int pulseLeft = 0; double idle = 1e9; int oversample = 1; double dk = 1, dComp = 1;
};

class SDCircuit : public CircuitVoice {
public:
    SDCircuit(double sr, Shared sh);
    void onParam() override;
    double output() override { return s3->v[(size_t) iOut]; }
    Circuit *s1 = nullptr, *s2 = nullptr, *s3 = nullptr; Src* wiper = nullptr; std::unique_ptr<Pot> tone; Res* vr7 = nullptr;
    double k9 = 0; int iOut = 0;
};

class TomCircuit : public CircuitVoice {
public:
    TomCircuit(double sr, Shared sh, const std::string& key);
    void onParam() override;
    double output() override { return s2->v[(size_t) iOut]; }
    std::string key; Circuit *s1 = nullptr, *s2 = nullptr; Res *vrA = nullptr, *vrB = nullptr, *vr10 = nullptr, *r232 = nullptr;
    double r232g0 = 0; int iOut = 0;
};

class RSCLCircuit : public CircuitVoice {
public:
    RSCLCircuit(double sr, Shared sh, bool rs);
    void pre(int) override;
    void onParam() override;
    double output() override { return s3->v[(size_t) iOut]; }
    bool rs; Circuit *s1 = nullptr, *s2 = nullptr, *s3 = nullptr; Res* vr16 = nullptr; Dyn* fet = nullptr;
    int iG = 0, iNV = 0, iOut = 0;
};

class CPCircuit : public CircuitVoice {
public:
    CPCircuit(double sr, Shared sh);
    void pre(int) override;
    void onParam() override;
    void trigger(double accent) override;
    double output() override { return mix->v[(size_t) iOut] * accGain; }
    double accGain = 1, tm3 = 0;
    Circuit *s1 = nullptr, *s2 = nullptr, *s3 = nullptr, *s3x = nullptr, *s4 = nullptr, *mix = nullptr;
    Src* tm = nullptr; std::vector<Dyn*> cmp; Dyn* ota = nullptr; Res* r376 = nullptr; Res* vr17 = nullptr;
    int iOut = 0, ixTH = 0, ixOC = 0, ixOB = 0, ixDm = 0, ixDp = 0, ixIA = 0, ixI2 = 0;
};

class MACircuit : public CircuitVoice {
public:
    MACircuit(double sr, Shared sh);
    void onParam() override;
    double output() override { return mix->v[(size_t) iOut]; }
    Circuit *s1 = nullptr, *s1b = nullptr, *s2 = nullptr, *mix = nullptr; Res* vr17 = nullptr; int iOut = 0;
};

class CBCircuit : public CircuitVoice {
public:
    CBCircuit(double sr, Shared sh);
    double triggerVolts(double accent) override { return voicingTrigger(accent); }
    void onParam() override;
    double output() override { return s2->v[(size_t) iOut] * dk; }
    Circuit *s1 = nullptr, *s2 = nullptr; Res *vrT = nullptr, *vrB = nullptr; int iOut = 0;
};

class CYCircuit : public CircuitVoice {
public:
    CYCircuit(double sr, Shared sh);
    double triggerVolts(double accent) override { return voicingTrigger(accent); }
    void onParam() override;
    double output() override { return s5->v[(size_t) iOut]; }
    void vca(Circuit& c, std::function<double(int)> src, const std::string& tag, const char* sNode);
    Circuit *s1 = nullptr, *s2 = nullptr, *s3 = nullptr, *s4 = nullptr, *s5 = nullptr;
    Res *vr2 = nullptr, *vr4a = nullptr, *vr4b = nullptr, *vr6 = nullptr; int iOut = 0;
};

class CHCircuit;
class OHCircuit : public CircuitVoice {
public:
    OHCircuit(double sr, Shared sh);
    double triggerVolts(double accent) override { return voicingTrigger(accent); }
    void choke() override;
    void post(int, int n, bool) override { if (chokeHold > 0) chokeHold -= n; }
    void onParam() override;
    double output() override { return mix->v[(size_t) iOut]; }
    CHCircuit* chokeFrom = nullptr; double chokeHold = 0; Src* chokeFeed = nullptr; Src* vr3 = nullptr; Res* vrL = nullptr;
    Circuit *s1 = nullptr, *s2 = nullptr, *s3 = nullptr, *mix = nullptr; int iOut = 0;
};

class CHCircuit : public CircuitVoice {
public:
    CHCircuit(double sr, Shared sh);
    double triggerVolts(double accent) override { return voicingTrigger(accent); }
    void preRender(int n) override { if ((int) e28.size() < n) e28.assign((size_t) n, 0.f); }
    void post(int i, int n, bool awake) override;
    void onParam() override;
    double output() override { return mix->v[(size_t) iOut]; }
    std::vector<float> e28; Res* vrL = nullptr; Circuit *s1 = nullptr, *s2 = nullptr, *s3 = nullptr, *mix = nullptr;
    int iOut = 0, iE28 = 0;
};

std::unique_ptr<Voice> makeCircuit(const std::string& id, double sr, Shared sh);

} // namespace t8
