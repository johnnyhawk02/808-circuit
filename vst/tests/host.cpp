// A test host (Linux, under Xvfb): the plugin with its editor, its audio pulled in real time by a timer, the host's
// transport playing at 128 bpm from beat 0 for a while, then stopped; MIDI note C0+2 (pattern 3) in the middle. Writes
// the output to a wav and the state to a file, then loads that state into a second instance and renders it without
// an editor.
//   host <out.wav> <seconds>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_gui_extra/juce_gui_extra.h>

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

struct Head : juce::AudioPlayHead {
    bool playing = false; double bpm = 128, ppq = 0;
    juce::Optional<PositionInfo> getPosition() const override {
        PositionInfo p; p.setBpm(bpm); p.setIsPlaying(playing); p.setPpqPosition(ppq); p.setTimeSignature(TimeSignature {}); return p;
    }
};

struct App : juce::JUCEApplication, juce::HighResolutionTimer {
    const juce::String getApplicationName() override { return "t8host"; }
    const juce::String getApplicationVersion() override { return "1"; }
    std::unique_ptr<juce::AudioProcessor> proc;
    std::unique_ptr<juce::DocumentWindow> win;
    Head head; double sr = 48000; int block = 512; int64_t pos = 0; int64_t total = 0;
    juce::AudioBuffer<float> out;
    std::atomic<bool> finished { false };
    juce::CriticalSection cs;
    juce::MidiBuffer pendingMidi;

    void initialise(const juce::String& cmd) override {
        auto args = juce::StringArray::fromTokens(cmd, true);
        if (args[0] == "--editor") {
            // host --editor <state>: an instance from the state, with its editor (the page's own restore), stopped
            juce::MemoryBlock st; juce::File(args[1]).loadFileAsData(st);
            proc.reset(createPluginFilter()); proc->setPlayHead(&head);
            proc->setPlayConfigDetails(0, 2, sr, block); proc->prepareToPlay(sr, block);
            proc->setStateInformation(st.getData(), (int) st.getSize());
            win = std::make_unique<juce::DocumentWindow>("t8host", juce::Colours::black, 0);
            win->setContentOwned(proc->createEditor(), true);
            win->setVisible(true);
            const juce::File back = juce::File(args[1]).withFileExtension(".back.state");
            juce::Timer::callAfterDelay(10000, [this, back] { juce::MemoryBlock b; proc->getStateInformation(b); back.replaceWithData(b.getData(), b.getSize()); win = nullptr; proc = nullptr; quit(); });
            return;
        }
        if (args[0] == "--restore") {
            // host --restore <state> <out.wav>: only the second half
            juce::MemoryBlock st; juce::File(args[1]).loadFileAsData(st);
            restore(st, juce::File(args[2]));
            quit(); return;
        }
        total = (int64_t) (sr * (args.size() > 1 ? args[1].getDoubleValue() : 12));
        out.setSize(2, (int) total + block);
        proc.reset(createPluginFilter());
        proc->setPlayHead(&head);
        proc->setPlayConfigDetails(0, 2, sr, block);
        proc->prepareToPlay(sr, block);
        win = std::make_unique<juce::DocumentWindow>("t8host", juce::Colours::black, 0);
        win->setContentOwned(proc->createEditor(), true);
        win->setVisible(true);
        // (the page boots first)
        juce::Timer::callAfterDelay(6000, [this] { startTimer(5); });
    }
    void hiResTimerCallback() override {
        const juce::ScopedLock sl(cs);
        // keep up with real time
        static const double t0 = juce::Time::getMillisecondCounterHiRes();
        const double now = juce::Time::getMillisecondCounterHiRes() - t0;
        while (pos < total && pos < (int64_t) (now * sr / 1000)) {
            const double t = pos / sr;
            head.playing = t > 1 && t < total / sr - 2;
            juce::AudioBuffer<float> b(2, block); juce::MidiBuffer mb;
            if (t >= 5 && t < 5 + block / sr) mb.addEvent(juce::MidiMessage::noteOn(10, 26, (juce::uint8) 100), 0);
            proc->processBlock(b, mb);
            for (int c = 0; c < 2; c++) out.copyFrom(c, (int) pos, b, c, 0, block);
            if (head.playing) head.ppq += block / sr * head.bpm / 60;
            pos += block;
        }
        if (pos >= total && !finished.exchange(true)) juce::MessageManager::callAsync([this] { finish(); });
    }
    void finish() {
        stopTimer();
        auto args = juce::StringArray::fromTokens(getCommandLineParameters(), true);
        write(juce::File(args[0]), out);
        juce::MemoryBlock st; proc->getStateInformation(st);
        juce::File(args[0]).withFileExtension(".state").replaceWithData(st.getData(), st.getSize());
        std::printf("state: %d bytes\n", (int) st.getSize());
        restore(st, juce::File(args[0]).withFileExtension(".restored.wav"));
        win = nullptr; proc = nullptr;
        quit();
    }
    void restore(const juce::MemoryBlock& st, const juce::File& to) {
        // a second instance from the state, no editor: the transport playing
        std::unique_ptr<juce::AudioProcessor> p2(createPluginFilter());
        Head h2; h2.playing = true; p2->setPlayHead(&h2);
        p2->setPlayConfigDetails(0, 2, sr, block); p2->prepareToPlay(sr, block);
        p2->setStateInformation(st.getData(), (int) st.getSize());
        juce::AudioBuffer<float> o2(2, (int) (sr * 4) + block); o2.clear();
        for (int64_t q = 0; q < (int64_t) (sr * 4); q += block) {
            juce::AudioBuffer<float> b(2, block); juce::MidiBuffer mb;
            p2->processBlock(b, mb);
            if (std::getenv("T8_DEBUG") && q / block % 20 == 0) std::printf("block %d peak %g\n", (int) (q / block), b.getMagnitude(0, block));
            for (int c = 0; c < 2; c++) o2.copyFrom(c, (int) q, b, c, 0, block);
            h2.ppq += block / sr * h2.bpm / 60;
        }
        write(to, o2);
    }
    void write(const juce::File& f, const juce::AudioBuffer<float>& b) {
        f.deleteFile();
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatWriter> w(wav.createWriterFor(new juce::FileOutputStream(f), sr, 2, 24, {}, 0));
        w->writeFromAudioSampleBuffer(b, 0, b.getNumSamples());
        std::printf("%s: peak %.3f\n", f.getFileName().toRawUTF8(), b.getMagnitude(0, b.getNumSamples()));
    }
    void shutdown() override {}
};
START_JUCE_APPLICATION(App)
