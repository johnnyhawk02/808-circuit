// C++ port of dsp/cache.js (CachedVoice) and the parts of dsp/kit.js the app uses: every voice as its circuit
// simulation and as cached circuit hits, the shared noise and metal circuits, the closed hat choking the open one.
#pragma once
#include "VoicesCircuit.h"
#include "Json.h"
#include <array>

namespace t8 {

struct CacheInfo {
    double sr = 48000, scale = 1;
    std::vector<std::array<int, 2>> normal, accent, dryNormal, dryAccent;
    std::vector<double> level;
    bool hasKnobs = false; std::vector<std::pair<std::string, double>> knobs;
    static CacheInfo fromJson(const Json& j);
    double knob(const char* id, bool& found) const { for (auto& k : knobs) if (k.first == id) { found = true; return k.second; } found = false; return 0; }
};
// a voice's hits, cut and scaled (shared, immutable once built: built off the audio thread)
struct CacheData {
    CacheInfo info;
    std::vector<std::vector<float>> normal, accent, dryNormal, dryAccent;
    static std::shared_ptr<CacheData> build(const CacheInfo& info, const int16_t* pcm, size_t n);
};

class CachedVoice : public Voice {
public:
    CachedVoice(double sr, std::vector<ParamSpec> params) : Voice(sr, std::move(params)) {}
    bool loaded() const { return data != nullptr; }
    void load(std::shared_ptr<const CacheData> d) { data = std::move(d); rate = data->info.sr / sr; plays.clear(); }
    void trigger(double accent) override;
    void render(float* out, int n) override;
    bool awake() const override { return !plays.empty(); }
    bool ownsDriveFlag() const override { return true; }
    void choke() override { for (auto& pl : plays) if (!pl.hasCut) { pl.hasCut = true; pl.cut = pl.pos; } }
    std::shared_ptr<const CacheData> data;
private:
    double rnd() { uint32_t x = rng; x ^= x << 13; x ^= x >> 17; x ^= x << 5; rng = x; return rng / 4294967296.0; }
    double levelGain() const;
    double fade(double len) const;
    struct Play {
        const std::vector<float>* a; const std::vector<float>* b; const std::vector<float>* da; const std::vector<float>* db;
        double snap, mix, pos = 0, len = -1, cut = 0; bool hasCut = false;
        std::shared_ptr<const CacheData> keep; // (the hits it plays stay alive while it does)
    };
    std::vector<Play> plays;
    int last = -1; uint32_t rng = 0x9e3779b9; double rate = 1;
};

extern const char* const VOICE_IDS[16];
int voiceIndex(const std::string& id);

class Kit {
public:
    explicit Kit(double sr);
    void set(const std::string& id, const std::string& param, double value);
    void setModel(const std::string& id, const std::string& model);
    void loadCache(const std::string& id, std::shared_ptr<const CacheData> d) { cached[(size_t) voiceIndex(id)]->load(std::move(d)); }
    void fire(const std::string& id, double accent);
    // n frames; each voice into split[i] (added)
    void render(float* const* split, int n);
    const std::vector<ParamSpec>& params(int i) const { return circuit[(size_t) i]->params; }

    double sr;
    std::unique_ptr<NoiseBus> noise; std::unique_ptr<MetalCircuit> metal;
    std::array<std::unique_ptr<Voice>, 16> circuit;
    std::array<std::unique_ptr<CachedVoice>, 16> cached;
    std::array<Voice*, 16> voices {};
    std::array<int, 16> model {}; // 0 circuit, 1 cached
    std::array<double, 16> accentAmt {};
private:
    bool usesCircuit(const int* ids, int count) const;
};

} // namespace t8
