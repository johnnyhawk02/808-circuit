#include "Assets.h"
#include <mutex>

namespace t8 {

juce::File appDir() {
    static const juce::File dir = [] {
        const juce::File exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
        // a bundle: Contents/<MacOS | x86_64-win | x86_64-linux ...>/binary -> Contents/Resources/app; a plain executable
        // (the standalone on Linux and Windows): Resources/app beside it
        const juce::File candidates[] = {
            exe.getParentDirectory().getParentDirectory().getChildFile("Resources/app"),
            exe.getParentDirectory().getChildFile("Resources/app"),
            exe.getChildFile("Contents/Resources/app"),
        };
        for (auto& c : candidates) if (c.getChildFile("index.html").existsAsFile()) return c;
        return candidates[0];
    }();
    return dir;
}

std::optional<juce::MemoryBlock> readAsset(const juce::String& pathIn) {
    juce::String path = pathIn.upToFirstOccurrenceOf("?", false, false).upToFirstOccurrenceOf("#", false, false);
    path = juce::URL::removeEscapeChars(path).trimCharactersAtStart("/");
    if (path.isEmpty()) path = "index.html";
    if (path.contains("..")) return std::nullopt;
    const juce::File f = appDir().getChildFile(path);
    if (!f.existsAsFile() || !f.isAChildOf(appDir())) return std::nullopt;
    juce::MemoryBlock mb;
    if (!f.loadFileAsData(mb)) return std::nullopt;
    return mb;
}

juce::String mimeFor(const juce::String& path) {
    const auto ext = path.fromLastOccurrenceOf(".", false, false).toLowerCase();
    if (ext == "html") return "text/html; charset=utf-8";
    if (ext == "js" || ext == "mjs") return "text/javascript; charset=utf-8";
    if (ext == "json" || ext == "webmanifest") return "application/json";
    if (ext == "css") return "text/css";
    if (ext == "wav") return "audio/wav";
    if (ext == "png") return "image/png";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "md" || ext == "txt") return "text/plain";
    return "application/octet-stream";
}

std::vector<int16_t> wavPcm16(const void* data, size_t bytes) {
    const uint8_t* b = (const uint8_t*) data;
    auto u32 = [&](size_t p) { return (uint32_t) b[p] | (uint32_t) b[p + 1] << 8 | (uint32_t) b[p + 2] << 16 | (uint32_t) b[p + 3] << 24; };
    size_t p = 12;
    while (p + 8 <= bytes) {
        const uint32_t len = u32(p + 4);
        if (std::memcmp(b + p, "data", 4) == 0) {
            const size_t n = std::min<size_t>(len, bytes - (p + 8)) / 2;
            std::vector<int16_t> out(n);
            for (size_t i = 0; i < n; i++) out[i] = (int16_t) (uint16_t) (b[p + 8 + 2 * i] | b[p + 9 + 2 * i] << 8);
            return out;
        }
        p += 8 + len + (len & 1);
    }
    return {};
}

const Shipped& shipped() {
    static std::once_flag once; static Shipped s;
    std::call_once(once, [] {
        auto idx = readAsset("bench/cache/index.json");
        if (!idx) return;
        s.index = Json::parse(idx->toString().toStdString());
        for (int i = 0; i < 16; i++) {
            const Json& info = s.index[VOICE_IDS[i]];
            if (!info.isObject()) continue;
            s.infoKey[(size_t) i] = info.dump();
            auto wav = readAsset(juce::String("bench/cache/") + VOICE_IDS[i] + ".wav");
            if (!wav) continue;
            const auto pcm = wavPcm16(wav->getData(), wav->getSize());
            s.pcmBytes[(size_t) i] = pcm.size() * 2;
            s.data[(size_t) i] = CacheData::build(CacheInfo::fromJson(info), pcm.data(), pcm.size());
        }
    });
    return s;
}

std::vector<uint8_t> bytesOf(const Json& t) {
    juce::MemoryOutputStream out;
    if (!t["__b64"].isString() || !juce::Base64::convertFromBase64(out, juce::String(t["__b64"].str()))) return {};
    const uint8_t* d = (const uint8_t*) out.getData();
    return std::vector<uint8_t>(d, d + out.getDataSize());
}
Json tagged(const void* data, size_t bytes, const char* type) {
    Json j = Json::object();
    j.set("__b64", juce::Base64::toBase64(data, bytes).toStdString());
    j.set("t", type);
    return j;
}

} // namespace t8
