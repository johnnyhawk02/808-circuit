#include "PluginEditor.h"
#include "Assets.h"

namespace t8 {

static std::vector<std::byte> bytes(const void* d, size_t n) {
    std::vector<std::byte> v(n); if (n) std::memcpy(v.data(), d, n); return v;
}

class Editor::Browser : public juce::WebBrowserComponent {
public:
    Browser(Processor& p, const Options& o) : juce::WebBrowserComponent(o), proc(p) {}
    // (any page load: the app isn't listening until its boot says so)
    bool pageAboutToLoad(const juce::String& url) override {
        juce::ignoreUnused(url);
        proc.pageReady(false);
        return true;
    }
    // links that open a new window: the app's own pages here, the web in the default browser
    void newWindowAttemptingToLoad(const juce::String& url) override {
        if (url.startsWith(getResourceProviderRoot())) goToURL(url);
        else juce::URL(url).launchInDefaultBrowser();
    }
private:
    Processor& proc;
};

Editor::Editor(Processor& p) : AudioProcessorEditor(p), proc(p) {
    using Opt = juce::WebBrowserComponent::Options;
    auto provider = [this](const juce::String& url) -> std::optional<juce::WebBrowserComponent::Resource> {
        const juce::String path = url.upToFirstOccurrenceOf("?", false, false).trimCharactersAtStart("/");
        if (path.isEmpty() || path == "index.html") {
            const juce::String html = proc.pageHtml();
            // (with a byte order mark: WebKitGTK's custom scheme responses don't carry the charset)
            std::string utf8 = "\xEF\xBB\xBF"; utf8 += html.toStdString();
            return juce::WebBrowserComponent::Resource { bytes(utf8.data(), utf8.size()), "text/html; charset=utf-8" };
        }
        if (path == "sw.js") return std::nullopt;
        auto mb = readAsset(path);
        if (!mb) return std::nullopt;
        if (path.endsWith(".html")) mb->insert("\xEF\xBB\xBF", 3, 0);
        return juce::WebBrowserComponent::Resource { bytes(mb->getData(), mb->getSize()), mimeFor(path) };
    };
    auto opts = Opt {}
        .withBackend(Opt::Backend::webview2)
        .withWinWebView2Options(Opt::WinWebView2 {}
            .withUserDataFolder(juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("808 Circuit WebView2"))
            .withBackgroundColour(juce::Colour(0xff15161a)))
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider(provider)
        .withEventListener("t8", [this](const juce::var& v) { proc.pageMessage(v.toString()); })
        .withEventListener("t8store", [this](const juce::var& v) { proc.pageStore(v); })
        .withEventListener("t8idb", [this](const juce::var& v) { proc.pageIdb(v.toString()); })
        .withEventListener("t8session", [this](const juce::var& v) { proc.pageSession(v.toString()); })
        .withEventListener("t8save", [this](const juce::var& v) { save(v); })
        .withEventListener("t8log", [](const juce::var& v) { if (std::getenv("T8_DEBUG")) std::fprintf(stderr, "page: %s\n", v.toString().toRawUTF8()); })
        .withEventListener("t8ready", [this](const juce::var&) { proc.pageReady(true); });
    web = std::make_unique<Browser>(proc, opts);
    addAndMakeVisible(*web);
    proc.attachEditor(this);
    setResizable(true, true);
    setResizeLimits(720, 480, 4000, 3000);
    setSize(1280, 760);
    web->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
}
Editor::~Editor() {
    proc.attachEditor(nullptr);
    proc.pageReady(false);
}
void Editor::resized() { web->setBounds(getLocalBounds()); }

void Editor::emit(const juce::String& json) { web->emitEventIfBrowserIsVisible("t8ev", juce::var(json)); }
void Editor::reload() {
    proc.pageReady(false);
    web->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
}

// a file the page would download (a recording, a kit, the favourites): saved where the user picks
void Editor::save(const juce::var& file) {
    const juce::String name = file["name"].toString().isNotEmpty() ? file["name"].toString() : juce::String("808 Circuit file");
    auto data = std::make_shared<juce::MemoryBlock>();
    { juce::MemoryOutputStream out(*data, false); juce::Base64::convertFromBase64(out, file["b64"].toString()); }
    const juce::File start = juce::File::getSpecialLocation(juce::File::userMusicDirectory).getChildFile(name);
    chooser = std::make_unique<juce::FileChooser>("Save " + name, start);
    chooser->launchAsync(juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles | juce::FileBrowserComponent::warnAboutOverwriting,
        [data](const juce::FileChooser& fc) {
            const juce::File f = fc.getResult();
            if (f != juce::File()) f.replaceWithData(data->getData(), data->getSize());
        });
}

} // namespace t8
