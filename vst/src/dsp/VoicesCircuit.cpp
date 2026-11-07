// C++ ports of the component-level voices (voices/*-circuit.js). Each constructor builds the same circuit, part by
// part and in the same order, as its JS file; the comments there say which part is which.
#include "VoicesCircuit.h"

namespace t8 {

// ---------------------------------------------------------------- BD (voices/bd-circuit.js)
static const double BD_DIVIDER = 100e3 / (82e3 + 100e3);

BDCircuit::BDCircuit(double sr_) : Voice(sr_, { { "level", "Level", 0.8 }, { "tone", "Tone", 0.5 }, { "decay", "Decay", 0.5 },
        P_PITCH(), knobSpec("click", "Click"), knobSpec("attack", "Attack") }),
    ckt({ "T", "B41", "C41n", "N42", "N39", "B43", "X", "P", "Q", "M", "K", "S", "O2", "N6", "V3", "Tn", "L1" }),
    hp(sr_, 2, true) {
    auto& c = ckt;
    const double V15 = 15;
    sw = c.Rsrc("T", 100, 0); sw->on = false;
    c.R("T", "B41", 8.2e3); c.R("B41", "gnd", 2.7e3);
    c.NPN("B41", "C41n", "gnd");
    c.Rsrc("C41n", 1e6, V15); c38 = c.C("C41n", "gnd", 0.1e-6);
    c.NPN("C41n", "N42", "gnd");
    c.Rsrc("N42", 22e3, V15);
    c.C("N42", "N39", 0.033e-6); c.D("N39", "gnd"); c.R("N39", "M", 1e6);
    c.R("N42", "B43", 100e3);
    c.NPN("B43", "K", "gnd");
    c40 = c.C("T", "X", 0.015e-6); c.R("T", "X", 100e3); c.R("X", "gnd", 4.7e3); c.D("gnd", "X");
    c.Op("X", "P", "Q");
    c.R("P", "Q", 1e6);
    cT[0] = c.C("P", "M", 0.015e-6); cT[1] = c.C("M", "Q", 0.015e-6);
    c.R("M", "K", 6.8e3);
    c.R("K", "gnd", 47e3);
    c.R("Q", "S", 47e3);
    c.Op("gnd", "S", "O2");
    c.R("S", "O2", 47e3);
    vr6 = c.R("S", "N6", 250e3);
    c.C("N6", "O2", 33e-6);
    c.R("M", "O2", 470e3);
    c.R("Q", "V3", 220);
    vr5 = c.R("V3", "Tn", 5e3);
    c.C("Tn", "gnd", 0.1e-6);
    c.C("Tn", "L1", 0.47e-6);
    c.R("L1", "gnd", 50e3);
    c.setTimestep(1 / (sr * oversample));
    onParam();
    ckt.settle(2000);
}
void BDCircuit::onParam() {
    vr6->g = 1 / std::max(50.0, 500e3 * clamp(p("decay"), 0, 1));
    const double vr5v = 10e3 * std::pow(1 - clamp(p("tone"), 0, 1), 2) + 1;
    vr5->g = 1 / ((vr5v * 10e3) / (vr5v + 10e3));
    for (Cap* cap : cT) cap->c = 0.015e-6 / pitchMul(p("pitch"));
    c40->c = std::max(1e-12, 0.015e-6 * amtMul(p("click")));
    c38->c = 0.1e-6 * spanMul(p("attack"), 3);
    dk = driveGain(p("drive", 0)); dComp = driveComp(dk);
    ckt.touch();
}
void BDCircuit::trigger(double accent) {
    sw->v = busVoltage(accent);
    sw->on = true; ckt.touch();
    pulseLeft = (int) jsround(TRIG_WIDTH * sr * oversample);
    idle = 0;
}
void BDCircuit::render(float* out, int n) {
    Circuit& c = ckt; const int L1 = c.idx["L1"]; const int os = oversample; const double lvl = p("level");
    if (idle > 3 * sr) return;
    idle += n;
    for (int i = 0; i < n; i++) {
        double y = 0;
        for (int k = 0; k < os; k++) {
            if (pulseLeft > 0 && --pulseLeft == 0) { sw->on = false; c.touch(); }
            c.step();
            y += c.v[(size_t) L1];
        }
        const double o = hp.tick(y / os) * lvl * BD_DIVIDER;
        out[i] += dk == 1 ? o : railClip(dk * o) * dComp;
    }
}

// ---------------------------------------------------------------- SD (voices/sd-circuit.js), revised parts
SDCircuit::SDCircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, { "tone", "Tone", 0.5 },
        { "snappy", "Snappy", 0.5 }, P_PITCH(), P_DECAY(), knobSpec("wires", "Wires"), knobSpec("snapdec", "Snap dec") }, sh) {
    const double c58 = 0.056e-6, c61 = 0.015e-6, r191 = 10e3, r200 = 1;
    Circuit& a = (s1 = &stage({ "TS", "X1", "P1", "M1", "O1", "X2", "P2", "M2", "O2" }), *s1);
    addTrigger(a, "TS");
    a.R("TS", "gnd", 11e3);
    a.R("TS", "X1", 100e3); a.C("TS", "X1", 0.0068e-6); part(a, a.R("X1", "gnd", 680), "inDiv");
    a.Op("X1", "P1", "O1");
    auto pt = [&](Cap* el) { part(a, el, "pitch"); };
    auto up = [&](Res* el) { part(a, el, "qUp"); };
    auto dn = [&](Res* el) { part(a, el, "qDn"); };
    pt(a.C("P1", "M1", c58)); pt(a.C("M1", "O1", 0.027e-6)); dn(a.R("M1", "gnd", 680)); up(a.R("P1", "O1", 820e3));
    a.R("TS", "X2", r191); part(a, a.R("X2", "gnd", 220), "inDiv");
    a.Op("X2", "P2", "O2");
    pt(a.C("P2", "M2", 0.0068e-6)); pt(a.C("M2", "O2", c61)); dn(a.R("M2", "gnd", 2.2e3)); up(a.R("P2", "O2", 1e6));
    Circuit& b = (s2 = &stage({ "B47", "VC", "C47", "P15", "E47", "N52", "NE", "W", "B48", "E48", "C48", "F1", "B49", "E49" }), *s2);
    b.tol = 1e-3;
    const int ts = a.idx["TS"]; Circuit* ap = &a;
    wiper = feed(b, "B47", 33e3, [this, ap, ts](int) { return ts >= 0 ? ap->v[(size_t) ts] * k9 : 0; });
    b.Rsrc("VC", 100, 15); b.C("VC", "gnd", 47e-6);
    b.R("C47", "VC", 330); b.NPN("B47", "C47", "E47");
    rail(b, "P15", 15);
    part(b, b.C("E47", "gnd", 0.47e-6), "env");
    b.R("E47", "N52", 15e3); b.C("N52", "gnd", 0.1e-6);
    b.R("N52", "NE", 15e3); b.C("NE", "gnd", 0.001e-6);
    b.D("NE", "C48");
    NoiseBus* wn = shared.noise;
    feed(b, "W", 10, [wn](int i) { return (double) wn->wn[(size_t) i]; });
    b.C("W", "B48", 0.022e-6); b.Rsrc("B48", 2.2e6, 15);
    b.NPN("B48", "C48", "E48");
    b.R("E48", "gnd", 100); b.C("C48", "gnd", 0.0027e-6);
    part(b, b.C("NE", "F1", 0.0018e-6), "wires"); part(b, b.C("F1", "B49", 0.0018e-6), "wires");
    b.R("B49", "gnd", 47e3); b.R("F1", "E49", 22e3);
    b.NPN("B49", "P15", "E49");
    b.Rsrc("E49", 22e3, -15);
    Circuit& m = (s3 = &stage({ "I1", "A1", "N200", "A3", "WT", "I3", "N69", "S", "OUT", "NV" }), *s3);
    link(m, "I1", 1, a, "O1"); m.C("I1", "A1", 0.047e-6);
    link(m, "N200", r200, a, "O2"); m.C("N200", "A3", 0.047e-6);
    tone = std::make_unique<Pot>(m, "A1", "WT", "A3", 100e3);
    m.R("WT", "S", 100e3);
    link(m, "I3", 1, b, "E49"); m.C("I3", "N69", 0.01e-6); m.R("N69", "S", 27e3);
    m.Op("gnd", "S", "OUT");
    part(m, m.R("S", "OUT", 470e3), "fbR"); part(m, m.C("S", "OUT", 220e-12), "fbC");
    vr7 = m.R("S", "NV", 100e3); part(m, m.C("NV", "OUT", 33e-6), "fbC");
    iOut = m.idx["OUT"];
    finish();
}
void SDCircuit::onParam() {
    const double s = p("snappy"), lo = 1e3 + 10e3 * s, hi = 10e3 * (1 - s);
    k9 = lo / 11e3;
    if (wiper) { wiper->g = 1 / (33e3 + (lo * hi) / 11e3); s2->touch(); }
    if (tone) tone->set(1 - p("tone"));
    const double m = pitchMul(p("pitch")), d = decayMul(p("decay"));
    scale("pitch", 1 / m); scale("qUp", d); scale("qDn", 1 / d);
    scale("env", spanMul(p("snapdec"), 3)); scale("wires", 1 / spanMul(p("wires"), 2));
    scale("inDiv", 1 / d);
    if (vr7) { vr7->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk); s3->touch(); }
}

// ---------------------------------------------------------------- toms and congas (voices/tom-circuit.js)
struct TomNoise { double c72, c71, r216, r217, r218, r220, r221, c74, r223, r222, c75; };
struct TomParts { double cIn, rIn, rX, c1, c2, rf, rs, rfb, cOut; bool hasNoise; TomNoise noise; };
static TomParts tomParts(const std::string& key) {
    if (key == "lt") return { 0.0068e-6, 22e3, 4.7e3, 0.056e-6, 0.012e-6 + 0.047e-6, 820e3, 1e3, 820e3, 0.047e-6, true,
        { 0.039e-6, 0.047e-6, 15e3, 3.3e3, 2.2e6, 33e3, 4.7e3, 0.047e-6, 22e3, 22e3, 0.018e-6 } };
    if (key == "lc") return { 0.0068e-6, 22e3, (4.7e3 * 1.5e3) / 6.2e3, 0.056e-6, 0.012e-6, 820e3, 1e3, 820e3, 0.047e-6, false, {} };
    if (key == "mt") return { 0.0027e-6, 22e3, 6.8e3, 0.027e-6 + 0.0082e-6, 0.012e-6 + 0.027e-6, 820e3, 1e3, 820e3, 0.039e-6, true,
        { 0.033e-6, 0.047e-6, 15e3, 3.3e3, 2.2e6, 33e3, 4.7e3, 0.033e-6, 22e3, 22e3, 0.015e-6 } };
    if (key == "mc") return { 0.0027e-6, 22e3, (6.8e3 * 2.2e3) / 9e3, 0.027e-6, 0.012e-6, 820e3, 1e3, 820e3, 0.039e-6, false, {} };
    if (key == "ht") return { 0.0027e-6, 22e3, 5.6e3, 0.027e-6, 0.0056e-6 + 0.022e-6, 820e3, 1e3, 820e3, 0.033e-6, true,
        { 0.033e-6, 0.047e-6, 15e3, 3.3e3, 2.2e6, 33e3, 4.7e3, 0.027e-6, 22e3, 22e3, 0.01e-6 } };
    return { 0.0027e-6, 22e3, (5.6e3 * 1.5e3) / 7.1e3, 0.027e-6, 0.0056e-6, 820e3, 1e3, 820e3, 0.033e-6, false, {} }; // hc
}
static const std::map<std::string, std::vector<std::array<double, 2>>> TOM_DECAY = {
    { "lt", { { 0, 0.49 }, { 0.25, 0.54 }, { 0.5, 0.66 }, { 0.75, 0.8 }, { 1, 1 }, { 1.2, 1.22 }, { 1.4, 1.56 }, { 1.6, 2.15 }, { 1.7, 2.68 }, { 1.75, 3 } } },
    { "mt", { { 0, 0.56 }, { 0.5, 0.72 }, { 0.75, 0.8 }, { 1, 1 }, { 1.2, 1.24 }, { 1.4, 1.6 }, { 1.6, 2.08 }, { 1.7, 2.56 }, { 1.78, 3 } } },
    { "ht", { { 0, 0.45 }, { 0.25, 0.55 }, { 0.5, 0.65 }, { 0.75, 0.75 }, { 1, 1 }, { 1.2, 1.25 }, { 1.4, 1.6 }, { 1.6, 2.25 }, { 1.7, 3 } } },
    { "lc", { { 0, 0.19 }, { 0.25, 0.24 }, { 0.5, 0.32 }, { 0.75, 0.49 }, { 1, 1 }, { 1.05, 1.24 }, { 1.1, 1.7 }, { 1.15, 2.49 }, { 1.165, 3 } } },
    { "mc", { { 0, 0.32 }, { 0.25, 0.37 }, { 0.5, 0.47 }, { 0.75, 0.63 }, { 1, 1 }, { 1.1, 1.26 }, { 1.2, 1.63 }, { 1.25, 2.05 }, { 1.3, 2.68 }, { 1.32, 3 } } },
    { "hc", { { 0, 0.18 }, { 0.25, 0.24 }, { 0.5, 0.29 }, { 0.75, 0.47 }, { 1, 1 }, { 1.05, 1.29 }, { 1.1, 1.76 }, { 1.15, 2.65 }, { 1.16, 3 } } },
};
static std::array<double, 2> tomDecay(const std::string& key, double v) {
    const auto& T = TOM_DECAY.at(key);
    const double r = std::min(T.back()[1], std::max(T[0][1], decayMul(v)));
    size_t i = 1; while (i < T.size() - 1 && T[i][1] < r) i++;
    const double p0 = T[i - 1][0], r0 = T[i - 1][1], p1 = T[i][0], r1 = T[i][1];
    return { r, p0 + ((p1 - p0) * std::log(r / r0)) / std::log(r1 / r0) };
}
static std::vector<ParamSpec> tomSpec(const std::string& key) {
    std::vector<ParamSpec> s { { "level", "Level", 0.8 }, { "tuning", "Tuning", 0.5 }, P_PITCH(), P_DECAY() };
    if (tomParts(key).hasNoise) s.push_back(knobSpec("noise", "Noise"));
    return s;
}
TomCircuit::TomCircuit(double sr_, Shared sh, const std::string& k) : CircuitVoice(sr_, tomSpec(k), sh), key(k) {
    const TomParts P = tomParts(key);
    Circuit& a = (s1 = &stage({ "TT", "Y", "X", "P", "Mt", "O1", "N15", "O2", "W11", "T11" }), *s1);
    addTrigger(a, "TT");
    a.R("TT", "gnd", 4.7e3);
    a.C("TT", "Y", P.cIn); a.D("gnd", "Y");
    a.R("Y", "X", P.rIn); a.R("X", "gnd", P.rX);
    a.Op("X", "P", "O1");
    part(a, a.C("P", "Mt", P.c1), "pitch"); part(a, a.C("Mt", "O1", P.c2), "pitch");
    a.R("P", "O1", P.rf);
    a.R("Mt", "W11", P.rs);
    a.D("Mt", "T11"); a.D("T11", "Mt");
    vrA = a.R("T11", "W11", 250); vrB = a.R("W11", "gnd", 250);
    a.R("O1", "N15", 33e3); a.R("N15", "O2", 33e3); a.Op("gnd", "N15", "O2");
    part(a, a.R("O2", "Mt", P.rfb), "fb");
    std::vector<std::string> nodes { "J", "S", "OUT", "NV" };
    if (P.hasNoise) for (const char* x : { "TTc", "E", "G", "H", "B52", "C52", "N223", "N75", "P15" }) nodes.push_back(x);
    Circuit& m = (s2 = &stage(nodes), *s2);
    link(m, "J", 100e3, a, "O1");
    m.C("J", "S", P.cOut);
    m.Op("gnd", "S", "OUT");
    part(m, m.R("S", "OUT", 470e3), "fbR"); part(m, m.C("S", "OUT", 0.001e-6), "fbC");
    vr10 = m.R("S", "NV", 100e3); part(m, m.C("NV", "OUT", 33e-6), "fbC");
    if (P.hasNoise) {
        const TomNoise& N = P.noise; NoiseBus* pn = shared.noise;
        link(m, "TTc", 4.7e3, a, "TT");
        m.D("TTc", "E"); part(m, m.C("E", "gnd", N.c72), "env");
        m.R("E", "G", N.r218);
        feed(m, "H", N.r216, [pn](int i) { return (double) pn->pn[(size_t) i]; });
        m.R("H", "gnd", N.r217); m.C("G", "H", N.c71);
        m.R("G", "B52", N.r220);
        rail(m, "P15", 15);
        m.R("P15", "C52", N.r221); m.NPN("B52", "C52", "gnd");
        m.C("C52", "N223", N.c74); m.R("N223", "gnd", N.r223);
        m.R("N223", "N75", N.r222); m.C("N75", "gnd", N.c75);
        r232 = m.R("N75", "J", 100e3); r232g0 = 1 / 100e3;
        m.tol = 1e-4;
    }
    iOut = m.idx["OUT"];
    finish();
}
void TomCircuit::onParam() {
    const double r = 500 * (1 - p("tuning"));
    if (vrA) { vrA->g = 1 / std::max(1.0, 500 - r); vrB->g = 1 / std::max(1.0, r); s1->touch(); }
    const auto dp = tomDecay(key, p("decay"));
    scale("pitch", 1 / pitchMul(p("pitch"))); scale("fb", 1 / dp[1]); scale("env", dp[0]);
    if (r232) {
        const double nz = p("noise");
        r232->g = std::max(1e-12, r232g0 * (nz < 0.5 ? amtMul(nz) : std::pow(8.0, 2 * nz - 1))); s2->touch();
    }
    if (vr10) { vr10->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk); s2->touch(); }
}

// ---------------------------------------------------------------- RS / CL (voices/rscl-circuit.js)
static std::vector<ParamSpec> rsclSpec(bool rs) {
    std::vector<ParamSpec> s { { "level", "Level", 0.8 }, P_PITCH(), P_DECAY() };
    if (rs) s.push_back(knobSpec("click", "Click"));
    return s;
}
RSCLCircuit::RSCLCircuit(double sr_, Shared sh, bool rs_) : CircuitVoice(sr_, rsclSpec(rs_), sh), rs(rs_) {
    Circuit& a = (s1 = &stage({ "TR", "N307", "N301", "X21", "P21", "M21", "O21", "N306", "N310", "X20", "P20", "M20", "O20a", "I20b", "O20b", "B61", "G61", "M15" }), *s1);
    addTrigger(a, "TR");
    a.R("TR", "gnd", 22e3);
    a.C("TR", "N307", 0.01e-6); a.R("N307", "gnd", 100e3);
    a.D("N307", "N301"); a.R("N301", "X21", 47e3); a.R("X21", "gnd", 10e3);
    a.Op("X21", "P21", "O21");
    auto pt = [&](Cap* el) { part(a, el, "pitch"); };
    pt(a.C("P21", "M21", 0.0047e-6)); pt(a.C("M21", "O21", 0.0047e-6));
    a.R("M21", "gnd", 5.6e3); a.R("P21", "O21", 1e6);
    a.C("TR", "N306", 0.001e-6); a.R("N306", "gnd", 22e3);
    a.D("N306", "N310"); a.R("N310", "X20", 33e3); a.R("X20", "gnd", 10e3);
    a.Op("X20", "P20", "O20a");
    pt(a.C("P20", "M20", 0.0022e-6)); pt(a.C("M20", "O20a", 0.0022e-6));
    a.R("M20", "gnd", 1e3); a.R("P20", "O20a", 820e3);
    if (rs) pt(a.C("M20", "O20a", 0.0022e-6));
    else a.R("M20", "O20b", 390e3);
    a.R("O20a", "I20b", 33e3); a.R("I20b", "O20b", 33e3); a.Op("gnd", "I20b", "O20b");
    a.C("TR", "B61", 0.022e-6); a.Rsrc("B61", 47e3, -15);
    rail(a, "M15", -15);
    a.NPN("B61", "G61", "M15");
    a.R("G61", "gnd", 1e6); part(a, a.C("G61", "gnd", 0.047e-6), "env");
    Circuit* srcC; const char* srcN; double srcR;
    if (rs) {
        Circuit& b = (s2 = &stage({ "TRc", "N61", "E24", "N108", "K62", "B62", "N317", "N322", "B63", "E63", "P15" }), *s2);
        link(b, "TRc", 1, a, "TR");
        b.D("TRc", "N61"); b.R("N61", "E24", 1e3); part(b, b.C("E24", "gnd", 0.47e-6), "env");
        b.R("E24", "N108", 10e3); b.D("N108", "K62");
        b.NPN("B62", "K62", "gnd");
        b.Rsrc("B62", 2.2e6, 15); b.C("B62", "N317", 10e-6);
        part(b, b.R("N317", "gnd", 10e3), "click");
        link(b, "N317", 220e3, a, "O21");
        link(b, "N317", 22e3, a, "O20b");
        b.C("K62", "N322", 0.0047e-6); b.C("N322", "B63", 0.0047e-6);
        b.R("N322", "E63", 10e3); b.R("B63", "gnd", 330e3);
        rail(b, "P15", 15);
        b.NPN("B63", "P15", "E63"); b.Rsrc("E63", 22e3, -15);
        srcC = &b; srcN = "E63"; srcR = 180e3;
    } else { srcC = &a; srcN = "O20b"; srcR = 220e3; }
    Circuit& m = (s3 = &stage({ "K", "N326", "S", "OUT", "NV" }), *s3);
    link(m, "K", srcR, *srcC, srcN);
    m.C("K", "N326", 0.01e-6); m.R("N326", "S", 10e3);
    m.Op("gnd", "S", "OUT");
    part(m, m.R("S", "OUT", 470e3), "fbR"); part(m, m.C("S", "OUT", 22e-12), "fbC");
    part(m, m.C("S", "NV", 33e-6), "fbC");
    vr16 = m.R("NV", "OUT", 100e3);
    fet = m.DynEl("NV", "OUT");
    const int io = m.idx["OUT"]; Circuit* mp = &m;
    feed(a, "G61", 470e3, [mp, io](int) { return mp->v[(size_t) io]; });
    iG = a.idx["G61"]; iNV = m.idx["NV"]; iOut = io;
    finish();
}
void RSCLCircuit::pre(int) {
    const auto& m = s3->v; const double vs = std::min(m[(size_t) iNV], m[(size_t) iOut]);
    const double vgs = s1->v[(size_t) iG] - vs;
    double k = 1 - vgs / -3.5; k = k < 0 ? 0 : k > 1.5 ? 1.5 : k;
    fet->g = ((k * k) / 875 + 1e-9) / dk;
}
void RSCLCircuit::onParam() {
    scale("pitch", 1 / pitchMul(p("pitch"))); scale("env", decayMul(p("decay")));
    scale("click", spanMul(p("click"), 3));
    if (vr16) { vr16->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk); s3->touch(); }
}

// ---------------------------------------------------------------- CP / MA (voices/cpma-circuit.js)
namespace CPP { const double C144 = 0.37e-6, C140 = 0.021e-6, R200 = 10e3, TM3 = 0.706, C127 = 1.24e-9, C128 = 5.8e-9, C138 = 0.07e-6, C139 = 0.0163e-6, C150 = 2.7e-9, BF72 = 400; }

template <class V> static void cpmaMixer(V& v, Circuit& m) {
    m.Op("gnd", "S", "OUT");
    v.part(m, m.R("S", "OUT", 470e3), "fbR"); v.part(m, m.C("S", "OUT", 220e-12), "fbC");
    v.vr17 = m.R("S", "NV", 100e3); v.part(m, m.C("NV", "OUT", 33e-6), "fbC");
    v.iOut = m.idx["OUT"]; v.mix = &m;
}

CPCircuit::CPCircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, { "snap", "Snap", 0 }, P_PITCH(), P_DECAY(),
        knobSpec("spacing", "Spacing") }, sh) {
    tm3 = CPP::TM3;
    NoiseBus* wn = shared.noise;
    Circuit& f = (s1 = &stage({ "WNc", "L", "Nm", "B" }), *s1);
    feed(f, "WNc", 1, [wn](int i) { return (double) wn->wn[(size_t) i]; });
    auto pt = [&](Cap* el) { part(f, el, "pitch"); };
    f.R("WNc", "L", 27e3); pt(f.C("WNc", "L", CPP::C127)); f.R("L", "gnd", 10e3);
    pt(f.C("L", "Nm", CPP::C128)); pt(f.C("L", "B", CPP::C128)); f.R("Nm", "B", 100e3);
    f.Op("gnd", "Nm", "B");
    Circuit& e = (s2 = &stage({ "CP", "TH", "P15", "E69", "N139", "N138", "N143" }), *s2);
    addTrigger(e, "CP");
    e.R("CP", "TH", 27e3); e.Rsrc("TH", 22e3, -15);
    rail(e, "P15", 15);
    e.NPN("CP", "P15", "E69");
    e.D("E69", "N139"); part(e, e.C("N139", "gnd", CPP::C139), "env");
    e.R("N139", "N138", 1e6); e.C("N138", "gnd", CPP::C138);
    e.D("E69", "N143"); e.C("N143", "gnd", 1e-6);
    Circuit& c = (s3 = &stage({ "OC", "OB", "Dm", "OA", "SAW", "Dp", "OD", "N141", "B73", "C73", "M15" }), *s3);
    rail(c, "M15", -15);
    c.R("OC", "gnd", 1e6); c.C("OC", "gnd", CPP::C140);
    c.R("OB", "Dm", 2.7e3); c.R("Dm", "gnd", 5.6e3);
    part(c, c.R("OA", "gnd", 82e3), "spacing"); c.D("OA", "SAW");
    c.C("SAW", "gnd", CPP::C144);
    c.R("SAW", "Dp", 1e6); c.C("OD", "Dp", 220e-12);
    c.R("OD", "gnd", 10e3); c.R("OD", "B73", 68e3);
    c.C("OB", "N141", 0.001e-6); c.D("M15", "N141"); c.R("N141", "B73", 68e3);
    c.NPN("B73", "C73", "M15"); c.R("C73", "SAW", 330);
    Circuit& x = (s3x = &stage({ "B72", "B71", "EE", "IA", "M15" }), *s3x);
    rail(x, "M15", -15);
    link(x, "B72", 470e3, c, "SAW"); link(c, "SAW", 470e3, x, "B72");
    x.R("B72", "gnd", 15e3);
    x.R("B71", "gnd", 2.2e3);
    { Circuit* xp = &x; const int ib = x.idx["B71"]; feed(e, "N143", 330e3, [xp, ib](int) { return xp->v[(size_t) ib]; }); }
    link(x, "B71", 330e3, e, "N143");
    tm = x.Rsrc("B71", 47e3, 0);
    x.Rsrc("EE", 15e3, 15);
    { const PartModel q { 2e-14, CPP::BF72, 3 }; x.PNP("B72", "IA", "EE", q); x.PNP("B71", "M15", "EE", q); }
    x.Rsrc("IA", 10e3, -15 + 1.2);
    for (const char* nn : { "OC", "OB", "OA", "OD" }) cmp.push_back(c.DynEl(nn, nullptr, -15));
    Circuit& m = (s4 = &stage({ "Bc", "K136", "I2", "O6", "BUF", "N150", "V", "B70", "C70", "E70", "N152", "S", "OUT", "NV" }), *s4);
    link(m, "Bc", 1, f, "B");
    m.C("Bc", "K136", 0.022e-6); m.R("K136", "I2", 39e3); m.R("I2", "gnd", 1e3);
    m.R("O6", "gnd", 82e3); ota = m.DynEl("O6");
    m.Op("O6", "BUF", "BUF");
    m.C("BUF", "N150", CPP::C150); m.R("N150", "S", 100e3);
    link(m, "V", 15e3, f, "B"); m.R("V", "gnd", 680);
    m.C("V", "B70", 0.033e-6);
    link(m, "B70", 1e6, e, "N138");
    { Circuit* mp = &m; const int ib = m.idx["B70"]; feed(e, "N138", 1e6, [mp, ib](int) { return mp->v[(size_t) ib]; }); }
    m.NPN("B70", "C70", "E70"); m.R("E70", "gnd", 330);
    m.Rsrc("E70", CPP::R200, -15);
    m.Rsrc("C70", 10e3, 15); m.C("C70", "gnd", 0.018e-6);
    m.C("C70", "N152", 0.0047e-6); r376 = m.R("N152", "S", 47e3);
    cpmaMixer(*this, m);
    m.tol = 1e-4; f.tol = 1e-4;
    ixTH = e.idx["TH"]; ixOC = c.idx["OC"]; ixOB = c.idx["OB"]; ixDm = c.idx["Dm"]; ixDp = c.idx["Dp"]; ixIA = x.idx["IA"]; ixI2 = m.idx["I2"];
    finish((int) jsround(sr * 1.2));
}
void CPCircuit::pre(int) {
    const auto& e = s2->v; const auto& c = s3->v; const auto& xv = s3x->v;
    const bool on[4] = { e[(size_t) ixTH] > -10, c[(size_t) ixOC] < -5, c[(size_t) ixOB] > -5, c[(size_t) ixDp] < c[(size_t) ixDm] };
    for (int k = 0; k < 4; k++) cmp[(size_t) k]->g = on[k] ? 1.0 / 100 : 0;
    const double iabc = std::max(0.0, (xv[(size_t) ixIA] + 13.8) / 10e3);
    ota->i = iabc * std::tanh(-s4->v[(size_t) ixI2] / (2 * VT));
}
void CPCircuit::onParam() {
    if (r376) { r376->g = std::max(1e-12, 1 - p("snap", 0)) / 47e3; mix->touch(); }
    scale("pitch", 1 / pitchMul(p("pitch"))); scale("env", decayMul(p("decay")));
    scale("spacing", spanMul(p("spacing"), 2));
    if (tm) tm->v = -15 * tm3;
    if (vr17) { vr17->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk); mix->touch(); }
}
void CPCircuit::trigger(double accent) { accGain = 1 + 1.4 * std::min(1.0, std::max(0.0, accent)); fire(switches[0], 0); }

MACircuit::MACircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, P_PITCH(), P_DECAY() }, sh) {
    NoiseBus* wn = shared.noise;
    Circuit& a = (s1 = &stage({ "MA", "N135", "B67", "N67", "N134", "E66" }), *s1);
    addTrigger(a, "MA");
    a.R("MA", "gnd", 1e6);
    a.D("MA", "N135"); part(a, a.C("N135", "gnd", 0.1e-6), "env"); a.R("N135", "gnd", 150e3);
    a.R("N135", "B67", 220e3); a.NPN("B67", "N67", "gnd");
    a.Rsrc("N67", 100e3, 15);
    a.R("N67", "N134", 470e3); a.D("N67", "N134"); part(a, a.C("N134", "gnd", 0.033e-6), "env");
    a.PNP("N134", "gnd", "E66");
    Circuit& b = (s1b = &stage({ "Z", "N335", "B65", "C65", "P15", "F", "F2", "B68", "E68" }), *s1b);
    link(b, "Z", 10e3, a, "E66"); link(a, "E66", 10e3, b, "Z");
    rail(b, "P15", 15);
    feed(b, "N335", 6.8e3, [wn](int i) { return (double) wn->wn[(size_t) i]; });
    b.C("N335", "B65", 0.047e-6); b.R("B65", "gnd", 1e6);
    b.PNP("B65", "C65", "P15"); b.D("C65", "Z");
    auto pt = [&](Cap* el) { part(b, el, "pitch"); };
    pt(b.C("Z", "F", 0.01e-6)); b.R("F", "gnd", 15e3);
    pt(b.C("F", "F2", 0.001e-6)); pt(b.C("F2", "B68", 0.001e-6));
    b.R("F2", "E68", 3.3e3); b.R("B68", "gnd", 68e3);
    b.NPN("B68", "P15", "E68"); b.Rsrc("E68", 22e3, -15);
    b.tol = 1e-3;
    Circuit& m = (s2 = &stage({ "E68c", "N151", "S", "OUT", "NV" }), *s2);
    link(m, "E68c", 1, b, "E68");
    m.C("E68c", "N151", 0.01e-6); m.R("N151", "S", 100e3);
    cpmaMixer(*this, m);
    finish();
}
void MACircuit::onParam() {
    scale("pitch", 1 / pitchMul(p("pitch"))); scale("env", decayMul(p("decay")));
    if (vr17) { vr17->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk); mix->touch(); }
}

// ---------------------------------------------------------------- CB (voices/cb-circuit.js)
double voicingTrigger(double accent) {
    const double bus = busVoltage(accent), Is = 2.52e-9, nvt = 1.752 * 0.02585;
    double vd = 0.6, vp = 0;
    for (int k = 0; k < 20; k++) {
        vp = (bus / 100e3 + vd / 15e3) / (1 / 100e3 + 1 / 15e3 + 1 / 3.3e3);
        const double id = std::max(1e-9, (bus - vd) / 3.3e3 - (vd - vp) / 15e3);
        vd = nvt * std::log(1 + id / Is);
    }
    return std::min(13.5, vp * (1 + 100 / 3.3)) - 0.1;
}
CBCircuit::CBCircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, P_PITCH(), P_DECAY(),
        knobSpec("detune", "Detune"), knobSpec("ring", "Ring") }, sh) {
    Circuit& a = (s1 = &stage({ "T5", "N122", "E9", "N82", "N3", "N4", "N62", "B15", "C15", "E15", "N64", "B14", "C14", "E14", "K30", "K31", "A", "Pm", "O2" }), *s1);
    addTrigger(a, "T5");
    a.R("T5", "gnd", 100e3);
    a.R("T5", "N122", 1e3); a.D("N122", "E9"); part(a, a.C("E9", "gnd", 0.47e-6), "env");
    a.R("E9", "N82", 33e3); part(a, a.C("N82", "gnd", 1e-6), "env");
    a.R("E9", "N3", 100e3); a.R("E9", "N4", 100e3);
    feed(a, "N62", 33e3, [this](int i) { return (double) mc().v[4][(size_t) i]; }); a.R("N62", "gnd", 2.2e3);
    a.C("N62", "B15", 10e-6); a.Rsrc("B15", 470e3, 15);
    a.NPN("B15", "C15", "E15"); a.R("E15", "gnd", 100);
    feed(a, "N64", 33e3, [this](int i) { return (double) mc().v[5][(size_t) i]; }); a.R("N64", "gnd", 2.2e3);
    a.C("N64", "B14", 10e-6); a.Rsrc("B14", 470e3, 15);
    a.NPN("B14", "C14", "E14"); a.R("E14", "gnd", 100);
    a.D("N3", "C15"); a.D("N4", "C14");
    a.R("N3", "K30", 10e3); a.C("K30", "A", 0.0022e-6);
    a.R("N4", "K31", 10e3); a.C("K31", "A", 0.0022e-6);
    part(a, a.R("A", "gnd", 2.2e3), "ringDn"); a.C("A", "Pm", 0.01e-6); a.C("A", "O2", 0.0033e-6);
    part(a, a.R("Pm", "O2", 470e3), "ringUp"); a.Op("gnd", "Pm", "O2");
    Circuit& m = (s2 = &stage({ "Oc", "N75", "VT", "W5", "BP", "OUT" }), *s2);
    link(m, "Oc", 1, a, "O2");
    m.C("Oc", "N75", 1e-6); m.R("N75", "VT", 8.2e3);
    vrT = m.R("VT", "W5", 2.5e3); vrB = m.R("W5", "gnd", 2.5e3);
    m.C("W5", "BP", 0.022e-6); m.R("BP", "gnd", 22e3);
    m.Op("BP", "OUT", "OUT");
    iOut = m.idx["OUT"];
    finish(3000, 0.25);
}
void CBCircuit::onParam() {
    pitchMetal(pitchMul(p("pitch")), false, spreadExp(p("detune")), { 4, 5 });
    const double q = spanMul(p("ring"), 3); scale("ringUp", q); scale("ringDn", 1 / q); scale("env", decayMul(p("decay")));
    if (!vrT) return;
    const double r = 5e3 * aTaper(p("level"));
    vrT->g = 1 / std::max(1.0, 5e3 - r); vrB->g = 1 / std::max(1.0, r); s2->touch();
}

// ---------------------------------------------------------------- CY (voices/cy-circuit.js)
void CYCircuit::vca(Circuit& c, std::function<double(int)> src, const std::string& tag, const char* sNode) {
    const std::string B = "B" + tag, C = "C" + tag, E = "E" + tag, I = "I" + tag;
    feed(c, I.c_str(), 1, std::move(src));
    c.C(I, B, 0.022e-6); c.Rsrc(B, 2e6, 15);
    c.NPN(B, C, E); c.R(E, "gnd", 100);
    c.C(C, "gnd", 0.0015e-6); c.D(sNode, C);
    c.C(sNode, "gnd", 0.0015e-6);
}
CYCircuit::CYCircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, { "tone", "Tone", 0.5 }, { "decay", "Decay", 0.5 },
        P_PITCH(), knobSpec("spread", "Spread") }, sh) {
    sleepAfter = 0.3;
    Circuit& e = (s1 = &stage({ "T6", "B19", "C19", "VC", "X19", "E1", "N37", "E2", "N88", "B20", "P15", "E20", "N89", "N105" }), *s1);
    addTrigger(e, "T6");
    e.R("T6", "gnd", 22e3); e.R("T6", "B19", 10e3);
    e.Rsrc("VC", 100, 15); e.C("VC", "gnd", 47e-6); e.R("VC", "C19", 100);
    e.NPN("B19", "C19", "X19");
    e.D("X19", "E1"); e.C("E1", "gnd", 1e-6);
    e.R("E1", "N37", 22e3); e.C("N37", "gnd", 2.2e-6);
    e.D("X19", "E2"); e.C("E2", "gnd", 1e-6);
    e.R("E2", "N88", 33e3); e.C("N88", "gnd", 0.47e-6);
    e.D("X19", "B20"); e.C("B20", "gnd", 1e-6);
    vr2 = e.R("B20", "gnd", 1.47e6);
    rail(e, "P15", 15);
    e.NPN("B20", "P15", "E20");
    e.R("E20", "N89", 33e3); e.R("N89", "gnd", 10e3);
    e.R("E20", "N105", 33e3); e.C("N105", "gnd", 2.2e-6);
    auto hiF = [this](int i) { return (double) mc().hi[(size_t) i]; };
    auto loF = [this](int i) { return (double) mc().lo[(size_t) i]; };
    Circuit& h1 = (s2 = &stage({ "I16", "B16", "C16", "E16", "S16", "N49", "N53", "P5", "M5", "O5" }), *s2);
    vca(h1, hiF, "16", "S16");
    link(h1, "S16", 39e3, e, "E1"); link(e, "E1", 39e3, h1, "S16");
    h1.C("S16", "N49", 0.0033e-6); h1.R("N49", "gnd", 6.8e3);
    h1.C("N49", "N53", 0.001e-6); h1.C("N53", "P5", 0.001e-6);
    h1.R("P5", "gnd", 18e3); h1.R("N53", "O5", 18e3);
    h1.Op("P5", "M5", "O5"); h1.R("M5", "gnd", 22e3); h1.R("M5", "O5", 39e3);
    Circuit& h2 = (s3 = &stage({ "I17", "B17", "C17", "E17", "S17", "N51", "P5b", "M5b", "O5b" }), *s3);
    vca(h2, hiF, "17", "S17");
    link(h2, "S17", 33e3, e, "N88"); link(e, "N88", 33e3, h2, "S17");
    link(h2, "S17", 33e3, e, "N89"); link(e, "N89", 33e3, h2, "S17");
    h2.C("S17", "N51", 0.001e-6); h2.C("N51", "P5b", 0.001e-6);
    h2.R("P5b", "gnd", 18e3); h2.R("N51", "O5b", 18e3);
    h2.Op("P5b", "M5b", "O5b"); h2.R("M5b", "gnd", 39e3); h2.R("M5b", "O5b", 39e3);
    Circuit& lo = (s4 = &stage({ "I18", "B18", "C18", "E18", "S18", "N48", "B25", "E25", "P15" }), *s4);
    vca(lo, loF, "18", "S18");
    link(lo, "S18", 22e3, e, "N105"); link(e, "N105", 22e3, lo, "S18");
    lo.C("S18", "N48", 0.0015e-6); lo.C("N48", "B25", 0.0015e-6);
    lo.R("N48", "E25", 22e3); lo.R("B25", "gnd", 82e3);
    rail(lo, "P15", 15);
    lo.NPN("B25", "P15", "E25"); lo.Rsrc("E25", 22e3, -15);
    Circuit& m = (s5 = &stage({ "I55", "N55", "TH", "J", "I56", "N56", "L", "I58", "N58", "N57", "S", "OUT", "NV" }), *s5);
    link(m, "I55", 1, h1, "O5"); m.C("I55", "N55", 0.01e-6); m.R("N55", "TH", 22e3);
    link(m, "I56", 1, h2, "O5b"); m.C("I56", "N56", 0.01e-6); m.R("N56", "L", 10e3);
    link(m, "I58", 1, lo, "E25"); m.C("I58", "N58", 0.01e-6); m.R("N58", "N57", 100e3);
    m.C("N57", "gnd", 0.0033e-6); m.R("N57", "L", 10e3);
    vr4a = m.R("TH", "gnd", 10e3); vr4b = m.R("L", "gnd", 12.2e3);
    m.R("TH", "J", 22e3); m.R("L", "J", 15e3);
    m.C("J", "S", 0.01e-6);
    m.Op("gnd", "S", "OUT");
    part(m, m.R("S", "OUT", 470e3), "fbR"); part(m, m.C("S", "OUT", 220e-12), "fbC");
    vr6 = m.R("S", "NV", 100e3); part(m, m.C("NV", "OUT", 33e-6), "fbC");
    iOut = m.idx["OUT"];
    for (Circuit* st : { &h1, &h2, &lo }) st->tol = 1e-4;
    finish(3000, 0.3);
}
void CYCircuit::onParam() {
    pitchMetal(pitchMul(p("pitch")), true, spreadExp(p("spread")));
    if (!vr6) return;
    vr2->g = 1 / (470e3 + 2e6 * p("decay"));
    const double t = p("tone");
    vr4a->g = 1 / std::max(1.0, 20e3 * t); vr4b->g = 1 / (20e3 * (1 - t) + 2.2e3);
    vr6->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk);
    s1->touch(); s5->touch();
}

// ---------------------------------------------------------------- OH / CH (voices/hats-circuit.js)
template <class V> static void swingHat(V& v, Circuit& c) {
    v.feed(c, "IH", 1, [&v](int i) { return (double) v.mc().hi[(size_t) i]; });
    c.C("IH", "BQ", 0.022e-6); c.Rsrc("BQ", 2e6, 15);
    c.NPN("BQ", "CQ", "EQ"); c.R("EQ", "gnd", 100);
    c.C("CQ", "gnd", 0.0015e-6); c.D("Y", "CQ"); c.C("Y", "gnd", 0.0015e-6);
}
template <class V> static void hatMixer(V& v, Circuit& m, double rin, double cin) {
    m.C("IE", "NC", cin); m.R("NC", "S", rin);
    m.Op("gnd", "S", "OUT");
    v.part(m, m.R("S", "OUT", 470e3), "fbR"); v.part(m, m.C("S", "OUT", 220e-12), "fbC");
    v.vrL = m.R("S", "NV", 100e3); v.part(m, m.C("NV", "OUT", 33e-6), "fbC");
    v.iOut = m.idx["OUT"]; v.mix = &m;
}
OHCircuit::OHCircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, { "decay", "Decay", 0.5 }, P_PITCH(),
        knobSpec("spread", "Spread"), knobSpec("tone", "Tone") }, sh) {
    sleepAfter = 0.3;
    Circuit& e = (s1 = &stage({ "T7", "N131", "B24", "VC", "C24", "E24", "N134", "B23", "B22", "N60", "B29", "P15", "E29" }), *s1);
    addTrigger(e, "T7");
    e.R("T7", "B24", 10e3);
    e.R("T7", "N131", 22e3); e.R("N131", "gnd", 10e3);
    e.Rsrc("VC", 100, 15); e.C("VC", "gnd", 47e-6); e.R("VC", "C24", 470);
    e.NPN("B24", "C24", "E24");
    e.C("E24", "gnd", 0.47e-6); e.R("E24", "gnd", 1e6);
    e.R("E24", "N134", 100e3);
    e.NPN("B22", "N134", "gnd"); e.NPN("B23", "N134", "gnd");
    chokeHold = 0;
    chokeFeed = feed(e, "B23", 330e3, [this](int i) {
        if (chokeHold > 0) return 6.0;
        if (!chokeFrom) return 0.0;
        return i < (int) chokeFrom->e28.size() ? (double) chokeFrom->e28[(size_t) i] : 0.0;
    });
    vr3 = e.Rsrc("N60", 2.1e6, 15); e.C("N60", "gnd", 10e-6);
    e.R("N60", "B22", 10e3);
    e.NPN("N131", "N60", "gnd");
    e.R("E24", "B29", 33e3);
    rail(e, "P15", 15);
    e.NPN("B29", "P15", "E29"); e.R("E29", "gnd", 33e3);
    Circuit& h = (s2 = &stage({ "IH", "BQ", "CQ", "EQ", "Y", "N66", "B26", "E26", "P15" }), *s2);
    swingHat(*this, h);
    link(h, "Y", 33e3, e, "E29"); link(e, "E29", 33e3, h, "Y");
    part(h, h.C("Y", "N66", 0.0015e-6), "hp"); part(h, h.C("N66", "B26", 0.0015e-6), "hp");
    h.R("N66", "E26", 2.7e3); h.R("B26", "gnd", 68e3);
    rail(h, "P15", 15);
    h.NPN("B26", "P15", "E26"); h.Rsrc("E26", 22e3, -15);
    h.tol = 1e-4;
    Circuit& m = (s3 = &stage({ "IE", "NC", "S", "OUT", "NV" }), *s3);
    link(m, "IE", 1, h, "E26");
    hatMixer(*this, m, 39e3, 470e-12);
    finish(3000, 0.3);
}
void OHCircuit::choke() { if (awake()) chokeHold = jsround(0.01 * sr); }
void OHCircuit::onParam() {
    pitchMetal(pitchMul(p("pitch")), true, spreadExp(p("spread")));
    scale("hp", 1 / spanMul(p("tone"), 2));
    if (!vrL) return;
    vr3->g = 1 / (100e3 + 2e6 * p("decay"));
    vrL->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk);
    s1->touch(); mix->touch();
}

CHCircuit::CHCircuit(double sr_, Shared sh) : CircuitVoice(sr_, { { "level", "Level", 0.8 }, P_PITCH(), P_DECAY(),
        knobSpec("spread", "Spread"), knobSpec("tone", "Tone") }, sh) {
    e28.assign(128, 0.f);
    Circuit& e = (s1 = &stage({ "T8", "B28", "VC", "C28", "E28" }), *s1);
    addTrigger(e, "T8");
    e.R("T8", "gnd", 22e3); e.R("T8", "B28", 33e3);
    e.Rsrc("VC", 100, 15); e.C("VC", "gnd", 47e-6); e.R("VC", "C28", 470);
    e.NPN("B28", "C28", "E28"); part(e, e.C("E28", "gnd", 0.47e-6), "env");
    e.R("E28", "gnd", 330e3);
    Circuit& h = (s2 = &stage({ "IH", "BQ", "CQ", "EQ", "Y", "N72", "B31", "E31", "P15" }), *s2);
    swingHat(*this, h);
    link(h, "Y", 33e3, e, "E28"); link(e, "E28", 33e3, h, "Y");
    part(h, h.C("Y", "N72", 0.001e-6), "hp"); part(h, h.C("N72", "B31", 0.001e-6), "hp");
    h.R("N72", "E31", 2.7e3); h.R("B31", "gnd", 68e3);
    rail(h, "P15", 15);
    h.NPN("B31", "P15", "E31"); h.Rsrc("E31", 22e3, -15);
    h.tol = 1e-4;
    Circuit& m = (s3 = &stage({ "IE", "NC", "S", "OUT", "NV" }), *s3);
    link(m, "IE", 1, h, "E31");
    hatMixer(*this, m, 33e3, 470e-12);
    iE28 = e.idx["E28"];
    finish(3000, 0.3);
}
void CHCircuit::post(int i, int n, bool aw) {
    const float vv = (float) s1->v[(size_t) iE28];
    if (aw) e28[(size_t) i] = vv; else std::fill(e28.begin(), e28.begin() + n, vv);
}
void CHCircuit::onParam() {
    pitchMetal(pitchMul(p("pitch")), true, spreadExp(p("spread"))); scale("env", decayMul(p("decay")));
    scale("hp", 1 / spanMul(p("tone"), 2));
    if (!vrL) return;
    vrL->g = 1 / std::max(1.0, 100e3 * aTaper(p("level")) * dk);
    mix->touch();
}

std::unique_ptr<Voice> makeCircuit(const std::string& id, double sr, Shared sh) {
    if (id == "bd") return std::make_unique<BDCircuit>(sr);
    if (id == "sd") return std::make_unique<SDCircuit>(sr, sh);
    if (id == "lt" || id == "mt" || id == "ht" || id == "lc" || id == "mc" || id == "hc") return std::make_unique<TomCircuit>(sr, sh, id);
    if (id == "rs") return std::make_unique<RSCLCircuit>(sr, sh, true);
    if (id == "cl") return std::make_unique<RSCLCircuit>(sr, sh, false);
    if (id == "cp") return std::make_unique<CPCircuit>(sr, sh);
    if (id == "ma") return std::make_unique<MACircuit>(sr, sh);
    if (id == "cb") return std::make_unique<CBCircuit>(sr, sh);
    if (id == "cy") return std::make_unique<CYCircuit>(sr, sh);
    if (id == "oh") return std::make_unique<OHCircuit>(sr, sh);
    if (id == "ch") return std::make_unique<CHCircuit>(sr, sh);
    return nullptr;
}

} // namespace t8
