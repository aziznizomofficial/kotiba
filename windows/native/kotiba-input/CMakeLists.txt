# kotiba-input — text insertion at the caret.
#
# Windows only. `SendInput`, the clipboard and UI Automation have no analogue worth
# stubbing, and a cross-platform shim here would be a second implementation nobody runs.
# The gate on a Mac covers the TypeScript consumer against a fake helper that speaks
# this protocol (windows/test/platform/fake-input.mjs); CI on `windows-latest` compiles
# this.
#
# Build:
#   cmake -S windows/native/kotiba-input -B build/input -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/input --config Release
#
# ---------------------------------------------------------------------------------
# THE ONE SHARED FILE
# ---------------------------------------------------------------------------------
#
# `json.cpp` / `json.h` are compiled from `../kotiba-stt/src`, not copied. Both helpers
# speak flat JSON objects of string / number / bool over a pipe, and that reader is
# ~200 lines that were already written, reviewed and given a test. A second copy would
# drift, and the drift would be in the escaping of user speech — the one place in this
# codebase where an okina or a quote is guaranteed to turn up.
#
# It is a compile-time dependency on a file this task does not own. If kotiba-stt's JSON
# API changes, this build breaks loudly at compile time rather than quietly at runtime,
# which is the acceptable failure for a shared header.

cmake_minimum_required(VERSION 3.19)
project(kotiba_input CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(NOT WIN32)
  message(FATAL_ERROR
    "kotiba-input is Windows-only — SendInput, the clipboard and UI Automation have no "
    "portable stand-in. The TypeScript side is tested against windows/test/platform/fake-input.mjs.")
endif()

set(KOTIBA_JSON_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../kotiba-stt/src")
if(NOT EXISTS "${KOTIBA_JSON_DIR}/json.cpp")
  message(FATAL_ERROR "kotiba-input needs ${KOTIBA_JSON_DIR}/json.cpp — build from a full checkout.")
endif()

add_executable(kotiba-input
  src/main.cpp
  ${KOTIBA_JSON_DIR}/json.cpp
)

target_include_directories(kotiba-input PRIVATE ${KOTIBA_JSON_DIR})

# uiautomationcore for the verified in-place replace; ole32 for the apartment the
# automation object lives in and for CoCreateInstance(MMDeviceEnumerator), which the
# ducking commands use. The Core Audio interfaces are named with __uuidof, so no uuid.lib.
target_link_libraries(kotiba-input PRIVATE uiautomationcore ole32 oleaut32 user32)

if(MSVC)
  # /utf-8 is load-bearing here and not cosmetic: every string this program handles is
  # UTF-8 dictated speech, and MSVC otherwise reads the source and writes the execution
  # charset in the system codepage — which on a Russian or Uzbek Windows is not UTF-8.
  target_compile_options(kotiba-input PRIVATE /utf-8 /W4)
else()
  target_compile_options(kotiba-input PRIVATE -Wall -Wextra)
endif()

# THE STATIC C RUNTIME. MSVC's default is the DLL runtime, which makes this helper need
# VCRUNTIME140.dll (and MSVCP140.dll for std::thread) at start-up — DLLs a clean Windows
# does not have and that neither the installer nor electron-builder.yml ships. Without them
# the helper does not start at all, and on a PC without the VC++ redistributable that is
# no typing and no ducking. This target links nothing else, so /MT has no other library to agree
# with. (cmake_minimum_required 3.19 makes CMP0091 NEW, which this property needs.)
set_property(TARGET kotiba-input PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

install(TARGETS kotiba-input RUNTIME DESTINATION .)
