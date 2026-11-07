// The files the plugin ships beside its binary (Resources/app: the page, its IRs, the shipped cached hits, the bridge
// scripts), the shipped hits decoded once per process, and the bridge's binary encoding.
#pragma once
#include <juce_core/juce_core.h>
#include "dsp/Kit.h"
#include "dsp/Json.h"

namespace t8 {

juce::File appDir();                                   // Resources/app
std::optional<juce::MemoryBlock> readAsset(const juce::String& path); // a path under it ("/irs/plate.wav")
juce::String mimeFor(const juce::String& path);

// the shipped cached hits (bench/cache/): index.json's entries and the hits, by voice
struct Shipped {
    Json index;                                        // index.json as parsed
    std::array<std::shared_ptr<const CacheData>, 16> data;
    std::array<size_t, 16> pcmBytes {};                  // each hit file's PCM size in bytes
    std::array<std::string, 16> infoKey;               // each entry's JSON (to tell shipped hits from made ones)
};
const Shipped& shipped();

// the bridge's binary values: { "__b64": "...", "t": "ArrayBuffer" | "Int16Array" | "Float32Array" | ... }
std::vector<uint8_t> bytesOf(const Json& tagged);
Json tagged(const void* data, size_t bytes, const char* type);
std::vector<int16_t> wavPcm16(const void* data, size_t bytes); // the data chunk of a 16-bit wav (readWav)

} // namespace t8
