// The plugin: the C++ player (src/dsp) makes the sound; the app's own page (in the editor's web view) is the UI and sends
// the player the same messages it sends its AudioWorklet in the browser. The processor keeps what the page keeps in the
// browser (its localStorage and IndexedDB, here per plugin instance and saved with the project), the latest of each
// message (so the sound plays and is restored with the editor closed), follows the host's transport and tempo, and
// takes MIDI: C0 up to G0 pick the grid's patterns 1 to 8, the General MIDI drum notes play the tracks.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "dsp/Player.h"
#include <atomic>
#include <map>

namespace t8 {

// single producer, single consumer, of pointers
template <class T> class Spsc {
public:
    explicit Spsc(size_t n) : buf(n) {}
    bool push(T* p) { const size_t h = head.load(std::memory_order_relaxed), nx = (h + 1) % buf.size(); if (nx == tail.load(std::memory_order_acquire)) return false; buf[h] = p; head.store(nx, std::memory_order_release); return true; }
    T* pop() { const size_t t = tail.load(std::memory_order_relaxed); if (t == head.load(std::memory_order_acquire)) return nullptr; T* p = buf[t]; tail.store((t + 1) % buf.size(), std::memory_order_release); return p; }
private:
    std::vector<T*> buf; std::atomic<size_t> head { 0 }, tail { 0 };
};

class Editor;

class Processor : public juce::AudioProcessor, private juce::Timer {
public:
    Processor();
    ~Processor() override;

    void prepareToPlay(double sampleRate, int) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return "808 Circuit"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 2; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;

    // ---- the page (message thread) ----
    juce::String pageHtml();                       // index.html with this instance's storage and the bridge scripts in it
    void pageMessage(const juce::String& json);    // a message for the player
    void pageStore(const juce::var& change);       // localStorage: { k, v } (v null: removed) or { clear: true }
    void pageIdb(const juce::String& json);        // IndexedDB: { op: put | delete | clear, db, store, key, value }
    void pageSession(const juce::String& json);    // the page's whole state, as a preset
    void pageReady(bool ready);
    void attachEditor(Editor* e) { editor = e; }

private:
    void timerCallback() override;
    void preprocess(Json& m);                      // blobs: the hits' PCM and the reverb's IR, decoded and prepared
    void record(const Json& m);                    // the latest of each message, for a player made without the page
    std::vector<Json> replayList();                // those messages in order
    std::unique_ptr<Player> freshPlayer(bool withSnapshot);
    void send(Json m);                             // to the audio thread
    void hostSync();
    void locateTo(double ppq);
    void midi(const juce::MidiBuffer&);
    void audioMsg(const Json& m);                  // the audio thread's handling of one message (host overrides, then the player)
    void rebuildPatterns();
    void flushGlobal();
    void emitEvent(Json ev);                       // audio thread: an event for the page
    bool isPerInstanceKey(const std::string& k) const;

    // audio thread
    std::unique_ptr<Player> player;
    std::atomic<Player*> pendingPlayer { nullptr };
    Spsc<Json> toAudio { 32768 }, toMessage { 32768 }, trash { 32768 };
    Spsc<Player> playerTrash { 16 };
    Json lastSeq;                                  // the page's latest seq (its own transport state)
    bool hostPlaying = false; double hostBpm = 0; bool hasHost = false;
    double outRate = 48000;
    std::vector<float> scratchL, scratchR;

    // patterns for MIDI pattern switching: the grid's eight, as lanes808 messages
    std::shared_ptr<const std::vector<Json>> patterns;

    // message thread
    juce::CriticalSection lock;                    // (the state below; a host may save from another thread)
    std::map<std::string, std::string> store;      // this instance's localStorage
    bool storeSeeded = false;
    Json idb = Json::object();                     // this instance's IndexedDB: { db: { store: { key: value } } }
    std::string session;                           // the page's state, as a preset (JSON)
    std::map<std::string, Json> snapshot;          // the latest message of each kind, keyed in replay order
    std::map<std::string, std::optional<std::string>> globalPending; // (nullopt: removed)
    int globalDirty = 0;
    Editor* editor = nullptr;
    std::atomic<bool> ready { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Processor)
};

} // namespace t8
