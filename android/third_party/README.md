# Native dependency source

`llama.cpp/` contains the build inputs used by the Android offline runtime: core
sources, public headers, CMake modules, GGML and third-party support files. The
upstream MIT license and author list are retained. Upstream project:
https://github.com/ggml-org/llama.cpp

This is a source snapshot of the locally tested dependency, not a Git submodule.
The exact upstream commit was not recorded when this snapshot was imported; do
not interpret its CMake version as a verified upstream tag. The checked-in source
is the reproducible input for this application commit. Future dependency updates
should record the upstream commit and repeat the Android build/inference checks.

Vocabulary GGUF files, model weights, upstream demos, caches and compiled libraries
are intentionally excluded. Android's CMake entry disables upstream examples,
tests, server and tools; no separate checkout of upstream main is needed to build
the core library. This dependency is not the trained Edge Office model.
