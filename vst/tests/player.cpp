// Runs the C++ Player through the session tests/ref-player.mjs scripted and compares its output with the JS's.
// g++ -std=c++17 -O2 -ffp-contract=off -Isrc -o /tmp/player tests/player.cpp src/dsp/*.cpp && /tmp/player /tmp/refp
#include "dsp/Player.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <chrono>
#include <map>

using namespace t8;

static std::vector<uint8_t> unb64(const std::string& s) {
    static int T[256]; static bool init = false;
    if (!init) { for (int i = 0; i < 256; i++) T[i] = -1; const char* a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (int i = 0; i < 64; i++) T[(unsigned char) a[i]] = i; init = true; }
    std::vector<uint8_t> out; int val = 0, bits = -8;
    for (unsigned char c : s) { if (T[c] < 0) continue; val = (val << 6) + T[c]; bits += 6; if (bits >= 0) { out.push_back((uint8_t) ((val >> bits) & 0xff)); bits -= 8; } }
    return out;
}
template <class T> static std::vector<T> as(const std::vector<uint8_t>& b) { std::vector<T> v(b.size() / sizeof(T)); std::memcpy(v.data(), b.data(), v.size() * sizeof(T)); return v; }

int main(int argc, char** argv) {
    const std::string dir = argc > 1 ? argv[1] : "/tmp/refp";
    const double FS = 48000;
    std::ifstream lf(dir + "/log.jsonl");
    std::vector<std::pair<long, Json>> log;
    for (std::string line; std::getline(lf, line);) {
        if (line.empty()) continue;
        bool ok; Json j = Json::parse(line, &ok);
        if (!ok) { std::printf("bad log line\n"); return 1; }
        Json m = j["m"];
        const std::string type = m["type"].str();
        if (type == "cache808") {
            auto pcm = as<int16_t>(unb64(m["pcm64"].str()));
            m.blob = CacheData::build(CacheInfo::fromJson(m["info"]), pcm.data(), pcm.size());
        } else if (type == "verbIr") {
            auto L = as<float>(unb64(m["irL64"].str())), R = as<float>(unb64(m["irR64"].str()));
            m.blob = IrSpectra::prepare(L, R, m["frac"].num());
        }
        log.emplace_back((long) j["at"].num(), std::move(m));
    }
    std::ifstream rf(dir + "/out.f32", std::ios::binary);
    std::vector<float> ref((std::istreambuf_iterator<char>(rf)), {});
    { std::vector<float> r2(ref.size() / 1); } // (placeholder)
    rf.close();
    std::ifstream rf2(dir + "/out.f32", std::ios::binary); rf2.seekg(0, std::ios::end); const size_t bytes = (size_t) rf2.tellg(); rf2.seekg(0);
    ref.assign(bytes / 4, 0.f); rf2.read((char*) ref.data(), (std::streamsize) bytes);
    const long N = (long) ref.size() / 2;

    Player p(FS);
    std::vector<float> L((size_t) N), R((size_t) N);
    std::vector<std::string> events;
    size_t li = 0; const int BLK = 128;
    auto t0 = std::chrono::steady_clock::now();
    for (long f = 0; f < N; f += BLK) {
        while (li < log.size() && log[li].first <= f) p.msg(log[li++].second);
        p.process(L.data() + f, R.data() + f, (int) std::min<long>(BLK, N - f));
        for (auto& ev : p.events) {
            Json e = Json::object(); e.set("f", (double) f);
            if (ev["type"].str() == "recData") {
                auto d = std::static_pointer_cast<const Player::Recorded>(ev.blob); double s = 0; for (float x : d->L) s += std::abs(x);
                e.set("type", "recData"); e.set("n", (double) d->L.size()); e.set("sumL", s);
            } else for (auto& kv : ev.entries()) e.set(kv.first, kv.second);
            events.push_back(e.dump());
        }
        p.events.clear();
    }
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    double err = 0, sig = 0, mx = 0; long first = -1;
    for (long i = 0; i < N; i++) for (int c = 0; c < 2; c++) {
        const double a = ref[(size_t) (2 * i + c)], b = c ? R[(size_t) i] : L[(size_t) i], d = a - b;
        err += d * d; sig += a * a; if (std::abs(d) > mx) mx = std::abs(d);
        if (first < 0 && std::abs(d) > 1e-6) first = i;
    }
    std::printf("C++ player: %.0f ms for %.1f s (%.0fx real time)\n", ms, N / FS, N / FS * 1000 / ms);
    std::printf("output: SNR %.1f dB, max err %.3g, first diff > 1e-6 at %ld (%.3f s)\n", 10 * std::log10(sig / (err + 1e-300)), mx, first, first / FS);
    // envelope (50 ms RMS, dB) where the reference is above -60 dBFS
    double envMax = 0; long envAt = -1; const long W = (long) (0.05 * FS);
    for (long w = 0; w + W <= N; w += W) {
        double a = 0, b = 0;
        for (long i = w; i < w + W; i++) { a += ref[(size_t) (2 * i)] * ref[(size_t) (2 * i)]; b += (double) L[(size_t) i] * L[(size_t) i]; }
        a = std::sqrt(a / W); b = std::sqrt(b / W);
        if (a < 1e-3) continue;
        const double d = std::abs(20 * std::log10((b + 1e-12) / a));
        if (d > envMax) { envMax = d; envAt = w; }
    }
    std::printf("envelope: within %.2f dB (worst at %.2f s)\n", envMax, envAt / FS);
    // events
    std::ifstream ef(dir + "/events.jsonl"); std::vector<std::string> refEv;
    for (std::string line; std::getline(ef, line);) if (!line.empty()) refEv.push_back(Json::parse(line).dump());
    size_t same = 0, firstEv = (size_t) -1;
    for (size_t i = 0; i < std::min(refEv.size(), events.size()); i++) {
        const Json a = Json::parse(refEv[i]), b = Json::parse(events[i]);
        bool eq = a["type"].str() == b["type"].str() && a["f"].num() == b["f"].num();
        if (eq && a["type"].str() == "step") eq = a["step"].num() == b["step"].num() && a["bar"].num() == b["bar"].num() && a["hits"].dump() == b["hits"].dump();
        if (eq && a["type"].str() == "rec") eq = a["state"].str() == b["state"].str();
        if (eq && a["type"].str() == "recData") eq = a["n"].num() == b["n"].num();
        if (eq) same++; else if (firstEv == (size_t) -1) firstEv = i;
    }
    std::printf("events: %zu JS, %zu C++, %zu the same in order", refEv.size(), events.size(), same);
    if (firstEv != (size_t) -1) std::printf("; first differs at #%zu:\n  JS  %s\n  C++ %s", firstEv, refEv[firstEv].c_str(), events[firstEv].c_str());
    std::printf("\n");
    FILE* o = std::fopen((dir + "/cpp.f32").c_str(), "wb");
    for (long i = 0; i < N; i++) { std::fwrite(&L[(size_t) i], 4, 1, o); std::fwrite(&R[(size_t) i], 4, 1, o); }
    std::fclose(o);
    return 0;
}
