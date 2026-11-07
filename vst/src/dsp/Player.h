// C++ port of elixir/app/player.js (Player): the step sequencer, the 808 voices' mix (levels, pans, sends, the kick's
// duck and spacer), the snare rush, the echo (the LXR FX bus), the IR reverb, the distortion insert, the rush high-pass,
// the master compressor, the recorder and the count-in, at 44 140 Hz in 64-sample blocks, resampled to the output rate.
// It takes the page's messages as they are (Json) and gives back its events (step, lvl, rec, recData) the same way.
#pragma once
#include "Kit.h"
#include "Lxr.h"
#include "IrVerb.h"
#include "Json.h"
#include <optional>

namespace t8 {

class Player {
public:
    explicit Player(double outRate);
    void msg(const Json& m);
    // n frames at the output rate
    void process(float* L, float* R, int n);
    std::vector<Json> events;
    // for the plugin: what the transport is doing
    bool isPlaying() const { return playing; }
    double tempo() const { return bpm; }
    int currentStep() const { return step; }
    int currentBar() const { return bar; }
    // re-time the transport to a host position: the next step is due in `samples` (engine rate), and it is step s of bar b
    void locate(int s, int b, double samples) { step = s; bar = b; toNext = samples; queue.clear(); fresh = true; }
    double toNextStep() const { return toNext; }
    // engine samples from the next output sample to the start of the next block render()s
    double renderLead() const { return 128 - idx - frac; }
    // the host's tempo, without touching the pattern (seq's tempo part)
    void setTempo(double b) { bpm = b; e.bpm = b; }
    void setOutRate(double outRate) { ratio = lxr::REAL_FS / outRate; }

    struct Recorded { std::vector<float> L, R; };
private:
    struct Q { double at = 0; int t = 0; int lane = -1; bool acc = false; double sw = 0; int roll = 0; bool free = false; };
    struct Page { std::array<std::array<uint8_t, 16>, 7> on {}, acc {}; std::array<std::array<double, 16>, 7> cond {}; };
    struct Lane { int id; std::array<uint8_t, 64> on {}, acc {}; };
    struct Rec { bool loop = false; int bars = 0; bool on = false; std::string count; int done = 0; std::vector<float> L, R; int n = 0; };
    struct Clk { double n = 0, ph = 0, w = 0; };
    struct VMix { double vol = 1, pl = 0, pr = 0, echo = 0, verb = 0; };

    void msg808(const Json& m);
    void recFlush();
    void recEnd();
    void flushBar();
    void schedule(int s, int bar, double at0);
    void scheduleRush(int s, int bar, int pg, const Page& P, double at0, double len, std::vector<int>& hits);
    void spacer(const float* key, float* XL, float* XR);
    void hit(int t, double vel, bool acc, int lane = -1);
    void render808();
    int track808(int id) const;
    void clickAt(bool hi);
    void render(std::array<std::array<float, 64>, 2>& dst);
    void highPass(float* L, float* R);
    void ensureKit();

    lxr::Engine e;
    double ratio;
    std::array<std::array<float, 64>, 2> A {}, B {};
    int idx = 0; double frac = 0;
    std::vector<Page> pages; bool hasPages = false; Page single;
    bool patternOn = false;
    bool playing = false; double bpm = 120, vel = 100, accGain = 0.5;
    int step = 0, bar = 0; double toNext = 0; std::vector<Json> atBar;
    std::array<std::array<double, 16>, 7> grooveOff {};
    std::vector<Q> queue; std::array<std::vector<int>, 16> sched; bool fresh = false;
    std::optional<Rec> rec;
    int cntStep = 0; double cntGain = 1; std::optional<Clk> clk;
    std::array<float, 6> gain, gainTo, fxAmt; std::array<uint8_t, 6> muted {};
    struct RushSet { double start = 75, p32 = 80, top = 4, hats = 80, only = 98, kicks = 90, first = 95, hp = 90, hpTop = 1500, rollMs = 40, hpMs = 40; } rs;
    int rushT = 3; double rush = 0; std::optional<double> rushPh; double rushLog = 1; bool rushHead = false, rushHeadAcc = false;
    double rushGap = 0, clock = 0, snareAt = -1e9;
    bool hpOn = false; double hpLog, hpMix = 0, hpG = 0; std::array<double, 4> hpS {};
    struct Master { double comp = 1, thresh = -12, ratio = 3, attack = 5, release = 120, makeup = 0, duck = 0.4, duckRelease = 150, duckFx = 0, duckOn = 1, space = 0; } master;
    std::array<double, 8> spF; std::array<double, 48> spS {}; std::array<float, 8> spEnv {}, spG;
    std::array<float, 64> spL {}, spR {}, spKey {}; bool spOn = false;
    double delayPos; bool echoSync = true; double echoFree = 0.25, echoFine = 0;
    lxr::FxBus dist; IrVerb verb; std::array<float, 64> verbIn {};
    std::array<float, 6> sendD {}, sendR {}; double echoWidth = 1;
    double distMix = 0, distAt = 0;
    std::array<float, 128> busIn {}; std::array<int16_t, 128> busOut {};
    double duckEnv = 0, duckAt = 1, compEnv = 0, gr = 0, duckMin = 1;
    std::array<float, 6> lvl {}; int lvlN = 0; bool lvlOn = false;
    // the 808 voices
    std::unique_ptr<Kit> k808; std::array<int, 7> t808; std::array<std::string, 16> want808;
    std::array<std::array<float, 64>, 16> b808 {}, vbuf {}; std::array<double, 16> vpk {};
    std::array<VMix, 16> vmix; bool hasLanes = false; std::vector<Lane> lanes; int lanePages = 1;
    std::array<float, 128> fxExtra {};
    std::array<double, 16> vlv {}; std::array<bool, 16> vlvSeen {};
    std::array<float*, 16> split {};
};

} // namespace t8
