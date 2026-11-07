#include "Lxr.h"
#include "LxrTables.h"
#include <cstring>
#include <algorithm>

namespace t8::lxr {

static const float F_32767 = 32767.0f, F_32768 = 32768.0f, F_2POW32 = F(4294967295.0);
static const float F_REAL_FS = F(REAL_FS);
static const int FX_BUFFER_SIZE = 0x7fff, SYNC_BUFFER_SIZE = 0x7ffff;
static const float LOW_MIN = F(0.0006 * REAL_FS), LOW_MAX = F(0.02 * REAL_FS), HI_MIN = F(0.02 * REAL_FS), HI_MAX = F(FX_BUFFER_SIZE);
static const float PP_MAX = F(FX_BUFFER_SIZE * F(0.48));
static const double TONE_C0 = 0.06537948995454451662, TONE_C1 = 0.92410701734426630737;
static const double SLEW_MAX = 6.79655641141821477118;

static inline float bitsToFloat(uint32_t u) { float x; std::memcpy(&x, &u, 4); return x; }
static inline uint32_t floatBits(float x) { uint32_t u; std::memcpy(&u, &x, 4); return u; }

// float -> __fp16 (IEEE half, round to nearest even) -> float; |x| <= 1 here
static double toHalf(double x) {
    const double a = std::abs(x);
    if (a == 0) return x;
    const int e = a < 6.103515625e-5 ? -14 : (int) std::floor(std::log2(a));
    int ee = e;
    if (a >= 6.103515625e-5) { if (std::pow(2.0, ee) > a) ee--; else if (std::pow(2.0, ee + 1) <= a) ee++; }
    const double q = std::pow(2.0, ee - 10);
    const double m = a / q;
    double r = std::floor(m);
    const double d = m - r;
    if (d > 0.5 || (d == 0.5 && ((int64_t) r & 1))) r++;
    const double v = r * q;
    return x < 0 ? -v : v;
}
// one channel of dry/wet: dry + SSAT((wet - dry) * dryWet)
static inline int32_t dryWetMix(int32_t dry, int32_t wet, float dryWet) {
    return wrap16((int64_t) dry + ssat16i(toI32(F((double) (wet - dry) * dryWet))));
}
static inline double fmodC(double a, double b) { return std::fmod(a, b); }

static float diode(double xin) {
    float x = F(xin);
    x = x < -1 ? F(-1) : x > 1 ? F(1) : x;
    const float index = F(F(x + 1.0) * 128.0);
    const int itg = toI32(index) & 0xffff;
    const float frac = F(index - itg);
    const double a = (float) TABLE_1N914_D[itg], b = itg < 256 ? (double) (float) TABLE_1N914_D[itg + 1] : 0;
    return F(frac * b + F(a - F(frac * a)));
}
static double foldback(double x, double th) {
    if (x > th || x < -th) x = F(std::abs(std::abs(fmodC(F(x - th), F(th * 4))) - F(th * 2)) - th);
    return x;
}
static void distortionProcess(Distortion& d, const int16_t* fx, int16_t* out, int size, float dryWet) {
    const double coff = TONE_C0 + d.p2 * TONE_C1;
    if (d.type == DIST_TUBE) {
        const float outMod = F((1.0 + 0.55 * d.p1) + 0.55 * d.p1);
        const float g = F(1 + F(d.drive * 4.0));
        for (int i = 0; i < size; i++) for (int c = 0; c < 2; c++) {
            const int32_t x = fx[2 * i + c];
            const int32_t input = toI32(F((double) x * g));
            const int itg = ((ssat16i(input) >> 9) + 64) & 0xff;
            const float frac = F((double) (input & 511) / 512);
            double val = ECC83_TABLE[itg] + (ECC83_TABLE[itg + 1] - ECC83_TABLE[itg]) * frac;
            d.lp3[c] += coff * (val - d.lp3[c]);
            val = d.lp3[c] * outMod * d.p3;
            const int32_t wet = ssat16i(toI32(val * 32768));
            out[2 * i + c] = (int16_t) qadd16(out[2 * i + c], dryWetMix(x, wet, dryWet));
        }
    } else if (d.type == DIST_FOLD) {
        const float g = F(1 + F(d.drive * 4.0));
        for (int i = 0; i < size; i++) for (int c = 0; c < 2; c++) {
            const int32_t x = fx[2 * i + c];
            const float input = F(x / (double) F_32768);
            const float val = F(F((double) input * g) + d.p1);
            d.lp3[c] += coff * (val - d.lp3[c]);
            const float y = F(foldback(F(d.lp3[c]), 1) * d.p3);
            const int32_t wet = ssat16i(toI32(F(y * 32768.0)));
            out[2 * i + c] = (int16_t) qadd16(out[2 * i + c], dryWetMix(x, wet, dryWet));
        }
    } else { // DISTORTION_RAT (and any other value)
        const float gain = F(1 + F(d.drive * 2304.0));
        for (int i = 0; i < size; i++) for (int c = 0; c < 2; c++) {
            const int32_t x = fx[2 * i + c];
            double s = x / 32768.0;
            s += d.lastOut[c] * d.p1 * 0.125;
            d.hp1[c] += 0.64116641920131193922 * (s - d.hp1[c]);
            s = s - d.hp1[c];
            d.lp1[c] += (1 - 0.1025353241628911807) * (s - d.lp1[c]);
            s = d.lp1[c];
            d.hp3[c] += (1 - 0.99149556438154282898) * (s - d.hp3[c]);
            s = s - d.hp3[c];
            d.lp2[c] += (1 - 0.93130041642945205043) * (s - d.lp2[c]);
            s = d.lp2[c];
            s *= gain;
            double diff = s - d.slew[c];
            const double sign = diff > 0 ? 1 : -1;
            if (std::abs(diff) > SLEW_MAX) diff = SLEW_MAX * sign;
            d.slew[c] += diff;
            if (d.slew[c] > 4.2) d.slew[c] = 4.2;
            else if (d.slew[c] < -4.2) d.slew[c] = -4.2;
            s = diode(d.slew[c]);
            d.lp3[c] += coff * (s - d.lp3[c]);
            d.lastOut[c] = d.lp3[c] * d.p3;
            const int32_t wet = ssat16i(toI32(d.lastOut[c] * 32768));
            out[2 * i + c] = (int16_t) qadd16(out[2 * i + c], dryWetMix(x, wet, dryWet));
        }
    }
}

// glibc / ARM optimized-routines logf() and expf(), as lxr.js has them
static const double LOGF_LN2 = 0.6931471805599453, LOGF_A[3] = { -0.25089342214237154, 0.333456765744066, -0.4999997485802103 };
float logfC(float x) {
    const uint32_t ix = floatBits(x);
    if (ix == 0x3f800000) return 0;
    const uint32_t tmp = ix - 0x3f330000u;
    const int i = (int) ((tmp >> 19) & 15);
    const int k = ((int32_t) tmp) >> 23;
    const float z = bitsToFloat(ix - (tmp & 0xff800000u));
    const double r = z * LOGF_INVC[i] - 1;
    const double y0 = LOGF_LOGC[i] + k * LOGF_LN2;
    const double r2 = r * r;
    double y = LOGF_A[1] * r + LOGF_A[2];
    y = LOGF_A[0] * r2 + y;
    y = y * r2 + (y0 + r);
    return F(y);
}
static const double EXPF_SHIFT = 6755399441055744.0, EXPF_INVLN2N = 46.16624130844683, EXPF_C[3] = { 1.6938359250920212e-06, 0.00023459809789509004, 0.021660849396613134 };
float expfC(double xin) {
    const float x = F(xin);
    if (x < -103.97207641601562) return 0;
    const double z = EXPF_INVLN2N * x;
    const double kd = (z + EXPF_SHIFT) - EXPF_SHIFT;
    const double r = z - kd;
    const int32_t k = (int32_t) (int64_t) kd;
    const uint64_t lo = EXP2F_TAB_LO[k & 31], hi = (uint32_t) (EXP2F_TAB_HI[k & 31] + ((uint32_t) (k & 0x1ffff) << 15));
    const uint64_t bits = (hi << 32) | lo;
    double s; std::memcpy(&s, &bits, 8);
    const double zz = EXPF_C[0] * r + EXPF_C[1];
    const double r2 = r * r;
    double y = EXPF_C[2] * r + 1;
    y = zz * r2 + y;
    y = y * s;
    return F(y);
}
static const double LOG_2_DB = 8.6858896380650365530225783783321, DB_2_LOG = 0.11512925464970228420089957273422;
static void compressorProcess(Compressor& c, const int16_t* fx, int16_t* out, int size, float dryWet) {
    for (int i = 0; i < size; i++) {
        const int32_t x0 = fx[2 * i], x1 = fx[2 * i + 1];
        const float inp = F(0.5 * F(x0 / (double) F_32768) + 0.5 * F(x1 / (double) F_32768));
        double peak = std::abs((double) inp);
        peak += 1.0E-25;
        const double peakdB = logfC(F(peak)) * LOG_2_DB;
        double overdB = peakdB - c.tresh;
        if (overdB < 0) overdB = 0;
        const double coeff = overdB > c.env ? c.attack : c.release;
        c.env = overdB + coeff * (c.env - overdB);
        double gr = c.env * (c.ratio - 1.0);
        gr = expfC(F(gr * DB_2_LOG));
        const int32_t l = ssat16i(toI32(x0 * gr * c.markupGain));
        const int32_t r = ssat16i(toI32(x1 * gr * c.markupGain));
        out[2 * i] = (int16_t) qadd16(out[2 * i], dryWetMix(x0, l, dryWet));
        out[2 * i + 1] = (int16_t) qadd16(out[2 * i + 1], dryWetMix(x1, r, dryWet));
    }
}
static float compExpCoef(float ms) { return F(std::exp(-1000.0 / F((double) ms * F_REAL_FS))); }
static void compressorSetRatio(Compressor& c, int r) {
    static const float R[6] = { 1.0f, 0.5f, F(1.0 / 3), 0.25f, F(1.0 / 6), 0.125f };
    c.ratio = r >= 0 && r < 6 ? R[r] : 1.0f;
}

static inline float interpF(double a, double b, double x) { return F(F(a * F(1 - x)) + F(b * x)); }
static float calcDelayTime(const Delay& d, float cv) {
    const float mn = interpF(LOW_MIN, HI_MIN, d.range);
    const float mx = interpF(LOW_MAX, d.type == DELAY_NORMAL ? HI_MAX : PP_MAX, d.range);
    return interpF(mn, mx, cv);
}
static void delaySetDelayTime(Delay& d, float t) {
    if (d.interpValue <= 0) {
        d.delayTime = t;
        const double offset = d.hasSync ? d.sync : (double) calcDelayTime(d, F((double) d.delayTime * d.range));
        const uint32_t offItg = toU32(offset);
        d.fracReadNew = F(offset - offItg);
        d.newRead = d.write - 1 - offItg;
        d.newRead &= d.type == DELAY_NORMAL ? d.mask : d.mask >> 1;
        d.interpValue = 1;
        d.interpStep = F(1 / F((double) F_REAL_FS * F(0.01)));
    } else {
        d.pendingDelayTime = t;
        d.timePending = 1;
    }
}
static inline int16_t delayRead(const float* buf, uint32_t base, uint32_t pos, uint32_t mask, float frac) {
    const uint32_t pos2 = (pos + 1) & mask;
    return (int16_t) toI16(F((double) interpF(buf[base + pos], buf[base + pos2], frac) * F_32767));
}
static void delayCalcBuffer(Delay& d, const float* buf, int idx) {
    if (idx == 0) { d.tmp[0] = delayRead(buf, 0, d.oldRead, d.mask, d.fracReadOld); d.oldRead = (d.oldRead + 1) & d.mask; }
    else { d.tmp[1] = delayRead(buf, 0, d.newRead, d.mask, d.fracReadNew); d.newRead = (d.newRead + 1) & d.mask; }
}
static void delayCalcBufferPingPong(Delay& d, const float* buf, int idx) {
    const uint32_t half = d.mask >> 1;
    if (idx == 0) {
        d.tmp[0] = delayRead(buf, 0, d.oldRead, half, d.fracReadOld);
        d.tmp2[0] = delayRead(buf, half, d.oldRead, half, d.fracReadOld);
        d.oldRead = (d.oldRead + 1) & half;
    } else {
        d.tmp[1] = delayRead(buf, 0, d.newRead, half, d.fracReadNew);
        d.tmp2[1] = delayRead(buf, half, d.newRead, half, d.fracReadNew);
        d.newRead = (d.newRead + 1) & half;
    }
}
static inline int32_t crossfade(int32_t a, int32_t b, float v) { return toI16((double) F((double) a * v) + b * (1.0 - v)); }
static inline float toBuf(int32_t itg) { float v = F(itg / (double) F_32767); if (v > 1) v = 1; else if (v < -1) v = -1; return (float) toHalf(v); }
static void delayStep(Delay& d, bool pingPong, const float* buf, int32_t& l, int32_t& r) {
    auto calc = pingPong ? delayCalcBufferPingPong : delayCalcBuffer;
    if (d.interpValue <= 0) {
        calc(d, buf, 0);
        l = d.tmp[0]; r = d.tmp2[0];
        if (d.timePending) { d.timePending = 0; delaySetDelayTime(d, d.pendingDelayTime); }
    } else {
        calc(d, buf, 0);
        calc(d, buf, 1);
        l = crossfade(d.tmp[0], d.tmp[1], d.interpValue);
        r = 0;
        if (pingPong) r = crossfade(d.tmp2[0], d.tmp2[1], d.interpValue);
        d.interpValue = F((double) d.interpValue - d.interpStep);
        if (d.interpValue <= 0) { d.oldRead = d.newRead; d.fracReadOld = d.fracReadNew; }
    }
}
static void delayProcess(Delay& d, float* buf, const int16_t* fx, int16_t* out, int size, float dryWet) {
    for (int i = 0; i < size; i++) {
        const int32_t x0 = fx[2 * i], x1 = fx[2 * i + 1];
        int32_t o, unused;
        delayStep(d, false, buf, o, unused);
        o = toI16(calcOnePole(d.tone, o));
        const int32_t itg = qadd16(qadd16(x0, x1), toI16(F((double) o * d.feedback)));
        buf[d.write++] = toBuf(itg);
        d.write &= d.mask;
        out[2 * i] = (int16_t) qadd16(out[2 * i], wrap16(ssat16i((int64_t) x0 + ssat16i(toI32(F((double) (o - x0) * dryWet))))));
        out[2 * i + 1] = (int16_t) qadd16(out[2 * i + 1], wrap16(ssat16i((int64_t) x1 + ssat16i(toI32(F((double) (o - x1) * dryWet))))));
    }
}
static void delayProcessPingPong(Delay& d, float* buf, const int16_t* fx, int16_t* out, int size, float dryWet) {
    const uint32_t half = d.mask >> 1;
    for (int i = 0; i < size; i++) {
        const int32_t x0 = fx[2 * i], x1 = fx[2 * i + 1];
        int32_t l, r;
        delayStep(d, true, buf, l, r);
        l = toI16(calcOnePole(d.tone, l));
        r = toI16(calcOnePole(d.tone2, r));
        buf[half + d.write] = toBuf(qadd16(x0, toI16(F((double) l * d.feedback))));
        buf[d.write++] = toBuf(qadd16(x1, toI16(F((double) r * d.feedback))));
        d.write &= half;
        out[2 * i] = (int16_t) qadd16(out[2 * i], wrap16(ssat16i((int64_t) x0 + ssat16i(toI32(F((double) (l - x0) * dryWet))))));
        out[2 * i + 1] = (int16_t) qadd16(out[2 * i + 1], wrap16(ssat16i((int64_t) x1 + ssat16i(toI32(F((double) (r - x1) * dryWet))))));
    }
}

FxBus::FxBus() : buffer((size_t) SYNC_BUFFER_SIZE + 1, 0.0f) {}

void FxBus::setDelaySync(bool on, double samples) {
    Delay& d = delay;
    if (!on) { if (!d.hasSync) return; d.hasSync = false; d.mask = FX_BUFFER_SIZE; }
    else {
        d.mask = SYNC_BUFFER_SIZE;
        const double mx = (double) ((d.type == DELAY_NORMAL ? d.mask : d.mask >> 1) - 2);
        samples = std::max(1.0, std::min(mx, samples));
        if (d.hasSync && std::abs(samples - d.sync) < 0.5) return;
        d.hasSync = true; d.sync = samples;
    }
    delaySetDelayTime(d, d.delayTime);
}
void FxBus::updateParameter() {
    const auto& p = parameter;
    switch (fxType) {
        case FX_DISTORTION: distortion.drive = p[0]; distortion.p1 = p[1]; distortion.p2 = p[2]; distortion.p3 = p[3]; break;
        case FX_RING: break; // (never used by the 808 app: its FX slot is always the delay)
        case FX_COMPRESSOR:
            compressor.attack = compExpCoef(F(F(0.03) + F(p[0] * 100.0)));
            compressor.release = compExpCoef(F(25 + F(p[1] * 175.0)));
            compressor.tresh = F(-96 + F(p[2] * 96.0));
            compressor.markupGain = F(1 + F(p[3] * 2.0));
            break;
        case FX_DELAY:
            delay.range = p[1]; delaySetDelayTime(delay, delay.delayTime);
            delaySetDelayTime(delay, p[0]);
            delay.tone.r = F((double) p[2] * p[2]);
            delay.tone2.r = F((double) p[2] * p[2]);
            delay.feedback = p[3];
            break;
        default: break;
    }
}
void FxBus::process(int16_t* out, int size) {
    const int16_t* fx = input;
    const float dw = forceWet ? 1.0f : dryWet;
    switch (fxType) {
        case FX_DISTORTION: distortionProcess(distortion, fx, out, size, dw); break;
        case FX_COMPRESSOR: compressorProcess(compressor, fx, out, size, dw); break;
        case FX_DELAY:
            if (delay.type == DELAY_NORMAL) delayProcess(delay, buffer.data(), fx, out, size, dw);
            else delayProcessPingPong(delay, buffer.data(), fx, out, size, dw);
            break;
        default: // FX_OFF (and the ring mod, which the 808 app never selects)
            for (int i = 0; i < size * 2; i++) out[i] = (int16_t) qadd16(out[i], fx[i]);
            break;
    }
}

// ---- the kit's parameters and their modulation ----
static const float LFO_SR = F(REAL_FS / F(BLOCK));
static const double SYNC_SCALERS[12] = { 0, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 32 };
static uint32_t lfoCalcPhaseInc(float freq, int sync, double bpm) {
    if (sync == 0 || sync > 11) return toU32(F((double) F((double) freq / LFO_SR) * F_2POW32));
    const float b = F(bpm);
    const float tempo = b > 0.0 ? F(F(b / 60.0) / 4.0) : 0;
    const float syncFreq = F(tempo * SYNC_SCALERS[sync]);
    return toU32(F((double) F((double) syncFreq / LFO_SR) * F_2POW32));
}
static double lfoCalc(Lfo& lfo, Rng& rng) {
    const uint32_t old = lfo.phase;
    lfo.phase = lfo.phase + toU32(F(lfo.phaseInc * lfo.modNodeValue));
    const bool overflow = old > lfo.phase;
    const uint32_t ph = lfo.phase;
    switch (lfo.waveform) {
        case 0: return F(F(F(SINE_TABLE[ph >> 20] / (double) F_32767) + 1.0) / 2.0);
        case 1: return F(1 - std::abs((double) F(F(F((double) F((double) ph) / F_2POW32) * 2.0) - 1.0)));
        case 2: return F((double) F((double) ph) / F_2POW32);
        case 4: return ph > 0x7fffffffu ? 1 : 0;
        case 5:
            // (the JS shares this generator with the LXR voices, which are silent here but still draw from it: so the
            // random LFO's values differ from the JS's, though not in kind)
            if (overflow) { lfo.rnd = F((double) rng.next()); lfo.rnd = F((double) lfo.rnd / F_2POW32); }
            return lfo.rnd;
        case 3: return F((double) F((double) (0xffffffffu - ph)) / F_2POW32);
        case 6: { const float x = F((double) F((double) ph) / F_2POW32); return F((double) F((double) x * x) * x); }
        case 7: { const float x = F((double) F((double) (0xffffffffu - ph)) / F_2POW32); return F((double) F((double) x * x) * x); }
        default: return 0;
    }
}

Engine::Engine() : activeParameters((size_t) PAR_NUM_PARAMS, 0) {
    fx.forceWet = false;
}
int Engine::targetPar(int index) { return index >= 0 && index < (int) (sizeof MOD_TARGET_PAR / sizeof MOD_TARGET_PAR[0]) ? MOD_TARGET_PAR[index] : MOD_TARGET_PAR[0]; }
void Engine::loadInitKit() {
    std::vector<int> kit((size_t) PAR_END_OF_SOUND_PARAMETERS, 0);
    for (int i = 8; i < PAR_END_OF_SOUND_PARAMETERS; i++) kit[(size_t) i - 8] = INIT_KIT[i];
    loadKit(kit);
}
void Engine::loadKit(const std::vector<int>& values) {
    for (size_t i = 0; i < values.size() && (int) i < PAR_END_OF_SOUND_PARAMETERS; i++) activeParameters[i] = (uint8_t) values[i];
    for (int i = 0; i < 6; i++) {
        resetTargets(); velocityModulators[(size_t) i].destination = targetPar(activeParameters[(size_t) (PAR_VEL_DEST_1 + i)]);
        resetTargets(); lfos[(size_t) i].modTarget.destination = targetPar(activeParameters[(size_t) (PAR_TARGET_LFO1 + i)]);
    }
    for (int i = 0; i < PAR_END_OF_SOUND_PARAMETERS; i++) { const int p = PARAMETER_ORDER[i]; setParam(p, activeParameters[(size_t) p]); }
}
void Engine::setParam(int par, int value) {
    if (par < 0 || par >= PAR_NUM_PARAMS) return;
    activeParameters[(size_t) par] = (uint8_t) value;
    if (par == 0) return;
    if (par >= PAR_VEL_DEST_1 && par < PAR_VEL_DEST_1 + 6) { resetTargets(); velocityModulators[(size_t) (par - PAR_VEL_DEST_1)].destination = targetPar((uint8_t) value); }
    if (par >= PAR_TARGET_LFO1 && par < PAR_TARGET_LFO1 + 6) { resetTargets(); lfos[(size_t) (par - PAR_TARGET_LFO1)].modTarget.destination = targetPar((uint8_t) value); }
    dispatch(par, value, false, 0);
}
void Engine::dispatch(int par, int data2, bool isFloat, double v) {
    if (par < 128) ccHandler(false, (par + 1) & 0x7f, data2, isFloat, v);
    else ccHandler(true, (par - 128) & 0x7f, data2, isFloat, v);
}
void Engine::modUpdate(ModNode& vm, double val) {
    vm.lastVal = val;
    if (vm.destination < 0 || vm.destination >= 512 || !MODULATABLE[vm.destination]) return;
    const float original = F(activeParameters[(size_t) vm.destination] / 127.0);
    float nv = F(original + F((double) vm.amount * F(F(val * 2) - 1.0)));
    nv = nv < 0 ? 0 : nv > 1 ? 1 : nv;
    dispatch(vm.destination, 0, true, nv);
}
void Engine::setOriginal(int par) {
    if (par < 0 || par >= 512 || !MODULATABLE[par]) return;
    dispatch(par, activeParameters[(size_t) par], false, 0);
}
void Engine::resetTargets() {
    for (auto& vm : velocityModulators) setOriginal(vm.destination);
    for (auto& lfo : lfos) setOriginal(lfo.modTarget.destination);
}
void Engine::lfoSetFreq(Lfo& lfo, double xin) {
    float x = F(F(0.0078125) + F(xin * F(1 - F(0.0078125))));
    x = F((double) F((double) x * x) * x);
    lfo.freq = F(x * 200.0);
    lfo.phaseInc = lfoCalcPhaseInc(lfo.freq, lfo.sync, bpm);
}
void Engine::renderBlock() {
    resetTargets();
    for (auto& vm : velocityModulators) modUpdate(vm, vm.lastVal);
    for (auto& lfo : lfos) modUpdate(lfo.modTarget, lfoCalc(lfo, rng));
}
// the parameter handler, for the parameters that reach anything but the (silent) voices
void Engine::ccHandler(bool isCC2, int num, int data2, bool isFloat, double v) {
    int itg; float flt;
    if (isFloat) { itg = toU8(F(v * 127)); flt = F(v); }
    else { itg = data2 & 0xff; flt = F(itg / 127.0); }
    auto wave = [&](int count) {
        if (!isFloat) return itg;
        const int w = toU8(F((double) count * flt));
        return w >= count ? count - 1 : w;
    };
    if (!isCC2) {
        if (num == 6) { ccHandler(true, activeNrpnNumber & 0xff, itg, false, 0); return; } // NRPN data entry
        if (num == 98) activeNrpnNumber = (activeNrpnNumber & ~0x7f) | (itg & 0x7f);
        else if (num == 99) activeNrpnNumber = ((activeNrpnNumber & 0x7f) | (itg << 7)) & 0xffff;
        else if (num >= 116 && num <= 121) lfoSetFreq(lfos[(size_t) (num - 116)], flt);
        else if (num >= 122 && num <= 127) lfos[(size_t) (num - 122)].modTarget.amount = flt;
        return;
    }
    if (num >= 15 && num <= 20) velocityModulators[(size_t) (num - 15)].amount = flt;
    else if (num >= 27 && num <= 32) lfos[(size_t) (num - 27)].waveform = wave(8);
    else if (num >= 45 && num <= 50) lfos[(size_t) (num - 45)].retrigger = isFloat ? toU8(F(7 * (double) flt)) : itg;
    else if (num >= 51 && num <= 56) { Lfo& lfo = lfos[(size_t) (num - 51)]; lfo.sync = itg; lfo.phaseInc = lfoCalcPhaseInc(lfo.freq, lfo.sync, bpm); }
    else if (num >= 57 && num <= 62) lfos[(size_t) (num - 57)].phaseOffset = toU32(F((double) flt * F_2POW32));
    else if (num >= 87 && num <= 92) audioRouting[(size_t) (num - 87)] = itg;
    else switch (num) {
        case 106: fx.fxType = itg; fx.updateParameter(); break;   // FX_TYPE
        case 107: fx.audioRouting = itg; break;                    // FX_ROUTING
        case 108: fx.dryWet = F(itg / 100.0); break;               // FX_AMOUNT
        case 109: fx.distortion.type = itg; break;                 // FX_DIST_TYPE
        case 110: case 111: case 112: case 113: fx.setParameter(num - 110, flt); break; // FX_P1..4
        case 114: compressorSetRatio(fx.compressor, itg); break;   // FX_RATIO
        case 117: fx.delay.type = itg; break;                      // FX_DELAY_TYPE
        default: break;
    }
}
const int16_t* Engine::renderFx(double width, bool hasWidth, const float* extra) {
    int16_t* inp = fx.input; int16_t* out = fxOut;
    std::memset(inp, 0, sizeof fx.input); std::memset(out, 0, sizeof fxOut);
    // (the voices' sends: all silent)
    if (extra) for (int i = 0; i < 2 * BLOCK; i++) inp[i] = (int16_t) qadd16(ssat16(jsRound(extra[i])), inp[i]);
    const bool del = hasWidth && width != 1 && fx.fxType == FX_DELAY, pp = del && fx.delay.type != DELAY_NORMAL;
    if (pp) for (int i = 0; i < BLOCK; i++) {
        const double l = inp[2 * i], r = inp[2 * i + 1], mid = (l + r) / 2, side = (l - r) / 2;
        const double nl = width <= 1 ? mid + side * width : l + mid * (width - 1), nr = width <= 1 ? mid - side * width : r - mid * (width - 1);
        inp[2 * i] = (int16_t) ssat16(jsRound(nl)); inp[2 * i + 1] = (int16_t) ssat16(jsRound(nr));
    }
    fx.process(out, BLOCK);
    if (del && !pp) for (int i = 0; i < BLOCK; i++) {
        const double mid = (out[2 * i] + out[2 * i + 1]) / 2.0, side = (out[2 * i] - out[2 * i + 1]) / 2.0 * width;
        out[2 * i] = (int16_t) ssat16(jsRound(mid + side)); out[2 * i + 1] = (int16_t) ssat16(jsRound(mid - side));
    }
    return out;
}

} // namespace t8::lxr
