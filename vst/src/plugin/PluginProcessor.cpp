#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "Assets.h"
#include "dsp/LxrTables.h"

namespace t8 {

// localStorage keys kept with each plugin instance (the project's sound, patterns and mix). Every other key (the preset
// library, favourites, settings) is shared by all instances, in the user's 808 Circuit folder, as in a browser.
static const char* const PER_KEYS[] = { "elixir808-tr808", "elixir808-pats", "elixir808-vmix", "elixir808-lanes", "elixir808-rush",
    "elixir808-seqgroove", "elixir808-rec", "elixir808-recmode", "elixir808-loopbars", "elixir808-nextbar", "elixir808-xy2", "elixir808-tab" };
bool Processor::isPerInstanceKey(const std::string& k) const { for (auto* p : PER_KEYS) if (k == p) return true; return false; }

static juce::File globalFile() {
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory).getChildFile("808 Circuit").getChildFile("storage.json");
}
static std::map<std::string, std::string> readGlobal() {
    std::map<std::string, std::string> out;
    const juce::File f = globalFile();
    if (!f.existsAsFile()) return out;
    const Json j = Json::parse(f.loadFileAsString().toStdString());
    for (auto& kv : j.entries()) if (kv.second.isString()) out[kv.first] = kv.second.str();
    return out;
}

// the init kit as the page sends it (app/kit.js: the init kit with the FX slot as the delay)
static Json initKitMsg() {
    using namespace lxr;
    std::vector<int> kit((size_t) PAR_END_OF_SOUND_PARAMETERS, 0);
    for (int i = 8; i < PAR_END_OF_SOUND_PARAMETERS; i++) kit[(size_t) i - 8] = INIT_KIT[i];
    if (kit[(size_t) PAR_FX_TYPE] != FX_DELAY) { kit[(size_t) PAR_FX_TYPE] = FX_DELAY; kit[(size_t) PAR_FX_P1 + 2] = 90; kit[(size_t) PAR_FX_P1 + 3] = 50; }
    Json v = Json::array(); for (int x : kit) v.push((double) x);
    Json m = Json::object(); m.set("type", "kit"); m.set("values", std::move(v));
    return m;
}
static Json msgOf(const char* type) { Json m = Json::object(); m.set("type", type); return m; }

Processor::Processor()
    : AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
    {
        // a new instance starts from the last state used anywhere (as the web app does on reopening)
        const juce::ScopedLock sl(lock);
        for (auto& kv : readGlobal()) if (isPerInstanceKey(kv.first)) store[kv.first] = kv.second;
    }
    rebuildPatterns();
    player = freshPlayer(false);
    scratchL.resize(8192); scratchR.resize(8192);
    startTimerHz(30);
}
Processor::~Processor() {
    stopTimer();
    flushGlobal();
    while (Json* j = toAudio.pop()) delete j;
    while (Json* j = toMessage.pop()) delete j;
    while (Json* j = trash.pop()) delete j;
    while (Player* p = playerTrash.pop()) delete p;
    delete pendingPlayer.exchange(nullptr);
}

bool Processor::isBusesLayoutSupported(const BusesLayout& l) const {
    const auto& out = l.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}
void Processor::prepareToPlay(double sampleRate, int block) {
    outRate = sampleRate;
    if (player) player->setOutRate(sampleRate);
    if (auto* p = pendingPlayer.load()) p->setOutRate(sampleRate);
    if ((int) scratchL.size() < block) { scratchL.resize((size_t) block); scratchR.resize((size_t) block); }
}

// ---- a player made here: the page's start-up defaults, the shipped hits, then the latest of each message ----
std::unique_ptr<Player> Processor::freshPlayer(bool withSnapshot) {
    auto p = std::make_unique<Player>(outRate);
    std::vector<Json> msgs;
    msgs.push_back(initKitMsg());
    {
        Json m = msgOf("map808"); Json map = Json::array();
        for (const char* id : { "bd", "lt", "ht", "sd", "cy", "ch", "oh" }) map.push(id);
        m.set("map", std::move(map)); msgs.push_back(std::move(m));
    }
    const Shipped& sh = shipped();
    for (int i = 0; i < 16; i++) {
        Json m = msgOf("model808"); m.set("id", VOICE_IDS[i]); m.set("model", "cached"); msgs.push_back(std::move(m));
        if (sh.data[(size_t) i]) { Json c = msgOf("cache808"); c.set("id", VOICE_IDS[i]); c.set("shipped", true); msgs.push_back(std::move(c)); }
    }
    if (withSnapshot) for (auto& m : replayList()) msgs.push_back(m);
    for (auto& m : msgs) {
        preprocess(m);
        if (m["type"].str() == "seq") m.set("playing", false);
        p->msg(m);
    }
    p->events.clear();
    return p;
}
std::vector<Json> Processor::replayList() {
    const juce::ScopedLock sl(lock);
    std::vector<Json> out; out.reserve(snapshot.size());
    for (auto& kv : snapshot) out.push_back(kv.second);
    return out;
}

void Processor::preprocess(Json& m) {
    const std::string& type = m["type"].str();
    if (type == "atBar") { preprocess(m.at("m")); return; }
    if (type == "cache808") {
        const int id = voiceIndex(m["id"].str());
        if (id < 0) return;
        if (m["shipped"].truthy()) { m.blob = shipped().data[(size_t) id]; return; }
        const auto b = bytesOf(m["pcm"]);
        std::vector<int16_t> pcm(b.size() / 2);
        if (!pcm.empty()) std::memcpy(pcm.data(), b.data(), pcm.size() * 2);
        m.blob = CacheData::build(CacheInfo::fromJson(m["info"]), pcm.data(), pcm.size());
    } else if (type == "verbIr") {
        const Json& h = m["h"];
        if (!h["raw"].truthy()) return;
        auto floats = [](const std::vector<uint8_t>& b) { std::vector<float> v(b.size() / 4); if (!v.empty()) std::memcpy(v.data(), b.data(), v.size() * 4); return v; };
        const auto L = floats(bytesOf(h["L"])), R = floats(bytesOf(h["R"]));
        if (L.empty()) return;
        m.blob = IrSpectra::prepare(L, R, h["frac"].num(1));
    }
}

// the latest message of each kind, keyed so that the map's order is the order they're replayed in
void Processor::record(const Json& mIn) {
    const std::string& type = mIn["type"].str();
    if (type == "atBar") { record(mIn["m"]); return; }
    Json m = mIn; m.blob.reset();
    const juce::ScopedLock sl(lock);
    auto put = [&](const std::string& k) { snapshot[k] = std::move(m); };
    if (type == "kit") {
        for (auto it = snapshot.begin(); it != snapshot.end();) it = it->first.rfind("01param:", 0) == 0 ? snapshot.erase(it) : std::next(it);
        put("00kit");
    }
    else if (type == "param") { char k[32]; std::snprintf(k, sizeof k, "01param:%04d", (int) m["par"].num()); put(k); }
    else if (type == "map808") put("02map808");
    else if (type == "set808") put("03set808:" + m["id"].str() + ":" + m["param"].str());
    else if (type == "model808") put("04model808:" + m["id"].str());
    else if (type == "cache808") put("05cache808:" + m["id"].str());
    else if (type == "vmix808") put("06vmix808:" + m["id"].str());
    else if (type == "verbIr") {
        // (kept as only as much of the IR as the reverb uses: the same spectra from less)
        Json& h = m.at("h");
        if (h["raw"].truthy()) {
            auto L = bytesOf(h["L"]), R = bytesOf(h["R"]);
            const double frac = h["frac"].num(1);
            const size_t n = (size_t) std::max(64, std::min(IRV_MAX, (int) std::floor(L.size() / 4 * frac + 0.5)));
            L.resize(std::min(L.size(), n * 4)); R.resize(std::min(R.size(), n * 4));
            h.set("L", tagged(L.data(), L.size(), "Float32Array")); h.set("R", tagged(R.data(), R.size(), "Float32Array")); h.set("frac", 1.0);
        }
        put("07verbIr");
    }
    else if (type == "mix") put("08mix");
    else if (type == "delay") put("09delay");
    else if (type == "rush") put("10rush");
    else if (type == "rushSet") {
        // (each one adds to the settings)
        Json& prev = snapshot["11rushSet"];
        if (!prev.isObject()) prev = m;
        else for (auto& kv : m["set"].entries()) prev.at("set").set(kv.first, kv.second);
    }
    else if (type == "mute") put("12mute");
    else if (type == "lanes808") put("13lanes808");
    else if (type == "seq") put("14seq");
}

void Processor::send(Json m) {
    Json* j = new Json(std::move(m));
    if (!toAudio.push(j)) delete j;
}

// ---- the page ----
void Processor::pageMessage(const juce::String& text) {
    bool ok = false;
    Json m = Json::parse(text.toStdString(), &ok);
    if (!ok) return;
    // (the page sends what it sent in one go as one array: applied together, in one audio block)
    if (m.isArray()) {
        Json all = Json::array();
        for (auto& x : m.items()) { if (!x.isObject()) continue; Json y = x; record(y); preprocess(y); all.push(std::move(y)); }
        send(std::move(all));
        return;
    }
    if (!m.isObject()) return;
    record(m);
    preprocess(m);
    send(std::move(m));
}
void Processor::pageStore(const juce::var& change) {
    const juce::ScopedLock sl(lock);
    if ((bool) change["clear"]) {
        for (auto& kv : store) globalPending[kv.first] = std::nullopt;
        store.clear(); globalDirty = 1;
        return;
    }
    const std::string k = change["k"].toString().toStdString();
    const juce::var v = change["v"];
    std::optional<std::string> val;
    if (!v.isVoid() && !v.isUndefined() && v.isString()) val = v.toString().toStdString();
    if (isPerInstanceKey(k)) { if (val) store[k] = *val; else store.erase(k); }
    globalPending[k] = val; globalDirty = 1;
    if (k == "elixir808-pats") rebuildPatterns();
}
void Processor::pageIdb(const juce::String& text) {
    const Json op = Json::parse(text.toStdString());
    const std::string kind = op["op"].str(), db = op["db"].str(), st = op["store"].str(), key = op["key"].str();
    const juce::ScopedLock sl(lock);
    Json& s = idb.at(db).at(st);
    if (kind == "put") s.set(key, op["value"]);
    else if (kind == "delete") s.erase(key);
    else if (kind == "clear") s = Json::object();
}
void Processor::pageSession(const juce::String& text) { const juce::ScopedLock sl(lock); session = text.toStdString(); }
void Processor::pageReady(bool r) { ready = r; }

static std::string escapeForScript(std::string s) {
    std::string out; out.reserve(s.size() + 64);
    for (size_t i = 0; i < s.size(); i++) { if (s[i] == '<' && i + 1 < s.size() && s[i + 1] == '/') { out += "<\\/"; i++; } else out += s[i]; }
    return out;
}
juce::String Processor::pageHtml() {
    auto page = readAsset("index.html"), shim = readAsset("ui/shim.js"), boot = readAsset("ui/boot.js");
    if (!page) return "<!doctype html><meta charset=utf-8><body style='font:14px sans-serif;padding:2em'>808 Circuit: the app's files are missing (Resources/app).";
    Json init = Json::object();
    init.set("rate", outRate);
    {
        const juce::ScopedLock sl(lock);
        // localStorage: the shared keys, then this instance's own over them
        std::map<std::string, std::string> merged = readGlobal();
        for (auto& kv : globalPending) { if (kv.second) merged[kv.first] = *kv.second; else merged.erase(kv.first); }
        for (auto it = merged.begin(); it != merged.end();) it = isPerInstanceKey(it->first) ? merged.erase(it) : std::next(it);
        for (auto& kv : store) merged[kv.first] = kv.second;
        Json st = Json::object(); for (auto& kv : merged) st.set(kv.first, kv.second);
        init.set("store", std::move(st));
        init.set("idb", idb);
        init.set("session", session.empty() ? Json() : Json(session));
    }
    const Shipped& sh = shipped();
    init.set("shipped", sh.index);
    {
        Json bytes = Json::object();
        for (int i = 0; i < 16; i++) if (sh.data[(size_t) i]) bytes.set(VOICE_IDS[i], (double) sh.pcmBytes[(size_t) i]);
        init.set("shippedBytes", std::move(bytes));
    }
    {
        Json host = Json::object(); host.set("has", hasHost); host.set("playing", hostPlaying); host.set("bpm", hostBpm);
        init.set("host", std::move(host));
    }
    const std::string head = "<script>window.__T8_INIT = " + escapeForScript(init.dump()) + ";</script>\n<script>\n"
        + (shim ? shim->toString().toStdString() : std::string()) + "\n</script>\n";
    const std::string tail = "<script>\n" + (boot ? boot->toString().toStdString() : std::string()) + "\n</script>\n";
    std::string html = page->toString().toStdString();
    const std::string meta = "<meta charset=\"utf-8\">";
    const size_t at = html.find(meta);
    if (at != std::string::npos) html.insert(at + meta.size(), "\n" + head); else html.insert(0, head);
    const size_t end = html.rfind("</body>");
    if (end != std::string::npos) html.insert(end, tail); else html += tail;
    return juce::String::fromUTF8(html.data(), (int) html.size());
}

// the grid's eight patterns, for MIDI: each as the lanes808 message the page sends when it's picked
void Processor::rebuildPatterns() {
    std::string text;
    { const juce::ScopedLock sl(lock); auto it = store.find("elixir808-pats"); if (it != store.end()) text = it->second; }
    std::shared_ptr<const std::vector<Json>> pats;
    if (!text.empty()) {
        const Json g = Json::parse(text);
        if (g["pats"].isArray()) {
            auto v = std::make_shared<std::vector<Json>>();
            for (size_t i = 0; i < g["pats"].size(); i++) {
                Json m = msgOf("lanes808");
                m.set("lanes", g["pats"][i]);
                const double len = g["lens"][i].num(1);
                m.set("pages", std::max(1.0, std::min(4.0, std::floor(len) ? std::floor(len) : 1.0)));
                v->push_back(std::move(m));
            }
            pats = v;
        }
    }
    std::atomic_store(&patterns, pats);
}

// ---- the audio thread ----
void Processor::emitEvent(Json ev) {
    Json* j = new Json(std::move(ev));
    if (!toMessage.push(j)) delete j;
}
void Processor::audioMsg(const Json& m) {
    if (m.isArray()) { for (auto& x : m.items()) audioMsg(x); return; }
    const std::string& type = m["type"].str();
    if (type == "__seqState") { lastSeq = m["m"]; return; }
    if (type == "seq" || (type == "atBar" && m["m"]["type"].str() == "seq")) {
        const bool wrapped = type == "atBar";
        lastSeq = wrapped ? m["m"] : m;
        // the host's tempo; while the host plays, the transport is its
        Json c = m; Json& s = wrapped ? c.at("m") : c;
        if (hasHost) { s.set("bpm", hostBpm); if (hostPlaying) s.set("playing", true); }
        player->msg(c);
        return;
    }
    player->msg(m);
}
void Processor::locateTo(double ppq) {
    const double len16 = lxr::REAL_FS * 60 / hostBpm / 4, q = ppq * 4;
    double K = std::ceil(q - 1e-7);
    if (K < 0) K = 0;
    const double D = (K - q) * len16;
    const long k = (long) K;
    player->locate((int) (k % 16), (int) (k / 16), D - player->renderLead());
}
void Processor::hostSync() {
    auto* ph = getPlayHead();
    const auto pos = ph ? ph->getPosition() : std::nullopt;
    if (!pos || !pos->getBpm()) { hasHost = false; return; }
    const double bpm = std::max(1.0, *pos->getBpm());
    const bool playing = pos->getIsPlaying();
    const auto ppq = pos->getPpqPosition();
    const bool bpmChanged = !hasHost || std::abs(bpm - hostBpm) > 1e-6;
    hasHost = true; hostBpm = bpm;
    if (std::abs(player->tempo() - bpm) > 1e-9) player->setTempo(bpm);
    auto seqWith = [&](bool play) {
        Json c = lastSeq.isObject() ? lastSeq : Json::object();
        if (!c.has("pattern")) {
            Json pat = Json::object(); pat.set("on", Json::array()); pat.set("acc", Json::array()); pat.set("bar", Json::array());
            c.set("type", "seq"); c.set("pattern", std::move(pat)); c.set("vel", 100.0); c.set("accentDb", 6.0); c.set("patternOn", true);
        }
        c.set("playing", play); c.set("bpm", bpm);
        return c;
    };
    const bool started = playing && !hostPlaying, stopped = !playing && hostPlaying;
    hostPlaying = playing;
    if (started) {
        if (!player->isPlaying()) player->msg(seqWith(true));
        if (ppq) locateTo(*ppq);
    } else if (stopped) {
        if (player->isPlaying()) player->msg(seqWith(false));
    } else if (playing && player->isPlaying() && ppq) {
        // still with the host? (a loop, a jump, or drift): where the player's next step falls, in the host's 16ths
        const double len16 = lxr::REAL_FS * 60 / bpm / 4;
        const double at = *ppq * 4 + (player->toNextStep() + player->renderLead()) / len16;
        const double want = player->currentBar() * 16.0 + player->currentStep();
        if (std::abs(at - want) * len16 > 0.005 * lxr::REAL_FS) locateTo(*ppq);
    }
    if (started || stopped || bpmChanged) {
        Json ev = msgOf("host"); ev.set("playing", playing); ev.set("bpm", bpm);
        emitEvent(std::move(ev));
    }
}
void Processor::midi(const juce::MidiBuffer& mb) {
    // the General MIDI drum notes, as the page's MIDI in (app/midi.js: MIDI_NOTES)
    static const int DRUM[128] = {
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1, 0, 0,-1, 3,-1, 3, 1, 5, 1, 5, 1, 6, 2, 2, 4, 2, 4,-1,-1,-1, 4,-1, 4,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1 };
    for (const auto meta : mb) {
        const auto msg = meta.getMessage();
        if (!msg.isNoteOn()) continue;
        const int note = msg.getNoteNumber(), vel = msg.getVelocity();
        if (note >= 24 && note < 32) {
            // C0 (24) up: the grid's patterns 1 to 8
            const int n = note - 24;
            const auto pats = std::atomic_load(&patterns);
            if (pats && n < (int) pats->size()) player->msg((*pats)[(size_t) n]);
            Json ev = msgOf("patSel"); ev.set("n", (double) n); emitEvent(std::move(ev));
        } else if (DRUM[note] >= 0) {
            Json t = msgOf("trig"); t.set("voice", (double) DRUM[note]); t.set("vel", (double) vel);
            player->msg(t);
        }
    }
}
void Processor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) {
    juce::ScopedNoDenormals noDenormals;
    if (Player* p = pendingPlayer.exchange(nullptr)) {
        Player* old = player.release(); player.reset(p);
        if (!playerTrash.push(old)) { /* (kept rather than freed here) */ }
    }
    while (Json* j = toAudio.pop()) { audioMsg(*j); if (!trash.push(j)) delete j; }
    hostSync();
    midi(midiMessages);
    const int n = buffer.getNumSamples();
    buffer.clear();
    if ((int) scratchL.size() < n) { scratchL.resize((size_t) n); scratchR.resize((size_t) n); } // (a host that lied about its block size)
    float* L = buffer.getNumChannels() > 0 ? buffer.getWritePointer(0) : scratchL.data();
    float* R = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : scratchR.data();
    player->process(L, R, n);
    for (auto& ev : player->events) emitEvent(std::move(ev));
    player->events.clear();
}

// ---- the message thread ----
void Processor::timerCallback() {
    while (Json* j = trash.pop()) delete j;
    while (Player* p = playerTrash.pop()) delete p;
    Json batch = Json::array();
    while (Json* e = toMessage.pop()) {
        std::unique_ptr<Json> ev(e);
        const std::string& type = (*ev)["type"].str();
        if (type == "recData") {
            auto d = std::static_pointer_cast<const Player::Recorded>(ev->blob);
            if (!d) continue;
            Json o = msgOf("recData");
            o.set("L", tagged(d->L.data(), d->L.size() * 4, "Float32Array")); o.set("R", tagged(d->R.data(), d->R.size() * 4, "Float32Array"));
            if (ready) batch.push(std::move(o));
            continue;
        }
        if (type == "patSel" && !ready) {
            // (the editor's closed: the stored patterns and the session remember the pick)
            const int n = (int) (*ev)["n"].num();
            const juce::ScopedLock sl(lock);
            auto it = store.find("elixir808-pats");
            if (it != store.end()) { Json g = Json::parse(it->second); g.set("cur", (double) n); g.set("mode", "lanes"); it->second = g.dump(); globalPending[it->first] = it->second; globalDirty = 1; }
            if (!session.empty()) { Json s = Json::parse(session); if (s["e808"].isObject()) { s.at("e808").set("cur", (double) n); session = s.dump(); } }
            continue;
        }
        if (ready) batch.push(std::move(*ev));
    }
    if (batch.size() && ready && editor) editor->emit(juce::String::fromUTF8(batch.dump().c_str()));
    if (globalDirty && ++globalDirty > 30) flushGlobal(); // (about a second after the last change)
}
void Processor::flushGlobal() {
    std::map<std::string, std::optional<std::string>> pend;
    { const juce::ScopedLock sl(lock); pend.swap(globalPending); globalDirty = 0; }
    if (pend.empty()) return;
    // (read again first: another instance may have written since)
    auto g = readGlobal();
    for (auto& kv : pend) { if (kv.second) g[kv.first] = *kv.second; else g.erase(kv.first); }
    Json j = Json::object(); for (auto& kv : g) j.set(kv.first, kv.second);
    const juce::File f = globalFile();
    f.getParentDirectory().createDirectory();
    f.replaceWithText(juce::String::fromUTF8(j.dump().c_str()));
}

// ---- the project ----
void Processor::getStateInformation(juce::MemoryBlock& dest) {
    Json st = Json::object();
    st.set("v", 1.0);
    {
        const juce::ScopedLock sl(lock);
        Json s = Json::object(); for (auto& kv : store) s.set(kv.first, kv.second);
        st.set("store", std::move(s));
        st.set("idb", idb);
        st.set("session", session.empty() ? Json() : Json(session));
        Json snap = Json::array();
        for (auto& kv : snapshot) { Json e = Json::array(); e.push(kv.first); e.push(kv.second); snap.push(std::move(e)); }
        st.set("snap", std::move(snap));
    }
    const std::string text = st.dump();
    juce::MemoryOutputStream out(dest, false);
    out.writeString("T8S1");
    juce::GZIPCompressorOutputStream gz(out, 6);
    gz.write(text.data(), text.size());
    gz.flush();
}
void Processor::setStateInformation(const void* data, int size) {
    if (size < 4 || std::memcmp(data, "T8S1", 4) != 0) return;
    // (writeString wrote the tag and its terminating zero)
    juce::MemoryInputStream in((const char*) data + 5, (size_t) size - 5, false);
    juce::GZIPDecompressorInputStream gz(in);
    const juce::MemoryBlock mb = [&] { juce::MemoryOutputStream o; o.writeFromInputStream(gz, -1); return o.getMemoryBlock(); }();
    bool ok = false;
    const Json st = Json::parse(std::string((const char*) mb.getData(), mb.getSize()), &ok);
    if (!ok || !st.isObject()) return;
    {
        const juce::ScopedLock sl(lock);
        store.clear(); for (auto& kv : st["store"].entries()) if (kv.second.isString()) store[kv.first] = kv.second.str();
        idb = st["idb"].isObject() ? st["idb"] : Json::object();
        session = st["session"].isString() ? st["session"].str() : std::string();
        snapshot.clear(); for (auto& e : st["snap"].items()) if (e[(size_t) 0].isString()) snapshot[e[(size_t) 0].str()] = e[(size_t) 1];
    }
    rebuildPatterns();
    auto p = freshPlayer(true);
    p->setOutRate(outRate);
    delete pendingPlayer.exchange(p.release());
    {
        // (and the audio thread learns the restored transport state's pattern)
        const juce::ScopedLock sl(lock);
        auto it = snapshot.find("14seq");
        if (it != snapshot.end()) { Json m = msgOf("__seqState"); m.set("m", it->second); send(std::move(m)); }
    }
    if (editor) editor->reload();
}

juce::AudioProcessorEditor* Processor::createEditor() { return new Editor(*this); }

} // namespace t8

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new t8::Processor(); }
