# 808 Circuit as a plugin (VST3, AU on macOS, and a standalone app): the web app's own page as the UI, the player
# ported to C++ (src/dsp) as the sound. Build:
#   cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release
# JUCE is fetched (8.0.10, with patches/) unless -DJUCE_DIR=/path/to/JUCE is given.
cmake_minimum_required(VERSION 3.22)
project(EIGHT_O_EIGHT_CIRCUIT VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(APPLE)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
  if(NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "" FORCE)
  endif()
endif()

set(JUCE_DIR "" CACHE PATH "a JUCE checkout (empty: fetch it)")
if(JUCE_DIR)
  add_subdirectory(${JUCE_DIR} juce)
else()
  include(FetchContent)
  # (patched: on Linux, JUCE's web view runs in a child process and big messages to it, such as this page, got cut up)
  FetchContent_Declare(juce GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.10 GIT_SHALLOW TRUE
    PATCH_COMMAND ${CMAKE_COMMAND} -DPATCH=${CMAKE_CURRENT_SOURCE_DIR}/patches/juce-linux-webview-ipc.patch -P ${CMAKE_CURRENT_SOURCE_DIR}/patches/apply.cmake)
  FetchContent_MakeAvailable(juce)
endif()

set(T8_FORMATS VST3 Standalone)
if(APPLE)
  list(APPEND T8_FORMATS AU)
endif()

juce_add_plugin(EightOEightCircuit
  PRODUCT_NAME "808 Circuit"
  COMPANY_NAME "Johnny Hawk"
  BUNDLE_ID org.johnnyhawk.808circuit
  PLUGIN_MANUFACTURER_CODE Jhwk
  PLUGIN_CODE E8c1
  FORMATS ${T8_FORMATS}
  IS_SYNTH TRUE
  NEEDS_MIDI_INPUT TRUE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  NEEDS_WEB_BROWSER TRUE
  VST3_CATEGORIES Instrument Drum
  AU_MAIN_TYPE kAudioUnitType_MusicDevice
  COPY_PLUGIN_AFTER_BUILD FALSE)

# the sound: compiled without contracting a*b+c into fused multiply-adds (and never fast-math), so its arithmetic is the
# JavaScript's, operation for operation
set(T8_DSP
  src/dsp/Mna.cpp src/dsp/VoicesCircuit.cpp src/dsp/Kit.cpp src/dsp/Lxr.cpp src/dsp/IrVerb.cpp src/dsp/Player.cpp src/dsp/Json.cpp)
if(MSVC)
  set_source_files_properties(${T8_DSP} PROPERTIES COMPILE_OPTIONS "/fp:precise")
else()
  set_source_files_properties(${T8_DSP} PROPERTIES COMPILE_OPTIONS "-ffp-contract=off;-fno-fast-math")
endif()

target_sources(EightOEightCircuit PRIVATE
  ${T8_DSP}
  src/plugin/Assets.cpp src/plugin/PluginProcessor.cpp src/plugin/PluginEditor.cpp)
target_include_directories(EightOEightCircuit PRIVATE src)

target_compile_definitions(EightOEightCircuit PUBLIC
  JUCE_WEB_BROWSER=1
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0
  JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
  JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(EightOEightCircuit
  PRIVATE juce::juce_audio_utils juce::juce_gui_extra
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_lto_flags juce::juce_recommended_warning_flags)

# ---- the page and what it loads, beside the binary in each bundle's Resources/app ----
#   index.html (the built app, elixir/index.html), help.html, icons/, irs/ (the reverb's IRs), bench/cache/ (the shipped
#   cached hits), and ui/ (the bridge scripts injected into the page)
set(T8_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(T8_STAGE ${CMAKE_CURRENT_BINARY_DIR}/app)
file(GLOB T8_CACHE ${T8_ROOT}/cache/*.wav)
add_custom_target(T8Resources
  COMMAND ${CMAKE_COMMAND} -E make_directory ${T8_STAGE}/bench/cache ${T8_STAGE}/irs ${T8_STAGE}/ui
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${T8_ROOT}/elixir/index.html ${T8_ROOT}/elixir/help.html ${T8_STAGE}/
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${T8_ROOT}/elixir/icons ${T8_STAGE}/icons
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${T8_ROOT}/elixir/irs ${T8_STAGE}/irs
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${T8_CACHE} ${T8_ROOT}/cache/index.json ${T8_STAGE}/bench/cache/
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/ui ${T8_STAGE}/ui
  VERBATIM)

foreach(fmt ${T8_FORMATS})
  set(tgt EightOEightCircuit_${fmt})
  if(NOT TARGET ${tgt})
    continue()
  endif()
  add_dependencies(${tgt} T8Resources)
  if(fmt STREQUAL "Standalone" AND NOT APPLE)
    # (a plain executable here: its resources sit beside it)
    set(res "$<TARGET_FILE_DIR:${tgt}>/Resources/app")
  else()
    # (a bundle: the binary is in Contents/<MacOS | x86_64-linux | x86_64-win>)
    set(res "$<TARGET_FILE_DIR:${tgt}>/../Resources/app")
  endif()
  add_custom_command(TARGET ${tgt} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${res}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${T8_STAGE} "${res}"
    VERBATIM)
  if(APPLE)
    # (the resources went in after the linker signed the bundle, which breaks its seal and hosts such as Live refuse
    # it: sign it again, ad hoc, with them in)
    add_custom_command(TARGET ${tgt} POST_BUILD
      COMMAND codesign --force --deep --sign - "$<TARGET_FILE_DIR:${tgt}>/../.."
      VERBATIM)
  endif()
endforeach()

# macOS: install the built plugins for the user (cmake --build build --target T8Install)
if(APPLE)
  # (the VST3 in a Johnny Hawk folder; Audio Units must sit at the top of Components)
  set(T8_VST3_DIR "$ENV{HOME}/Library/Audio/Plug-Ins/VST3/Johnny Hawk")
  add_custom_target(T8Install
    COMMAND ${CMAKE_COMMAND} -E make_directory "${T8_VST3_DIR}" "$ENV{HOME}/Library/Audio/Plug-Ins/Components"
    COMMAND ${CMAKE_COMMAND} -E rm -rf "$ENV{HOME}/Library/Audio/Plug-Ins/VST3/808 Circuit.vst3" "${T8_VST3_DIR}/808 Circuit.vst3" "$ENV{HOME}/Library/Audio/Plug-Ins/Components/808 Circuit.component"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "$<GENEX_EVAL:$<TARGET_PROPERTY:EightOEightCircuit_VST3,JUCE_PLUGIN_ARTEFACT_FILE>>" "${T8_VST3_DIR}/808 Circuit.vst3"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "$<GENEX_EVAL:$<TARGET_PROPERTY:EightOEightCircuit_AU,JUCE_PLUGIN_ARTEFACT_FILE>>" "$ENV{HOME}/Library/Audio/Plug-Ins/Components/808 Circuit.component"
    DEPENDS EightOEightCircuit_VST3 EightOEightCircuit_AU
    VERBATIM)
endif()

# the sound's tests against the JavaScript (node tests/ref-*.mjs writes the references)
add_executable(t8_voices tests/voices.cpp src/dsp/Mna.cpp src/dsp/VoicesCircuit.cpp src/dsp/Kit.cpp src/dsp/Json.cpp)
add_executable(t8_player tests/player.cpp ${T8_DSP})
foreach(t t8_voices t8_player)
  target_include_directories(${t} PRIVATE src)
  if(NOT MSVC)
    target_compile_options(${t} PRIVATE -ffp-contract=off -fno-fast-math)
  endif()
  set_target_properties(${t} PROPERTIES EXCLUDE_FROM_ALL TRUE)
endforeach()

# a test host for the plugin (Linux, under Xvfb: see README)
if(T8_TEST_HOST)
  juce_add_gui_app(t8_host PRODUCT_NAME t8_host)
  target_sources(t8_host PRIVATE tests/host.cpp)
  target_compile_definitions(t8_host PRIVATE JUCE_WEB_BROWSER=1 JUCE_USE_CURL=0 JUCE_STANDALONE_APPLICATION=1)
  target_link_libraries(t8_host PRIVATE EightOEightCircuit juce::juce_audio_formats)
  set_target_properties(t8_host PROPERTIES EXCLUDE_FROM_ALL TRUE)
  add_custom_command(TARGET t8_host POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:t8_host>/Resources/app"
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${T8_STAGE} "$<TARGET_FILE_DIR:t8_host>/Resources/app"
    VERBATIM)
  add_dependencies(t8_host T8Resources)
endif()
