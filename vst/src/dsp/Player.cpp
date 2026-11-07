#include "Player.h"
#include <algorithm>
#include <cstring>

namespace t8 {

using lxr::REAL_FS;
static const double PI = 3.141592653589793;


// bar conditions: 0 every bar; n = only the last bar of every n; -n = every bar except that one; 100 + n = only the
// first bar of every n
static bool barOk(double b, int bar) {
    if (!b || b != b) return true;
    if (b > 100) return std::fmod(bar, b - 100) == 0;
    if (b > 0) return std::fmod(bar, b) == b - 1;
    return std::fmod(bar, -b) != -b - 1;
}
static double delaySamples(double pos, double bpm) { return 240 / bpm * std::pow(2, -7 * (1 - pos)) * REAL_FS; }
static const double VERB_MAKEUP = 1;
static const double G808 = 2.4, VOLT_SCALE = 1.0 / 24;
// each 808 voice's track (BUS808), by VOICE_IDS order: bd sd lt mt ht lc mc hc rs cl cp ma cb cy oh ch
static const int BUS808[16] = { 0, 3, 1, 1, 1, 2, 2, 2, 3, 2, 3, 2, 2, 4, 6, 5 };
static double rushHash(int t, int pg, int s) {
    uint32_t h = (uint32_t) (t * 131 + pg * 17 + s + 1) * 0x9e3779b1u;
    h ^= h >> 15; h = h * 0x85ebca77u; h ^= h >> 13;
    return h / 4294967296.0;
}

Player::Player(double outRate) : ratio(REAL_FS / outRate), hpLog(std::log(30.0)), verb(REAL_FS) {
    e.loadInitKit();
    gain.fill(1); gainTo.fill(1); fxAmt.fill(1); fxAmt.fill(1);
    for (int k = 0; k < 8; k++) spF[(size_t) k] = std::tan(PI * 60 * std::pow(2, k * 1.1) / REAL_FS);
    spG.fill(1);
    delayPos = 1 + std::log2(3.0 / 16) / 7;
    dist.fxType = lxr::FX_DISTORTION; dist.forceWet = true;
    t808.fill(-1);
    for (auto& s : sched) s.reserve(16);
    queue.reserve(64);
    render(A); render(B);
}

static void readPage(const Json& P, std::array<std::array<uint8_t, 16>, 7>& on, std::array<std::array<uint8_t, 16>, 7>& acc, std::array<std::array<double, 16>, 7>& cond) {
    for (int t = 0; t < 7; t++) for (int s = 0; s < 16; s++) {
        on[(size_t) t][(size_t) s] = P["on"][(size_t) t][(size_t) s].truthy();
        acc[(size_t) t][(size_t) s] = P["acc"][(size_t) t][(size_t) s].truthy();
        cond[(size_t) t][(size_t) s] = P["bar"][(size_t) t][(size_t) s].num(0);
    }
}

void Player::msg(const Json& m) {
    const std::string& type = m["type"].str();
    if (type == "param") e.setParam((int) m["par"].num(), (int) m["value"].num());
    else if (type == "kit") { std::vector<int> v; for (auto& x : m["values"].items()) v.push_back((int) x.num()); e.loadKit(v); }
    else if (type == "trig") { const int voice = (int) m["voice"].num(); const double vl = m["vel"].num(); hit(voice, vl, vl >= 127); gainTo[(size_t) std::min(std::max(voice, 0), 5)] = 1; }
    else if (type.size() >= 3 && type.compare(type.size() - 3, 3, "808") == 0) msg808(m);
    else if (type == "rush") { rush = m["v"].num(); if (m.has("t")) rushT = (int) m["t"].num(); }
    else if (type == "rushSet") {
        const Json& s = m["set"];
        auto take = [&](const char* k, double& v) { if (s.has(k)) v = s[k].num(); };
        take("start", rs.start); take("p32", rs.p32); take("top", rs.top); take("hats", rs.hats); take("only", rs.only); take("kicks", rs.kicks);
        take("first", rs.first); take("hp", rs.hp); take("hpTop", rs.hpTop); take("rollMs", rs.rollMs); take("hpMs", rs.hpMs);
    }
    else if (type == "mute") { const Json& mu = m["muted"]; for (size_t n = 0; n < mu.size() && n < 6; n++) muted[n] = mu[n].truthy() ? 1 : 0; }
    else if (type == "xmod") return; // (Elixir 808: no crossfeed)
    else if (type == "delay") delayPos = m["pos"].num();
    else if (type == "verbIr") { if (m.blob) verb.load(std::static_pointer_cast<const IrSpectra>(m.blob)); }
    else if (type == "atBar") { if (playing) atBar.push_back(m["m"]); else msg(m["m"]); }
    else if (type == "mix") {
        if (m.has("master")) {
            const Json& M = m["master"];
            auto take = [&](const char* k, double& v) { if (M.has(k)) v = M[k].num(); };
            take("comp", master.comp); take("thresh", master.thresh); take("ratio", master.ratio); take("attack", master.attack);
            take("release", master.release); take("makeup", master.makeup); take("duck", master.duck); take("duckRelease", master.duckRelease);
            take("duckFx", master.duckFx); take("duckOn", master.duckOn); take("space", master.space);
        }
        if (m["dist"].truthy()) {
            const Json& d = m["dist"];
            dist.distortion.type = (int) d["type"].num();
            for (size_t i = 0; i < d["p"].size(); i++) dist.setParameter((int) i, d["p"][i].num() / 127);
            distMix = d["mix"].num(0) / 100;
            if (m["verb"].truthy()) {
                const Json& v = m["verb"]; IrVerb::Knobs k;
                if (v.has("pre")) { k.hasPre = true; k.pre = v["pre"].num(); }
                if (v.has("low")) { k.hasLow = true; k.low = v["low"].num(); }
                if (v.has("tone")) { k.hasTone = true; k.tone = v["tone"].num(); }
                if (v.has("width")) { k.hasWidth = true; k.width = v["width"].num(); }
                if (v.has("gate")) { k.hasGate = true; k.gate = v["gate"].num(); }
                if (v.has("gfine")) { k.hasGfine = true; k.gfine = v["gfine"].num(); }
                verb.set(k);
            }
            for (size_t i = 0; i < 6; i++) { sendD[i] = (float) m["sendD"][i].num(); sendR[i] = (float) m["sendR"][i].num(); }
            const Json& echo = m["echo"];
            echoWidth = echo["pct"].num() / 100;
            echoSync = !(echo.has("sync") && echo["sync"].kind() == Json::Bool && !echo["sync"].truthy());
            echoFree = echo.has("free") && !echo["free"].isNull() ? echo["free"].num() : 0.25;
            echoFine = echo["fine"].num(0);
        }
        for (size_t i = 0; i < 6; i++) fxAmt[i] = (float) m["fx"][i].num();
    }
    else if (type == "rec") {
        // recorder: free starts now; a loop waits for the first step of a bar and stops after its bars
        Rec r; const double bars = m["bars"].num(0); const bool count = m["count"].truthy();
        r.loop = bars > 0; r.bars = (int) bars; r.on = !(bars > 0) && !count;
        r.count = count ? (playing ? "wait" : "run") : "";
        r.L.assign(16384, 0.f); r.R.assign(16384, 0.f);
        rec = std::move(r);
        if (rec->count == "run") { cntStep = 0; toNext = 0; }
        Json ev = Json::object(); ev.set("type", "rec"); ev.set("state", rec->on ? "on" : rec->count == "run" ? "count" : "wait");
        events.push_back(std::move(ev));
    }
    else if (type == "recStop") { if (rec) recEnd(); }
    else if (type == "seq") {
        // a live pattern change wins over one still waiting for the bar
        atBar.erase(std::remove_if(atBar.begin(), atBar.end(), [](const Json& q) { return q["type"].str() == "seq"; }), atBar.end());
        const Json& P = m["pattern"];
        hasPages = P["pages"].isArray();
        if (hasPages) { pages.assign(P["pages"].size(), Page {}); for (size_t i = 0; i < pages.size(); i++) readPage(P["pages"][i], pages[i].on, pages[i].acc, pages[i].cond); }
        else readPage(P, single.on, single.acc, single.cond);
        patternOn = !(m.has("patternOn") && m["patternOn"].kind() == Json::Bool && !m["patternOn"].truthy());
        bpm = m["bpm"].num();
        if (m["groove"].truthy()) for (int t = 0; t < 7; t++) for (int s = 0; s < 16; s++) grooveOff[(size_t) t][(size_t) s] = m["groove"]["off"][(size_t) t][(size_t) s].num(0);
        vel = m["vel"].num(); e.bpm = bpm;
        accGain = std::pow(10, -m["accentDb"].num() / 20);
        const bool mp = m["playing"].truthy();
        if (mp && !playing) { rushPh.reset(); rushHead = false; step = 0; bar = 0; toNext = 0; queue.clear(); fresh = true; }
        const bool was = playing; playing = mp;
        if (!playing) { flushBar(); if (rec && (rec->loop || !rec->count.empty()) && (was || rec->count != "run")) recEnd(); }
    }
}
void Player::recFlush() {
    Rec& r = *rec;
    if (r.n) {
        auto d = std::make_shared<Recorded>();
        d->L.assign(r.L.begin(), r.L.begin() + r.n); d->R.assign(r.R.begin(), r.R.begin() + r.n);
        Json ev = Json::object(); ev.set("type", "recData"); ev.blob = d;
        events.push_back(std::move(ev));
    }
    r.n = 0;
}
void Player::recEnd() {
    recFlush();
    Json ev = Json::object(); ev.set("type", "rec"); ev.set("state", "done"); ev.set("bars", (double) rec->done); ev.set("bpm", bpm);
    events.push_back(std::move(ev));
    rec.reset();
}
void Player::flushBar() {
    std::vector<Json> q; q.swap(atBar);
    for (auto& m : q) {
        if (m["type"].str() == "seq") { Json c = m; c.set("playing", playing); msg(c); }
        else msg(m);
    }
}
void Player::schedule(int s, int br, double at0) {
    const int pg = hasPages && !pages.empty() ? br % (int) pages.size() : 0;
    const Page& P = hasPages ? (pages.empty() ? single : pages[(size_t) pg]) : single;
    std::vector<int>& hits = sched[(size_t) s]; hits.clear();
    const double len = REAL_FS * 60 / bpm / 4;
    if (hasLanes) {
        for (const Lane& L : lanes) {
            const int t = BUS808[L.id], k = (br % lanePages) * 16 + s;
            if (!L.on[(size_t) k] || muted[(size_t) std::min(t, 5)]) continue;
            Q q; q.at = std::max(0.0, at0 + grooveOff[(size_t) t][(size_t) s] * len); q.t = t; q.lane = L.id; q.acc = L.acc[(size_t) k];
            queue.push_back(q);
            hits.push_back(t);
        }
        return;
    }
    if (rush && patternOn) { scheduleRush(s, br, pg, P, at0, len, hits); return; }
    for (int t = 0; t < 7 && patternOn; t++) {
        if (!P.on[(size_t) t][(size_t) s] || !barOk(P.cond[(size_t) t][(size_t) s], br) || muted[(size_t) std::min(t, 5)]) continue;
        Q q; q.at = std::max(0.0, at0 + grooveOff[(size_t) t][(size_t) s] * len); q.t = t; q.acc = P.acc[(size_t) t][(size_t) s];
        queue.push_back(q);
        hits.push_back(t);
    }
}
void Player::scheduleRush(int s, int br, int pg, const Page& P, double at0, double len, std::vector<int>& hits) {
    const int rt = rushT;
    const double R = rush; const RushSet& S = rs;
    const double p = std::pow(std::min(1.0, R / S.only), 2.5), pHat = std::pow(std::min(1.0, R / S.hats), 2.5);
    bool snare = R > S.start, sAcc = false, orig = false;
    for (int t = 0; t < 7; t++) {
        if (!P.on[(size_t) t][(size_t) s] || !barOk(P.cond[(size_t) t][(size_t) s], br)) continue;
        orig = true;
        const bool down = !t && !(s & 3);
        if (down && (R >= S.first || (R >= S.kicks && s))) continue;
        if (t == rt || (!down && rushHash(t, pg, s) < (t >= 5 ? pHat : p))) { snare = true; sAcc = sAcc || P.acc[(size_t) t][(size_t) s]; continue; }
        if (muted[(size_t) std::min(t, 5)]) continue;
        Q q; q.at = std::max(0.0, at0 + grooveOff[(size_t) t][(size_t) s] * len); q.t = t; q.acc = P.acc[(size_t) t][(size_t) s];
        queue.push_back(q);
        hits.push_back(t);
    }
    const int rtc = std::min(std::max(rt, 0), 6);
    if (snare && !muted[(size_t) std::min(rtc, 5)]) {
        const int n = R > (S.start + S.p32) / 2 ? 2 : 1;
        const double at = R > S.start ? at0 : at0 + grooveOff[(size_t) rtc][(size_t) s] * len;
        const double sw = R > S.start ? 0.6 + 0.4 * (R - S.start) / (100 - S.start) : 1;
        for (int i = 0; i < n; i++) {
            const bool first = !i && orig;
            Q q; q.at = std::max(0.0, at + i * len / n); q.t = rt; q.acc = first && sAcc; q.sw = sw; q.roll = R > S.start ? (first ? 2 : 1) : 0;
            queue.push_back(q);
        }
        hits.push_back(3);
    }
}
void Player::spacer(const float* key, float* XL, float* XR) {
    const double FS = REAL_FS, cut = master.space / 100 * 0.9, k = 1 / 1.4;
    double* S = spS.data();
    const double att = 1 - std::exp(-64 / (0.003 * FS)), rel = std::exp(-64000 / (master.duckRelease * FS));
    for (int b = 0; b < 8; b++) {
        const double g = spF[(size_t) b], a = 1 / (1 + g * (g + k)); const int o = b * 6;
        double pk = 0, s1 = S[o], s2 = S[o + 1];
        for (int i = 0; i < 64; i++) {
            const double hp = (key[i] - (g + k) * s1 - s2) * a, bp = g * hp + s1;
            s1 = g * hp + bp; s2 += 2 * g * bp;
            const double m = bp < 0 ? -bp : bp; if (m > pk) pk = m;
        }
        S[o] = s1; S[o + 1] = s2;
        pk *= k;
        spEnv[(size_t) b] = (float) (pk > spEnv[(size_t) b] ? spEnv[(size_t) b] + (pk - spEnv[(size_t) b]) * att : spEnv[(size_t) b] * rel);
        const double ev = spEnv[(size_t) b];
        const double g0 = spG[(size_t) b], g1 = 1 - cut * std::min(1.0, ev / 0.04);
        spG[(size_t) b] = (float) g1;
        if (g0 == 1 && g1 == 1) {
            for (int c = 0; c < 2; c++) {
                const float* X = c ? XR : XL; double t1 = S[o + 2 + 2 * c], t2 = S[o + 3 + 2 * c];
                for (int i = 0; i < 64; i++) { const double hp = (X[i] - (g + k) * t1 - t2) * a, bp = g * hp + t1; t1 = g * hp + bp; t2 += 2 * g * bp; }
                S[o + 2 + 2 * c] = t1; S[o + 3 + 2 * c] = t2;
            }
            continue;
        }
        for (int c = 0; c < 2; c++) {
            float* X = c ? XR : XL; double t1 = S[o + 2 + 2 * c], t2 = S[o + 3 + 2 * c];
            for (int i = 0; i < 64; i++) {
                const double hp = (X[i] - (g + k) * t1 - t2) * a, bp = g * hp + t1;
                t1 = g * hp + bp; t2 += 2 * g * bp;
                X[i] = (float) (X[i] + (g0 + (g1 - g0) * (i + 1) / 64 - 1) * bp * k);
            }
            S[o + 2 + 2 * c] = t1; S[o + 3 + 2 * c] = t2;
        }
    }
}
void Player::ensureKit() {
    if (k808) return;
    k808 = std::make_unique<Kit>(REAL_FS);
    for (int i = 0; i < 16; i++) { k808->setModel(VOICE_IDS[i], "cached"); split[(size_t) i] = b808[(size_t) i].data(); }
    for (auto& v : vmix) { v.vol = 1; v.pl = std::sqrt(64 / 127.0); v.pr = std::sqrt(63 / 127.0); v.echo = 0; v.verb = 0; }
}
void Player::msg808(const Json& m) {
    ensureKit();
    Kit& K = *k808;
    const std::string& type = m["type"].str();
    if (type == "map808") { t808.fill(-1); for (size_t t = 0; t < 7 && t < m["map"].size(); t++) t808[t] = m["map"][t].isString() ? voiceIndex(m["map"][t].str()) : -1; }
    else if (type == "lanes808") {
        hasLanes = m["lanes"].isObject(); lanes.clear();
        if (hasLanes) for (auto& kv : m["lanes"].entries()) {
            Lane L; L.id = voiceIndex(kv.first);
            if (L.id < 0) continue; // (BUS808 has no track for it)
            for (size_t k = 0; k < 64; k++) { L.on[k] = kv.second["on"][k].truthy(); L.acc[k] = kv.second["acc"][k].truthy(); }
            lanes.push_back(L);
        }
        lanePages = std::max(1, std::min(4, m["pages"].truthy() ? (int) m["pages"].num() : 1));
    }
    else if (type == "hit808") {
        const int id = voiceIndex(m["id"].str());
        int t = 3;
        if (id >= 0) { t = BUS808[id]; for (int i = 0; i < 7; i++) if (t808[(size_t) i] == id) { t = i; break; } }
        hit(t, 127, m["acc"].truthy(), id); gainTo[(size_t) std::min(t, 5)] = 1;
    }
    else if (type == "set808") K.set(m["id"].str(), m["param"].str(), m["value"].num());
    else if (type == "vmix808") {
        const int id = voiceIndex(m["id"].str()); if (id < 0) return;
        const double pan = m["pan"].num();
        vmix[(size_t) id] = { m["vol"].num() / 127, std::sqrt((127 - pan) / 127), std::sqrt(pan / 127), m["echo"].num() / 100, m["verb"].num() / 100 };
    }
    else if (type == "model808") { const int id = voiceIndex(m["id"].str()); if (id < 0) return; want808[(size_t) id] = m["model"].str(); K.setModel(m["id"].str(), m["model"].str()); }
    else if (type == "cache808") {
        const int id = voiceIndex(m["id"].str()); if (id < 0 || !m.blob) return;
        K.loadCache(m["id"].str(), std::static_pointer_cast<const CacheData>(m.blob));
        K.setModel(m["id"].str(), want808[(size_t) id].empty() ? "cached" : want808[(size_t) id]);
    }
}
void Player::hit(int t, double, bool acc, int lane) {
    if (!k808) return;
    const int id = lane >= 0 ? lane : (t >= 0 && t < 7 ? t808[(size_t) t] : -1);
    if (id < 0) return;
    k808->fire(VOICE_IDS[id], acc ? 1 : 0);
}
void Player::render808() {
    for (auto& b : b808) b.fill(0.f);
    k808->render(split.data(), 64);
    const double g = VOLT_SCALE * G808 * 32768;
    for (int id = 0; id < 16; id++) {
        const float* b = b808[(size_t) id].data(); float* v = vbuf[(size_t) id].data();
        const double gv = g * vmix[(size_t) id].vol;
        double pk = 0;
        for (int i = 0; i < 64; i++) { const double x = b[i] * gv; v[i] = (float) x; const double a = x < 0 ? -x : x; if (a > pk) pk = a; }
        vpk[(size_t) id] = pk;
    }
}
int Player::track808(int id) const {
    if (!hasLanes) for (int i = 0; i < 7; i++) if (t808[(size_t) i] == id) return i;
    return BUS808[id];
}
void Player::clickAt(bool hi) { clk = Clk { 0, 0, 2 * PI * (hi ? 1760 : 880) / REAL_FS }; }

void Player::render(std::array<std::array<float, 64>, 2>& dst) {
    if (!playing && rec && rec->count == "run") {
        const double len = REAL_FS * 60 / bpm / 4;
        while (toNext <= 0 && !playing) {
            if (cntStep == 16) {
                rec->count = "end"; playing = true; step = 0; bar = 0; queue.clear(); fresh = true;
                Json ev = Json::object(); ev.set("type", "rec"); ev.set("state", "play"); events.push_back(std::move(ev));
            } else { if (cntStep % 4 == 0) clickAt(cntStep == 0); cntStep++; toNext += len; }
        }
        if (!playing) toNext -= 64;
    }
    if (playing) {
        if (toNext <= 0) {
            if (step == 0 && !atBar.empty()) flushBar();
            if (step == 0 && rec) {
                Rec& r = *rec;
                if (r.count == "wait") { r.count = "run"; Json ev = Json::object(); ev.set("type", "rec"); ev.set("state", "count"); events.push_back(std::move(ev)); }
                else if (!r.on) { r.on = true; r.count.clear(); Json ev = Json::object(); ev.set("type", "rec"); ev.set("state", "on"); events.push_back(std::move(ev)); }
                else if (!r.loop) r.done++;
                else if (++r.done >= r.bars) recEnd();
                if (rec && rec->loop && rec->on) { Json ev = Json::object(); ev.set("type", "rec"); ev.set("state", "bar"); ev.set("done", (double) rec->done); events.push_back(std::move(ev)); }
            }
            if (rec && rec->count == "run" && step % 4 == 0) clickAt(step == 0);
            const double len = REAL_FS * 60 / bpm / 4;
            if (fresh) { fresh = false; schedule(step, bar, toNext); }
            const int next = (step + 1) % 16;
            // (the step's own hits are reported before the next step's booking replaces them)
            Json hitsJ = Json::array(); for (int t : sched[(size_t) step]) hitsJ.push((double) t);
            schedule(next, next == 0 ? bar + 1 : bar, toNext + len);
            Json ev = Json::object(); ev.set("type", "step"); ev.set("step", (double) step); ev.set("bar", (double) bar);
            ev.set("hits", next == step ? Json::array() : std::move(hitsJ)); ev.set("gr", gr); ev.set("duck", duckMin);
            events.push_back(std::move(ev));
            if (next != step) sched[(size_t) step].clear();
            gr = 0; duckMin = 1;
            step = next;
            if (step == 0) bar++;
            toNext += len;
        }
        toNext -= 64;
    } else if (!queue.empty()) queue.clear();
    // the free roll above the 1/32 point
    const RushSet& S = rs;
    if (playing && patternOn && rush > S.p32) {
        const double len = REAL_FS * 60 / bpm / 4, target = std::min(1 + (rush - S.p32) * (S.top - 1) / (100 - S.p32), std::log2(len / 256));
        if (!rushPh) { rushLog = target; rushPh = std::fmod(2 * (1 - (toNext + 64) / len), 1.0); }
        else rushLog += (target - rushLog) * (1 - std::exp(-64 / (S.rollMs / 1000 * REAL_FS)));
        const double rate = std::min(std::pow(2, rushLog), len / 256), d = rate * 64 / len;
        const double sw = 0.6 + 0.4 * (rush - S.start) / (100 - S.start);
        double ph = *rushPh;
        for (double k = std::floor(ph) + 1; k <= ph + d; k++) {
            const bool h = rushHead, hAcc = rushHeadAcc; rushHead = false;
            Q q; q.at = (k - ph) / d * 64; q.t = rushT; q.acc = h && hAcc; q.sw = sw; q.free = true;
            queue.push_back(q);
        }
        rushPh = std::fmod(ph + d, 1.0); rushGap = len / rate / 2;
    } else { rushPh.reset(); rushHead = false; }
    // hits due in this block
    if (!queue.empty()) {
        std::vector<Q> keep; keep.reserve(queue.size());
        for (Q& q : queue) {
            if (q.at < 64 && rush > S.p32 && (q.roll || q.free) && (q.roll || clock - snareAt < rushGap)) { if (q.roll == 2) { rushHead = true; rushHeadAcc = q.acc; } }
            else if (q.at < 64) {
                if (q.t == rushT) snareAt = clock;
                const int tc = std::min(std::max(q.t, 0), 5);
                if (!muted[(size_t) tc]) {
                    const double sw = q.sw ? q.sw : 1;
                    hit(q.t, q.acc ? 127 : std::max(1.0, jsround(vel * sw)), q.acc, q.lane);
                    const bool is808 = k808 && (q.lane >= 0 || (q.t >= 0 && q.t < 7 && t808[(size_t) q.t] >= 0));
                    gainTo[(size_t) tc] = (float) (q.acc ? 1 : is808 ? sw : accGain * sw);
                }
            }
            else { q.at -= 64; keep.push_back(q); }
        }
        queue.swap(keep);
    }
    clock += 64;
    e.renderBlock();
    if (k808) render808();
    float* L = dst[0].data(); float* R = dst[1].data();
    std::fill(L, L + 64, 0.f); std::fill(R, R + 64, 0.f);
    const Master& M = master;
    const bool isDelay = e.fx.fxType == lxr::FX_DELAY;
    e.fx.forceWet = isDelay;
    const double eTime = echoSync ? delaySamples(delayPos, bpm) : (1 + 1999 * echoFree) / 1000 * REAL_FS;
    e.fx.setDelaySync(isDelay, eTime * (1 + echoFine / 10000));
    double pk = 0;
    if (k808) pk = vpk[0] * gainTo[(size_t) track808(0)]; // (the kick keys it)
    pk = pk / 32768 * (k808 ? 1 : gainTo[0]);
    duckEnv = std::max(pk, duckEnv * std::exp(-64000 / (M.duckRelease * REAL_FS)));
    const double duck0 = duckAt, duck1 = 1 - (M.duckOn ? M.duck : 0) * std::min(1.0, duckEnv / 0.3);
    duckAt = duck1; duckMin = std::min(duckMin, duck1);
    const bool sp = M.duckOn && M.space > 0;
    float* XL = sp ? spL.data() : L; float* XR = sp ? spR.data() : R;
    if (sp) { spL.fill(0.f); spR.fill(0.f); } else if (spOn) { spS.fill(0); spEnv.fill(0.f); spG.fill(1.f); }
    spOn = sp;
    // (the LXR voices are silent: their part of the mix is only the accent gain's step)
    for (int n = 0; n < 6; n++) gain[(size_t) n] = gainTo[(size_t) n];
    float* fe = k808 ? fxExtra.data() : nullptr;
    if (fe) {
        fxExtra.fill(0.f);
        for (int id = 0; id < 16; id++) {
            if (!vpk[(size_t) id]) continue;
            const float* b = vbuf[(size_t) id].data(); const VMix& M8 = vmix[(size_t) id];
            const int t = track808(id), c = std::min(t, 5); const bool kick = id == 0;
            const double a0 = gainTo[(size_t) c] * (kick ? 1 : duck0), a1 = gainTo[(size_t) c] * (kick ? 1 : duck1), da = (a1 - a0) / 64;
            float* OL = kick ? L : XL; float* OR = kick ? R : XR;
            const double pl = M8.pl / 32768, pr = M8.pr / 32768, el = M8.pl * M8.echo, er = M8.pr * M8.echo;
            double lv = 0;
            for (int i = 0; i < 64; i++) {
                const double v = b[i] * (a0 + da * i); OL[i] = (float) (OL[i] + v * pl); OR[i] = (float) (OR[i] + v * pr);
                if (el + er) { fe[2 * i] = (float) (fe[2 * i] + v * el); fe[2 * i + 1] = (float) (fe[2 * i + 1] + v * er); }
                const double a = v < 0 ? -v : v; if (a > lv) lv = a;
            }
            lv *= std::max(pl, pr); if (lv > lvl[(size_t) c]) lvl[(size_t) c] = (float) lv;
            if (lv > vlv[(size_t) id]) { vlv[(size_t) id] = lv; vlvSeen[(size_t) id] = true; }
        }
    }
    if (sp) {
        float* key = spKey.data();
        for (int i = 0; i < 64; i++) key[i] = (float) (((double) L[i] + R[i]) / 2);
        spacer(key, XL, XR);
        for (int i = 0; i < 64; i++) { L[i] = (float) ((double) L[i] + XL[i]); R[i] = (float) ((double) R[i] + XR[i]); }
    }
    if (++lvlN >= 16) {
        lvlN = 0;
        bool on = false; for (float x : lvl) if (x > 1e-4) on = true;
        if (on || lvlOn) {
            Json ev = Json::object(); ev.set("type", "lvl");
            Json l = Json::array(); for (float x : lvl) l.push((double) x); ev.set("l", std::move(l));
            Json v = Json::object(); for (int id = 0; id < 16; id++) if (vlvSeen[(size_t) id]) v.set(VOICE_IDS[id], vlv[(size_t) id]);
            ev.set("v", std::move(v));
            events.push_back(std::move(ev));
        }
        lvlOn = on; lvl.fill(0.f); vlv.fill(0);
    }
    const int16_t* fx = e.renderFx(echoWidth, true, fe);
    const double fd0 = M.duckFx ? duck0 : 1, fdd = M.duckFx ? (duck1 - duck0) / 64 : 0;
    {
        // the reverb's bus: each 808 sound at its send, then mono into the convolution
        float* bi = busIn.data(); busIn.fill(0.f);
        bool any = false;
        for (int n = 0; n < 6; n++) { const double g = sendR[(size_t) n] * gainTo[(size_t) n] * (n ? duck1 : 1); if (g) any = true; }
        if (k808) for (int id = 0; id < 16; id++) {
            const VMix& M8 = vmix[(size_t) id]; if (!M8.verb || !vpk[(size_t) id]) continue;
            any = true;
            const float* b = vbuf[(size_t) id].data();
            const double g = M8.verb * gainTo[(size_t) std::min(track808(id), 5)] * (id == 0 ? 1 : duck1), pl = M8.pl * g, pr = M8.pr * g;
            for (int i = 0; i < 64; i++) { bi[2 * i] = (float) (bi[2 * i] + b[i] * pl); bi[2 * i + 1] = (float) (bi[2 * i + 1] + b[i] * pr); }
        }
        float* vi = verbIn.data();
        if (any) for (int i = 0; i < 64; i++) vi[i] = (float) (((double) bi[2 * i] + bi[2 * i + 1]) / 65536); else verbIn.fill(0.f);
        verb.bpm = bpm; verb.process(vi, L, R, VERB_MAKEUP * fd0, VERB_MAKEUP * (fd0 + fdd * 64));
    }
    for (int i = 0; i < 64; i++) { const double g = (fd0 + fdd * i) / 32768; L[i] = (float) (L[i] + fx[2 * i] * g); R[i] = (float) (R[i] + fx[2 * i + 1] * g); }
    if (distMix || distAt) {
        int16_t* bi = dist.input;
        for (int i = 0; i < 64; i++) {
            bi[2 * i] = (int16_t) std::max(-32768.0, std::min(32767.0, jsround(L[i] * 32768.0)));
            bi[2 * i + 1] = (int16_t) std::max(-32768.0, std::min(32767.0, jsround(R[i] * 32768.0)));
        }
        int16_t* bo = busOut.data(); busOut.fill(0);
        dist.process(bo, 64);
        const double m0 = distAt, m1 = distMix;
        for (int i = 0; i < 64; i++) {
            const double m = m0 + (m1 - m0) * (i + 1) / 64;
            L[i] = (float) (L[i] + (bo[2 * i] / 32768.0 - L[i]) * m); R[i] = (float) (R[i] + (bo[2 * i + 1] / 32768.0 - R[i]) * m);
        }
        distAt = m1;
    }
    if (rush > S.hp || hpOn) highPass(L, R);
    if (M.comp) {
        const double ca = std::exp(-1000 / (M.attack * REAL_FS)), cr = std::exp(-1000 / (M.release * REAL_FS));
        const double slope = 1 / M.ratio - 1, mk = std::pow(10, M.makeup / 20);
        double env = compEnv, g2 = gr;
        for (int i = 0; i < 64; i++) {
            const double peak = std::max(std::abs((double) L[i]), std::abs((double) R[i])) + 1e-9;
            const double over = std::max(0.0, 20 * std::log10(peak) - M.thresh);
            env = over + (over > env ? ca : cr) * (env - over);
            const double g = std::pow(10, env * slope / 20) * mk;
            L[i] = (float) (L[i] * g); R[i] = (float) (R[i] * g);
            g2 = std::max(g2, -env * slope);
        }
        compEnv = env; gr = g2;
    }
    if (rec && rec->on) {
        Rec& r = *rec;
        std::copy(L, L + 64, r.L.begin() + r.n); std::copy(R, R + 64, r.R.begin() + r.n); r.n += 64;
        if (r.n == (int) r.L.size()) recFlush();
    }
    const double to = rec && rec->count == "run" ? 0.25 : 1;
    if (to != 1 || cntGain != 1 || clk) {
        double g = cntGain;
        for (int i = 0; i < 64; i++) {
            g += (to - g) * 0.003; if (std::abs(to - g) < 1e-4) g = to;
            double c = 0;
            if (clk) {
                Clk& k = *clk;
                c = 0.35 * std::sin(k.ph) * std::min(1.0, k.n / 48) * std::exp(-k.n / (0.04 * REAL_FS));
                k.ph += k.w; if (++k.n > 0.15 * REAL_FS) clk.reset();
            }
            L[i] = (float) (L[i] * g + c); R[i] = (float) (R[i] * g + c);
        }
        cntGain = g;
    }
}
void Player::highPass(float* L, float* R) {
    const double FS = REAL_FS, lo = std::log(30.0); const bool up = rush > rs.hp;
    const double target = up ? lo + std::log(rs.hpTop / 30) * std::min(1.0, (rush - rs.hp) / (100 - rs.hp)) : lo;
    if (!hpOn) { hpOn = true; hpLog = lo; hpMix = 0; hpS.fill(0); hpG = std::tan(PI * 30 / FS); }
    hpLog += (target - hpLog) * (1 - std::exp(-64 / (rs.hpMs / 1000 * FS)));
    if (!up && hpLog - lo < 0.01) hpLog = lo;
    const double g0 = hpG, g1 = std::tan(PI * std::exp(hpLog) / FS), k = 1 / 0.9;
    const double m0 = hpMix, m1 = up || hpLog > lo ? std::min(1.0, m0 + 0.15) : std::max(0.0, m0 - 0.15);
    for (int i = 0; i < 64; i++) {
        const double g = g0 + (g1 - g0) * (i + 1) / 64, a = 1 / (1 + g * (g + k)), m = m0 + (m1 - m0) * (i + 1) / 64;
        for (int c = 0; c < 2; c++) {
            float* X = c ? R : L; const double x = X[i], s1 = hpS[(size_t) (2 * c)], s2 = hpS[(size_t) (2 * c + 1)];
            const double hp = (x - (g + k) * s1 - s2) * a, bp = g * hp + s1, lp = g * bp + s2;
            hpS[(size_t) (2 * c)] = g * hp + bp; hpS[(size_t) (2 * c + 1)] = g * bp + lp;
            X[i] = (float) (x + (hp - x) * m);
        }
    }
    hpG = g1; hpMix = m1;
    if (!m1 && !up) { hpOn = false; hpS.fill(0); }
}
void Player::process(float* Lo, float* Ro, int n) {
    for (int j = 0; j < n; j++) {
        while (idx >= 64) { std::swap(A, B); render(B); idx -= 64; }
        const int i = idx; const double fr = frac;
        const double l0 = A[0][(size_t) i], r0 = A[1][(size_t) i];
        const double l1 = i < 63 ? A[0][(size_t) i + 1] : B[0][0];
        const double r1 = i < 63 ? A[1][(size_t) i + 1] : B[1][0];
        Lo[j] = (float) (l0 + (l1 - l0) * fr);
        Ro[j] = (float) (r0 + (r1 - r0) * fr);
        frac += ratio;
        const double k = std::floor(frac);
        idx += (int) k; frac -= k;
    }
}

} // namespace t8
