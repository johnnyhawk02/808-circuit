// C++ port of dsp/mna.js: the modified-nodal-analysis circuit simulator behind the component-level voices.
// Kept line for line with the JS (same element order, same arithmetic, same quirks) so a voice renders the
// same as it does in the browser. See dsp/mna.js for the commentary.
#pragma once
#include <cmath>
#include <deque>
#include <functional>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

namespace t8 {

constexpr double VT = 0.02585;
constexpr double GMIN = 1e-9;

struct PartModel { double Is, bf, br; };
struct DiodeModel { double Is, n; };
namespace PARTS {
inline constexpr PartModel npn { 2e-14, 250, 3 };
inline constexpr PartModel pnp { 2e-14, 200, 3 };
inline constexpr DiodeModel diode { 2.52e-9, 1.752 };
struct OpAmpModel { double A, ro, vsat, gbw; };
inline constexpr OpAmpModel opamp { 2e4, 75, 13.5, 3e6 };
}

class Circuit;

// Elements. Handles stay valid for the circuit's life (std::deque never moves its elements).
struct Res { int a, b; double g; };
struct Src {
    int a; double g, v; bool on = true;
    std::function<double(int)> get;   // feeds: the value read each sample
    int left = 0;                      // trigger switches: samples left
    Circuit* c = nullptr;
    double g0 = 0;                     // (spare: a voice's stock conductance)
};
struct Cap { int a, b; double c, i = 0, vPrev = 0, geq = 0, ieq = 0; bool be = false; };
struct Diode {
    int a, k; double Is, nvt, vcrit, vd = 0, gd = 1; bool frozen = false;
    double calm = std::numeric_limits<double>::quiet_NaN(); // (undefined in the JS until first reset: ++undefined is NaN)
    int la = -1, lk = -1;
};
struct Bjt {
    int b, c, e; double Is, bf, br; int pol; double vcrit, vbe = 0, vbc = 0, gf = 1, gr = 1; bool frozen = false;
    double calm = std::numeric_limits<double>::quiet_NaN();
    int lb = -1, lc = -1, le = -1;
};
struct OpAmp {
    int p, m, o; double A, g, vsat, wp, dl = 0, f = 0, fp = 0, xPrev = 0, x0 = 0, Ae, a = 1; bool lin = true; int calm = 0;
    int lp = -1, lm = -1, lo = -1;
};
struct Dyn { int a, b; bool fixed; double vb, g = 0, i = 0; int la = -1, lb = -1; };

class Circuit {
public:
    explicit Circuit(const std::vector<std::string>& nodeNames);

    int node(const std::string& name) const;
    double V(const std::string& name) const { int i = node(name); return i < 0 ? 0 : v[(size_t) i]; }
    int idxOf(const std::string& name) const { return node(name); }

    Res* R(const std::string& a, const std::string& b, double ohms);
    Src* Rsrc(const std::string& a, double ohms, double volts);
    Cap* C(const std::string& a, const std::string& b, double farads);
    Diode* D(const std::string& anode, const std::string& cathode, DiodeModel m = PARTS::diode);
    Bjt* NPN(const std::string& b, const std::string& c, const std::string& e, PartModel m = PARTS::npn) { return bjt(b, c, e, m, 1); }
    Bjt* PNP(const std::string& b, const std::string& c, const std::string& e, PartModel m = PARTS::pnp) { return bjt(b, c, e, m, -1); }
    OpAmp* Op(const std::string& plus, const std::string& minus, const std::string& out, PARTS::OpAmpModel m = PARTS::opamp);
    Dyn* DynEl(const std::string& a, const char* b = nullptr, double vb = 0);

    void setTimestep(double d) { dt = d; dirty = true; }
    void touch() { dirty = true; }
    bool step(int maxIter = 30) { return step(maxIter, tol); }
    bool step(int maxIter, double tolerance);
    void settle(int steps = 2000);

    std::vector<std::string> names;
    int n;
    std::unordered_map<std::string, int> idx;
    std::vector<double> v;
    double dt = 0;
    double tol = 1e-5;
    bool freezing = true;
    bool dirty = true, kDirty = false, haveK = false;

    std::deque<Res> res; std::deque<Cap> caps; std::deque<Diode> diodes; std::deque<Bjt> bjts;
    std::deque<OpAmp> opamps; std::deque<Src> srcs; std::deque<Dyn> dyn;
    std::vector<Src*> feeds; // (CircuitVoice: the sources read each sample)

private:
    Bjt* bjt(const std::string& b, const std::string& c, const std::string& e, PartModel m, int pol);
    void buildK();
    void buildBase();
    bool newton(std::vector<double>& rb, int maxIter, double tolerance);
    bool wake();
    void maybeFreeze();
    void stampDyn(std::vector<double>& M, int k);
    void stampNonlinear(std::vector<double>& M, std::vector<double>& rhs, int k);
    void bjtRow(std::vector<double>& M, std::vector<double>& rhs, int k, int r, const Bjt& q, double I0, double a, double b, double vbe, double vbc);
    double linError();
    static void factor(std::vector<double>& M, std::vector<int>& perm, int n);
    static void lusolve(const std::vector<double>& M, const std::vector<int>& perm, int n, const std::vector<double>& b, std::vector<double>& x);
    double vd(int a, int b) const { return (a >= 0 ? v[(size_t) a] : 0) - (b >= 0 ? v[(size_t) b] : 0); }

    std::vector<double> A, base, bBase;
    std::vector<int> perm, permK;
    std::vector<int> K, patIdx, patRow, patCol;
    int k = 0; size_t nDev = 0;
    std::vector<double> Z, Zkk, Nk, rk, Ak, wk, bk, y, e, Gi;
    int itersN = 0;
};

// shared trigger bus (main board accent circuit)
inline double busVoltage(double accent) {
    const double vbe = 0.66, a = std::max(0.0, std::min(1.0, accent));
    return (a > 0 ? std::max(5.1, 5 + 10 * a) : 5.1) - vbe;
}
constexpr double TRIG_WIDTH = 1e-3;

} // namespace t8
