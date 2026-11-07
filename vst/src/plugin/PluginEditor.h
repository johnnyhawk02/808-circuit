// The editor: the app's own page (elixir/index.html) in a web view, served from Resources/app with this instance's
// storage and the bridge (ui/shim.js, ui/boot.js) put into it. The page talks to the processor through JUCE's native
// integration: events t8 (messages for the player), t8store / t8idb (its localStorage and IndexedDB), t8session (its
// state, as a preset), t8save (a file it would download), t8ready; and hears the player's events as t8ev.
#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

namespace t8 {

class Editor : public juce::AudioProcessorEditor {
public:
    explicit Editor(Processor&);
    ~Editor() override;
    void resized() override;
    void paint(juce::Graphics& g) override { g.fillAll(juce::Colour(0xff15161a)); }

    void emit(const juce::String& json);   // the player's events, to the page
    void reload();                         // (a restored project: the page again, with its state)

private:
    class Browser;
    void save(const juce::var& file);
    Processor& proc;
    std::unique_ptr<Browser> web;
    std::unique_ptr<juce::FileChooser> chooser;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Editor)
};

} // namespace t8
