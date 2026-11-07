// C++ port of the parts of the LXR-02 engine (elixir/lxr.js, GPL-3.0) the 808 app still uses: the FX bus (the echo, and
// the distortion the player runs as a master insert), the compressor, and the kit's LFO and velocity modulation of the
// FX parameters. The LXR voices themselves are silent in the 808 app (no LXR voice is ever triggered), so they're left
// out: their outputs into the FX bus are zero.
// Numbers follow the JS exactly: a JS number is a double here, Math.fround is F(), typed arrays keep their types.
#pragma once
#include <cstdint>
#include <cmath>
#include <array>
#include <vector>

namespace t8::lxr {

constexpr double REAL_FS = 44140;
constexpr int BLOCK = 64;
enum { FX_OFF = 0, FX_DISTORTION = 1, FX_RING = 2, FX_COMPRESSOR = 3, FX_DELAY = 4 };
enum { DIST_TUBE = 0, DIST_FOLD = 1, DIST_RAT = 2 };
constexpr int DELAY_NORMAL = 0;

inline float F(double x) { return (float) x; }
inline int32_t toI32(double x) {
    if (x != x) return 0;
    if (x >= 2147483647.0) return 2147483647;
    if (x <= -2147483648.0) return INT32_MIN;
    return (int32_t) std::trunc(x);
}
inline uint32_t toU32(double x) {
    if (x != x || x <= 0) return 0;
    if (x >= 4294967295.0) return 4294967295u;
    return (uint32_t) std::trunc(x);
}
inline int32_t toI16(double x) { return (int32_t) (int16_t) (uint16_t) (uint32_t) toI32(x); }
inline int32_t toU8(double x) { return (int32_t) (toU32(x) & 0xff); }
inline int32_t ssat16(double x) { return x > 32767 ? 32767 : x < -32768 ? -32768 : (int32_t) x; }
inline int32_t ssat16i(int64_t x) { return x > 32767 ? 32767 : x < -32768 ? -32768 : (int32_t) x; }
inline int32_t qadd16(int32_t a, int32_t b) { return ssat16i((int64_t) a + b); }
inline int32_t wrap16(int64_t x) { return (int32_t) (int16_t) (uint16_t) (uint64_t) x; }
inline double jsRound(double x) { return std::floor(x + 0.5); }

struct OnePole { float r = 0.01f; float b = 0; };
inline float calcOnePole(OnePole& flt, double input) { flt.b = std::fmaf(flt.r, F(input - flt.b), flt.b); return flt.b; }

struct Rng {
    uint32_t state;
    explicit Rng(uint32_t s = 0x12345678) : state(s) {}
    uint32_t next() { uint32_t x = state; x ^= x << 13; x ^= x >> 17; x ^= x << 5; state = x; return x; }
};

struct Distortion {
    int type = DIST_TUBE; float drive = 1, p1 = 1, p2 = 0, p3 = 0;
    double lastOut[2] {}, hp1[2] {}, hp3[2] {}, lp1[2] {}, lp2[2] {}, lp3[2] {}, slew[2] {};
};
struct Compressor { float tresh = 3, attack = 0.1f, release = 300, ratio = 0, markupGain = 1; double env = 0; };
struct Delay {
    uint32_t mask = 0x7fff; bool hasSync = false; double sync = 0;
    uint32_t oldRead = 0, newRead = 0, write = 0x7fff / 20 - 10;
    float fracReadNew = 0, fracReadOld = 0, interpValue = 0, interpStep = 0;
    int16_t tmp[2] {}, tmp2[2] {};
    float feedback = 0.7f, range = 0, delayTime = 0, pendingDelayTime = 0; int timePending = 0;
    OnePole tone, tone2; int type = DELAY_NORMAL;
};

class FxBus {
public:
    FxBus();
    void setParameter(int idx, double value) { parameter[(size_t) idx] = F(value); updateParameter(); }
    void setDelaySync(bool on, double samples);
    void updateParameter();
    // input (stereo, interleaved int16) -> added into out
    void process(int16_t* out, int size);
    float dryWet = 0; int audioRouting = 0; int fxType = FX_OFF;
    std::array<float, 4> parameter {};
    Distortion distortion; Compressor compressor; Delay delay;
    std::vector<float> buffer; // __fp16 FX_BUFFER, kept as float values
    bool forceWet = false;
    int16_t input[BLOCK * 2] {};
};

struct ModNode { int destination = 0; float amount = 0; double lastVal = 0; };
struct Lfo {
    uint32_t phase = 0, phaseInc = 1; int waveform = 0, retrigger = 0; uint32_t phaseOffset = 0; float rnd = 0; int sync = 0;
    float freq = 1; double modNodeValue = 1; ModNode modTarget;
};

// The engine minus its voices: the kit's parameters, their modulation and the FX bus.
class Engine {
public:
    Engine();
    void loadInitKit();
    void loadKit(const std::vector<int>& values);
    void setParam(int par, int value);
    // once per 64-sample block, before renderFx (renderBlock()'s modulation update)
    void renderBlock();
    // the FX bus for the block: the voices are silent, so its input is just extra (stereo, int16 scale, interleaved)
    const int16_t* renderFx(double width, bool hasWidth, const float* extra);
    double bpm = 120;
    FxBus fx;
private:
    void ccHandler(bool isCC2, int num, int data2, bool isFloat, double v);
    void dispatch(int par, int data2, bool isFloat, double v);
    void modUpdate(ModNode& vm, double val);
    void setOriginal(int par);
    void resetTargets();
    void lfoSetFreq(Lfo& lfo, double x);
    static int targetPar(int index);
    std::vector<uint8_t> activeParameters;
    int activeNrpnNumber = 0;
    std::array<ModNode, 6> velocityModulators;
    std::array<Lfo, 6> lfos;
    std::array<int, 6> audioRouting {};
    Rng rng;
    int16_t fxOut[BLOCK * 2] {};
};

float logfC(float x);
float expfC(double x);

} // namespace t8::lxr
