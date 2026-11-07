#include "Json.h"
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <charconv>
#include <sstream>
#include <locale>

namespace t8 {

namespace {
struct Parser {
    const char* p; const char* e; bool ok = true;
    void ws() { while (p < e && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) p++; }
    bool lit(const char* w) { const size_t n = std::strlen(w); if ((size_t) (e - p) >= n && std::memcmp(p, w, n) == 0) { p += n; return true; } return false; }
    static void utf8(std::string& out, unsigned c) {
        if (c < 0x80) out += (char) c;
        else if (c < 0x800) { out += (char) (0xc0 | (c >> 6)); out += (char) (0x80 | (c & 0x3f)); }
        else if (c < 0x10000) { out += (char) (0xe0 | (c >> 12)); out += (char) (0x80 | ((c >> 6) & 0x3f)); out += (char) (0x80 | (c & 0x3f)); }
        else { out += (char) (0xf0 | (c >> 18)); out += (char) (0x80 | ((c >> 12) & 0x3f)); out += (char) (0x80 | ((c >> 6) & 0x3f)); out += (char) (0x80 | (c & 0x3f)); }
    }
    unsigned hex4() {
        unsigned v = 0;
        for (int i = 0; i < 4; i++) {
            if (p >= e) { ok = false; return 0; }
            const char c = *p++; v <<= 4;
            if (c >= '0' && c <= '9') v |= (unsigned) (c - '0'); else if (c >= 'a' && c <= 'f') v |= (unsigned) (c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= (unsigned) (c - 'A' + 10); else { ok = false; return 0; }
        }
        return v;
    }
    std::string string() {
        std::string out; p++; // (the opening quote)
        while (p < e && *p != '"') {
            char c = *p++;
            if (c != '\\') { out += c; continue; }
            if (p >= e) { ok = false; break; }
            c = *p++;
            switch (c) {
                case 'n': out += '\n'; break; case 't': out += '\t'; break; case 'r': out += '\r'; break;
                case 'b': out += '\b'; break; case 'f': out += '\f'; break;
                case 'u': {
                    unsigned u = hex4();
                    if (u >= 0xd800 && u < 0xdc00 && p + 1 < e && p[0] == '\\' && p[1] == 'u') { p += 2; const unsigned lo = hex4(); u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00); }
                    utf8(out, u); break;
                }
                default: out += c;
            }
        }
        if (p < e) p++; else ok = false;
        return out;
    }
    Json value(int depth) {
        ws();
        if (p >= e || depth > 200) { ok = false; return {}; }
        const char c = *p;
        if (c == '{') {
            p++; Json o = Json::object(); ws();
            if (p < e && *p == '}') { p++; return o; }
            while (ok) {
                ws(); if (p >= e || *p != '"') { ok = false; break; }
                std::string key = string(); ws();
                if (p >= e || *p != ':') { ok = false; break; }
                p++; o.set(key, value(depth + 1)); ws();
                if (p < e && *p == ',') { p++; continue; }
                if (p < e && *p == '}') { p++; break; }
                ok = false;
            }
            return o;
        }
        if (c == '[') {
            p++; Json a = Json::array(); ws();
            if (p < e && *p == ']') { p++; return a; }
            while (ok) {
                a.push(value(depth + 1)); ws();
                if (p < e && *p == ',') { p++; continue; }
                if (p < e && *p == ']') { p++; break; }
                ok = false;
            }
            return a;
        }
        if (c == '"') return Json(string());
        if (lit("true")) return Json(true);
        if (lit("false")) return Json(false);
        if (lit("null")) return {};
        // (locale-independent: a host's locale may use a decimal comma)
        const char* q = p;
        if (q < e && (*q == '-' || *q == '+')) q++;
        while (q < e && ((*q >= '0' && *q <= '9') || *q == '.' || *q == 'e' || *q == 'E' || *q == '-' || *q == '+')) q++;
        double v = 0;
#if defined(__cpp_lib_to_chars) && __cpp_lib_to_chars >= 201611L
        const char* s0 = *p == '+' ? p + 1 : p;
        auto r = std::from_chars(s0, q, v);
        if (r.ec != std::errc() || r.ptr == s0) { ok = false; return {}; }
        p = r.ptr;
#else
        std::istringstream is(std::string(p, q)); is.imbue(std::locale::classic());
        if (!(is >> v)) { ok = false; return {}; }
        p = q;
#endif
        return Json(v);
    }
};
void dumpTo(const Json& j, std::string& out) {
    switch (j.kind()) {
        case Json::Null: out += "null"; break;
        case Json::Bool: out += j.truthy() ? "true" : "false"; break;
        case Json::Number: {
            const double v = j.num();
            if (!std::isfinite(v)) { out += "null"; break; }
            char buf[32];
            if (v == std::floor(v) && std::abs(v) < 1e15) std::snprintf(buf, sizeof buf, "%.0f", v);
            else std::snprintf(buf, sizeof buf, "%.17g", v);
            for (char* c = buf; *c; c++) if (*c == ',') *c = '.'; // (a decimal comma, from the host's locale)
            out += buf; break;
        }
        case Json::String: {
            out += '"';
            for (const char c : j.str()) {
                switch (c) {
                    case '"': out += "\\\""; break; case '\\': out += "\\\\"; break; case '\n': out += "\\n"; break;
                    case '\r': out += "\\r"; break; case '\t': out += "\\t"; break;
                    default: if ((unsigned char) c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; } else out += c;
                }
            }
            out += '"'; break;
        }
        case Json::Array: { out += '['; bool first = true; for (auto& x : j.items()) { if (!first) out += ','; first = false; dumpTo(x, out); } out += ']'; break; }
        case Json::Object: {
            out += '{'; bool first = true;
            for (auto& kv : j.entries()) { if (!first) out += ','; first = false; dumpTo(Json(kv.first), out); out += ':'; dumpTo(kv.second, out); }
            out += '}'; break;
        }
    }
}
} // namespace

Json Json::parse(const std::string& text, bool* ok) {
    Parser ps { text.data(), text.data() + text.size() };
    Json j = ps.value(0);
    if (ok) *ok = ps.ok;
    return j;
}
std::string Json::dump() const { std::string out; dumpTo(*this, out); return out; }

} // namespace t8
