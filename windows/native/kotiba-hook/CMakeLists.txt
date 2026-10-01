# kotiba-hook — the push-to-talk reporter. D-W4.
#
# Windows only, and deliberately so: `WH_KEYBOARD_LL` has no analogue to stub out, and a
# cross-platform shim here would be a second implementation nobody runs. The gate on a
# Mac covers the TypeScript consumer against a fake helper that speaks this protocol
# (windows/test/platform/fake-hook.mjs); CI on `windows-latest` is what compiles this.
#
# Build:
#   cmake -S windows/native/kotiba-hook -B build/hook -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/hook --config Release
#
# There are no dependencies. Nothing is fetched, nothing is vendored, and that is worth
# keeping: this binary is a keyboard hook, and every library added to it is a library
# with access to every keystroke on the machine.

cmake_minimum_required(VERSION 3.19)
project(kotiba_hook CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(NOT WIN32)
  message(FATAL_ERROR
    "kotiba-hook is Windows-only — it is a WH_KEYBOARD_LL hook and there is nothing to "
    "build elsewhere. The TypeScript side is tested against windows/test/platform/fake-hook.mjs.")
endif()

add_executable(kotiba-hook src/main.cpp)

if(MSVC)
  # /utf-8 for the same reason kotiba-stt sets it: MSVC otherwise reads the source and
  # writes the execution charset in the system codepage, which on a Russian or Uzbek
  # Windows is not UTF-8. Nothing here emits non-ASCII today; that is not a reason to
  # let the next line that does be wrong.
  target_compile_options(kotiba-hook PRIVATE /utf-8 /W4)
else()
  target_compile_options(kotiba-hook PRIVATE -Wall -Wextra)
endif()

# THE STATIC C RUNTIME. MSVC's default is the DLL runtime, which makes this helper need
# VCRUNTIME140.dll (and MSVCP140.dll for std::thread) at start-up — DLLs a clean Windows
# does not have and that neither the installer nor electron-builder.yml ships. Without them
# the helper does not start at all, and on a PC without the VC++ redistributable that is
# no hotkey. This target links nothing else, so /MT has no other library to agree
# with. (cmake_minimum_required 3.19 makes CMP0091 NEW, which this property needs.)
set_property(TARGET kotiba-hook PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

install(TARGETS kotiba-hook RUNTIME DESTINATION .)
