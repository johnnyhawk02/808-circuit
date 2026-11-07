// A small JSON value (objects keep their key order, as JS objects do) and parser, for the page's messages to the player.
#pragma once
#include <string>
#include <vector>
#include <memory>
#include <utility>
#include <cmath>

namespace t8 {

class Json {
public:
    enum Kind { Null, Bool, Number, String, Array, Object };
    Json() = default;
    Json(double v) : k(Number), n(v) {}
    Json(bool v) : k(Bool), b(v) {}
    Json(const char* s) : k(String), s(s) {}
    Json(std::string v) : k(String), s(std::move(v)) {}
    static Json array() { Json j; j.k = Array; return j; }
    static Json object() { Json j; j.k = Object; return j; }
    static Json parse(const std::string& text, bool* ok = nullptr);
    std::string dump() const;

    Kind kind() const { return k; }
    bool isNull() const { return k == Null; }
    bool isNumber() const { return k == Number; }
    bool isString() const { return k == String; }
    bool isArray() const { return k == Array; }
    bool isObject() const { return k == Object; }
    // JS truthiness
    bool truthy() const {
        switch (k) { case Null: return false; case Bool: return b; case Number: return n != 0 && n == n; case String: return !s.empty(); default: return true; }
    }
    double num(double dflt = 0) const { return k == Number ? n : k == Bool ? (b ? 1 : 0) : dflt; }
    const std::string& str() const { return s; }
    size_t size() const { return k == Array ? a.size() : k == Object ? o.size() : 0; }
    const Json& operator[](size_t i) const { static const Json none; return k == Array && i < a.size() ? a[i] : none; }
    const Json& operator[](const char* key) const { static const Json none; if (k == Object) for (auto& kv : o) if (kv.first == key) return kv.second; return none; }
    bool has(const char* key) const { if (k == Object) for (auto& kv : o) if (kv.first == key) return true; return false; }
    // (a key that is there but undefined in JS can't come through JSON: present means defined)
    const std::vector<Json>& items() const { return a; }
    const std::vector<std::pair<std::string, Json>>& entries() const { return o; }
    // mutable access to a key (added as null if missing)
    Json& at(const std::string& key) {
        if (k != Object) { k = Object; o.clear(); }
        for (auto& kv : o) if (kv.first == key) return kv.second;
        o.emplace_back(key, Json()); return o.back().second;
    }
    void erase(const std::string& key) { if (k == Object) for (size_t i = 0; i < o.size(); i++) if (o[i].first == key) { o.erase(o.begin() + (long) i); return; } }
    void push(Json v) { if (k != Array) { k = Array; a.clear(); } a.push_back(std::move(v)); }
    void set(const std::string& key, Json v) {
        if (k != Object) { k = Object; o.clear(); }
        for (auto& kv : o) if (kv.first == key) { kv.second = std::move(v); return; }
        o.emplace_back(key, std::move(v));
    }
    // binary data prepared off the audio thread (an 808 voice's cached hits, the reverb's spectra), carried along
    std::shared_ptr<const void> blob;
private:
    Kind k = Null; bool b = false; double n = 0; std::string s;
    std::vector<Json> a; std::vector<std::pair<std::string, Json>> o;
};

} // namespace t8
