#include "Kit.h"
#include <algorithm>

namespace t8 {

const char* const VOICE_IDS[16] = { "bd", "sd", "lt", "mt", "ht", "lc", "mc", "hc", "rs", "cl", "cp", "ma", "cb", "cy", "oh", "ch" };
int voiceIndex(const std::string& id) { for (int i = 0; i < 16; i++) if (id == VOICE_IDS[i]) return i; return -1; }

CacheInfo CacheInfo::fromJson(const Json& j) {
    CacheInfo c;
    c.sr = j["sr"].num(48000); c.scale = j["scale"].num(1);
    auto ranges = [](const Json& a, std::vector<std::array<int, 2>>& out) {
        for (auto& r : a.items()) out.push_back({ (int) r[(size_t) 0].num(), (int) r[(size_t) 1].num() });
    };
    ranges(j["normal"], c.normal); ranges(j["accent"], c.accent); ranges(j["dryNormal"], c.dryNormal); ranges(j["dryAccent"], c.dryAccent);
    for (auto& x : j["level"].items()) c.level.push_back(x.num());
    if (c.level.size() < 2) c.level = { 0, 1 };
    if (j["knobs"].isObject()) { c.hasKnobs = true; for (auto& kv : j["knobs"].entries()) c.knobs.emplace_back(kv.first, kv.second.num()); }
    return c;
}

std::shared_ptr<CacheData> CacheData::build(const CacheInfo& info, const int16_t* pcm, size_t n) {
    auto d = std::make_shared<CacheData>();
    d->info = info;
    const double s = info.scale / 32767;
    auto cut = [&](const std::array<int, 2>& r) {
        std::vector<float> x((size_t) std::max(0, r[1]));
        for (int i = 0; i < r[1]; i++) { const size_t k = (size_t) (r[0] + i); x[(size_t) i] = (float) ((k < n ? pcm[k] : 0) * s); }
        return x;
    };
    for (auto& r : info.normal) d->normal.push_back(cut(r));
    for (auto& r : info.accent) d->accent.push_back(cut(r));
    if (!info.dryNormal.empty()) {
        for (auto& r : info.dryNormal) d->dryNormal.push_back(cut(r));
        for (auto& r : info.dryAccent) d->dryAccent.push_back(cut(r));
    }
    return d;
}

void CachedVoice::trigger(double accent) {
    if (!data) return;
    const int n = (int) data->normal.size();
    if (n == 0) return;
    int k = (int) std::floor(rnd() * n);
    if (k == last && n > 1) k = (k + 1 + (int) std::floor(rnd() * (n - 1))) % n;
    last = k;
    const auto& d = *data;
    const double snap = !d.dryNormal.empty() ? clamp(p("snap", 0), 0, 1) : 0;
    Play pl;
    pl.a = &d.normal[(size_t) k]; pl.b = &d.accent[(size_t) k];
    pl.da = snap ? &d.dryNormal[(size_t) k] : nullptr; pl.db = snap ? &d.dryAccent[(size_t) k] : nullptr;
    pl.snap = snap; pl.mix = clamp(accent, 0, 1); pl.keep = data;
    plays.push_back(pl);
    if (plays.size() > 8) plays.erase(plays.begin());
}

double CachedVoice::levelGain() const {
    const auto& t = data->info.level;
    const double x = clamp(p("level", 1), 0, 1) * (double) (t.size() - 1);
    const int i = std::min((int) t.size() - 2, (int) std::floor(x));
    return t[(size_t) i] + (t[(size_t) i + 1] - t[(size_t) i]) * (x - i);
}
double CachedVoice::fade(double len) const {
    bool found = false;
    double def = data->info.knob("decay", found);
    if (!found) { int i = find("decay"); if (i < 0) return 0; def = params[(size_t) i].def; }
    const double d = clamp(p("decay"), 0, 1);
    return d >= def ? 0 : 3 * (def / std::max(d, 0.01) - 1) / (len / data->info.sr);
}

void CachedVoice::render(float* out, int n) {
    if (plays.empty()) return;
    const double g = levelGain(), step = rate, isr = 1 / data->info.sr;
    for (auto& pl : plays) {
        const double m = pl.mix;
        const std::vector<float>& a = m == 1 ? *pl.b : *pl.a;
        const std::vector<float>& b = (m == 0 || m == 1) ? a : *pl.b;
        const std::vector<float>* da = m == 1 ? pl.db : pl.da;
        const std::vector<float>* db = (m == 0 || m == 1) ? da : pl.db;
        const double sn = pl.snap;
        if (pl.len < 0) {
            double L = (double) std::min(a.size(), b.size());
            if (da) L = std::min(L, (double) da->size());
            if (db) L = std::min(L, (double) db->size());
            pl.len = L;
        }
        const double len = pl.len, k = fade(len);
        double pos = pl.pos;
        for (int i = 0; i < n && pos < len - 1; i++, pos += step) {
            const int j = (int) pos; const double f = pos - j;
            double xa = a[(size_t) j] + ((double) a[(size_t) j + 1] - a[(size_t) j]) * f;
            if (sn) xa += ((*da)[(size_t) j] + ((double) (*da)[(size_t) j + 1] - (*da)[(size_t) j]) * f - xa) * sn;
            double y = xa;
            if (&b != &a) {
                double xb = b[(size_t) j] + ((double) b[(size_t) j + 1] - b[(size_t) j]) * f;
                if (sn) xb += ((*db)[(size_t) j] + ((double) (*db)[(size_t) j + 1] - (*db)[(size_t) j]) * f - xb) * sn;
                y = xa + (xb - xa) * m;
            }
            if (k) y *= std::exp(-k * pos * isr);
            if (pl.hasCut) { const double c = 1 - (pos - pl.cut) * isr * 100; if (c <= 0) { pos = len; break; } y *= c; }
            out[i] += y * g;
        }
        pl.pos = pos;
    }
    plays.erase(std::remove_if(plays.begin(), plays.end(), [](const Play& pl) { return !(pl.pos < pl.len - 1); }), plays.end());
}

static const int NOISE_IDX[] = { 1, 2, 3, 4, 10, 11 };   // sd lt mt ht cp ma
static const int METAL_IDX[] = { 12, 13, 14, 15 };      // cb cy oh ch
static const int ORDER[] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 14 }; // CH before OH (the choke)

Kit::Kit(double sr_) : sr(sr_) {
    noise = std::make_unique<NoiseBus>(sr);
    metal = std::make_unique<MetalCircuit>(sr);
    Shared sh { noise.get(), metal.get() };
    for (int i = 0; i < 16; i++) circuit[(size_t) i] = makeCircuit(VOICE_IDS[i], sr, sh);
    static_cast<OHCircuit*>(circuit[14].get())->chokeFrom = static_cast<CHCircuit*>(circuit[15].get());
    for (int i = 0; i < 16; i++) {
        // (the JS gives the cached voice the synth voice's knob list: the same ids and defaults as the circuit's)
        cached[(size_t) i] = std::make_unique<CachedVoice>(sr, circuit[(size_t) i]->params);
        accentAmt[(size_t) i] = 1;
        setModel(VOICE_IDS[i], "circuit");
    }
}

void Kit::set(const std::string& id, const std::string& param, double value) {
    const int i = voiceIndex(id); if (i < 0) return;
    if (param == "accent") { accentAmt[(size_t) i] = std::max(0.0, std::min(1.0, value)); return; }
    circuit[(size_t) i]->set(param, value);
    cached[(size_t) i]->set(param, value);
}
void Kit::setModel(const std::string& id, const std::string& m) {
    const int i = voiceIndex(id); if (i < 0) return;
    // (no synth model here: a voice set to cached before its hits arrive plays the circuit)
    model[(size_t) i] = m == "cached" && cached[(size_t) i]->loaded() ? 1 : 0;
    voices[(size_t) i] = model[(size_t) i] ? (Voice*) cached[(size_t) i].get() : circuit[(size_t) i].get();
}
void Kit::fire(const std::string& id, double accent) {
    const int i = voiceIndex(id); if (i < 0) return;
    if (i == 15) { // ch: the open hat's cached hits fade; the circuit OH is choked by CH's envelope, or by a pulse
        cached[14]->choke();
        if (model[15] != 0) circuit[14]->choke();
    }
    voices[(size_t) i]->trigger(accent * accentAmt[(size_t) i]);
}
bool Kit::usesCircuit(const int* ids, int count) const {
    for (int k = 0; k < count; k++) { const int i = ids[k]; if (model[(size_t) i] == 0 || circuit[(size_t) i]->awake()) return true; }
    return false;
}
void Kit::render(float* const* split, int n) {
    if (usesCircuit(NOISE_IDX, 6)) noise->render(n);
    const bool met = usesCircuit(METAL_IDX, 4);
    metal->active = [met] { return met; };
    metal->render(n);
    for (int i : ORDER) voices[(size_t) i]->render(split[i], n);
    for (int i = 0; i < 16; i++) {
        Voice* other = model[(size_t) i] ? (Voice*) circuit[(size_t) i].get() : (Voice*) cached[(size_t) i].get();
        // (circuit first, then cached, as the JS walks its models)
        if (model[(size_t) i]) { if (other->awake()) other->render(split[i], n); }
        else if (other->awake()) other->render(split[i], n);
    }
}

} // namespace t8
