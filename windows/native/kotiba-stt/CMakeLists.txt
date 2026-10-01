# kotiba-stt — the persistent whisper host. D-W7.
#
# Builds one executable that links whisper.cpp pinned to v1.9.2, the tag the macOS app
# links, so decode behaviour matches rather than merely resembles.
#
# ---------------------------------------------------------------------------------
# THE BUILD FLAGS ARE NOT TUNABLE
# ---------------------------------------------------------------------------------
#
# D-W7 fixes them and this file forces them. `GGML_NATIVE` defaults to ON, which means
# cmake compiles for the CPU doing the building — and this repository has already paid
# for that once, as a SIGILL (exit 132) on a GitHub runner fleet that served a Xeon
# 8573C and an AMD EPYC 7763 on consecutive runs. A shipped binary cannot target the
# build machine's instruction set.
#
#   GGML_NATIVE  OFF    do not compile for the build host
#   GGML_AVX     ON     the audience's floor
#   GGML_AVX2    ON     what a Tashkent i5 laptop has
#   GGML_AVX512  OFF    what a cloud server has and the audience does not
#   GGML_FMA     ON
#   GGML_F16C    ON
#
# They are set as CACHE ... FORCE before whisper.cpp is added, because ggml reads them
# at configure time and a plain `set()` after the fact is silently ignored.
#
# Build:
#   cmake -S windows/native/kotiba-stt -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build --config Release
#
# To build against a whisper.cpp checkout you already have (the CI cache path):
#   cmake -S ... -B ... -DKOTIBA_WHISPER_SOURCE_DIR=/path/to/wcpp

cmake_minimum_required(VERSION 3.19)
project(kotiba_stt CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# ---------------------------------------------------------------------------------
# ggml / whisper.cpp options — D-W7, forced
# ---------------------------------------------------------------------------------
set(GGML_NATIVE  OFF CACHE BOOL "" FORCE)
set(GGML_AVX     ON  CACHE BOOL "" FORCE)
set(GGML_AVX2    ON  CACHE BOOL "" FORCE)
set(GGML_AVX512  OFF CACHE BOOL "" FORCE)
set(GGML_FMA     ON  CACHE BOOL "" FORCE)
set(GGML_F16C    ON  CACHE BOOL "" FORCE)

# Nothing here runs whisper's own binaries, and each one is minutes on a 1-core runner.
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)

# ---------------------------------------------------------------------------------
# KOTIBA_CPU_ALL_VARIANTS — runtime CPU dispatch (the zig/mingw build turns it on)
# ---------------------------------------------------------------------------------
#
# OFF (the MSVC reference build, D-W7): one static kotiba-stt.exe for the AVX2 floor above.
# A CPU without AVX2 — a Celeron or Pentium Silver, which the audience does own — dies on
# the first decode with an illegal instruction.
#
# ON (windows/scripts/build-native-zig.sh): ggml is built the way upstream ships its own
# Windows releases — whisper.dll, ggml.dll, ggml-base.dll and one ggml-cpu-<variant>.dll per
# x86 level (x64, sse42, sandybridge, ivybridge, piledriver, haswell, skylakex, …) — and
# main() calls ggml_backend_load_all(), which scores every ggml-cpu-*.dll beside the exe
# against CPUID and loads the best one this machine can execute. Same decode, no SIGILL
# floor. GGML_NATIVE stays OFF: every variant names its own instruction set explicitly.
#
# The DLLs must be named WITHOUT MinGW's default "lib" prefix: ggml's loader looks for
# "ggml-cpu-*.dll" on Windows and would silently find nothing, leaving no CPU device.
option(KOTIBA_CPU_ALL_VARIANTS "Build ggml's CPU backend for every x86 level and pick one at runtime" OFF)
if(KOTIBA_CPU_ALL_VARIANTS)
  set(BUILD_SHARED_LIBS     ON CACHE BOOL "" FORCE)
  set(GGML_BACKEND_DL       ON CACHE BOOL "" FORCE)
  set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
  set(CMAKE_SHARED_LIBRARY_PREFIX "")
  set(CMAKE_SHARED_MODULE_PREFIX "")
endif()

# The AVX flags above only describe an x86 target. On arm64 — an ARM Windows machine, or
# a developer's Apple silicon Mac running the host locally — they mean nothing and ggml
# ignores them; GGML_NATIVE=OFF still matters and still applies.
if(NOT CMAKE_SYSTEM_PROCESSOR MATCHES "(x86|AMD64|amd64|i.86)")
  message(STATUS "kotiba-stt: non-x86 target (${CMAKE_SYSTEM_PROCESSOR}) — the AVX flags do not apply, GGML_NATIVE=OFF still does")
endif()

set(KOTIBA_WHISPER_TAG "v1.9.2" CACHE STRING "whisper.cpp tag. Pinned by D-W7; do not move it casually.")
set(KOTIBA_WHISPER_SOURCE_DIR "" CACHE PATH "An existing whisper.cpp checkout to build against, instead of fetching one.")

if(KOTIBA_WHISPER_SOURCE_DIR)
  message(STATUS "kotiba-stt: using whisper.cpp from ${KOTIBA_WHISPER_SOURCE_DIR}")
  add_subdirectory(${KOTIBA_WHISPER_SOURCE_DIR} ${CMAKE_BINARY_DIR}/whisper-build)
else()
  include(FetchContent)
  FetchContent_Declare(
    whisper_cpp
    GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp
    GIT_TAG        ${KOTIBA_WHISPER_TAG}
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(whisper_cpp)
endif()

add_executable(kotiba-stt
  src/main.cpp
  src/json.cpp
)

# Since host 1.1 the reader and the decoder are two threads (abort and VAD answer while a
# decode runs). MSVC needs nothing for std::thread; MinGW and POSIX toolchains need this.
find_package(Threads REQUIRED)
target_link_libraries(kotiba-stt PRIVATE whisper Threads::Threads)

if(MSVC)
  # /utf-8 is not cosmetic: the initial prompt and every transcript are UTF-8, and MSVC
  # otherwise reads the source and writes the execution charset in the system codepage,
  # which on a Russian or Uzbek Windows is not UTF-8.
  target_compile_options(kotiba-stt PRIVATE /utf-8 /W4)
else()
  target_compile_options(kotiba-stt PRIVATE -Wall -Wextra)
endif()

install(TARGETS kotiba-stt RUNTIME DESTINATION .)

# KOTIBA_CPU_ALL_VARIANTS: whisper.cpp's top-level CMakeLists points every runtime artefact at
# ${CMAKE_BINARY_DIR}/bin, so whisper.dll, ggml*.dll and every ggml-cpu-<variant>.dll are
# there. They install flat beside kotiba-stt.exe — the directory ggml_backend_load_all() and
# the Windows loader both search — and electron-builder.yml ships `*.dll` from it.
if(KOTIBA_CPU_ALL_VARIANTS)
  install(DIRECTORY ${CMAKE_BINARY_DIR}/bin/ DESTINATION .
          FILES_MATCHING PATTERN "*.dll")
endif()

# THE C RUNTIME, APP-LOCAL. MSVC links the DLL runtime by default, so kotiba-stt.exe needs
# VCRUNTIME140(_1).dll and MSVCP140.dll — which a clean Windows does not have, and which the
# per-user, unelevated installer cannot install system-wide. Microsoft supports copying them
# next to the executable; `InstallRequiredSystemLibraries` does exactly that from the
# Build Tools' redist folder, into the same flat directory, and electron-builder.yml ships
# `*.dll` from it. NOT switched to the static runtime like kotiba-hook and kotiba-input:
# whisper.cpp and ggml are built in their own directories under their own policies, and a
# runtime-flag disagreement between them and this target is a link failure nobody here can
# reproduce without MSVC. The UCRT is part of Windows 10 and 11 and is left out.
if(MSVC)
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION .)
  set(CMAKE_INSTALL_UCRT_LIBRARIES FALSE)
  include(InstallRequiredSystemLibraries)
endif()
