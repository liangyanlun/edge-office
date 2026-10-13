cmake_minimum_required(VERSION 3.22.1)

project(edge_office_native LANGUAGES C CXX)

# The mobile build only needs the core llama.cpp library.  Keeping the
# examples, server, tests and OpenMP disabled keeps the APK small and makes
# the build deterministic on Android's NDK toolchain.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_UI OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP_FETCH OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_REPACK ON CACHE BOOL "" FORCE)

add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/../../../../third_party/llama.cpp llama-build EXCLUDE_FROM_ALL)

# Unity builds embed absolute source paths in generated C++ files.  The
# project directory contains Chinese characters, which older NDK clang
# versions cannot decode in those generated includes.  Compile the core files
# normally instead; this is also friendlier to incremental Android builds.
set_target_properties(llama PROPERTIES UNITY_BUILD OFF)

add_library(offline-runtime SHARED offline_runtime_jni.cpp)
target_compile_features(offline-runtime PRIVATE cxx_std_17)
target_include_directories(offline-runtime PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/../../../../third_party/llama.cpp/include
)
target_link_libraries(offline-runtime PRIVATE llama log android)

set_target_properties(offline-runtime PROPERTIES
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN ON
)
