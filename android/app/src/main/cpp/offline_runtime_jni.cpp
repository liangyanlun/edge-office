#include <jni.h>

#include "llama.h"

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

namespace {

std::string read_string(JNIEnv * env, jstring value) {
    if (value == nullptr) {
        return {};
    }
    const char * chars = env->GetStringUTFChars(value, nullptr);
    if (chars == nullptr) {
        return {};
    }
    std::string result(chars);
    env->ReleaseStringUTFChars(value, chars);
    return result;
}

jstring make_string(JNIEnv * env, const std::string & value) {
    return env->NewStringUTF(value.c_str());
}

struct GenerationResult {
    std::string text;
    int tokens = 0;
    int64_t generation_ms = 0;
    std::string finish_reason = "error";
};

GenerationResult generate(const std::string & model_path, const std::string & prompt, int max_tokens) {
    if (model_path.empty() || prompt.empty()) {
        return {};
    }

    llama_backend_init();

    llama_model_params model_params = llama_model_default_params();
    // Android builds are deliberately CPU-first.  llama.cpp still uses the
    // best available ARM kernels from the NDK without requiring a GPU backend.
    model_params.n_gpu_layers = 0;
    llama_model * model = llama_model_load_from_file(model_path.c_str(), model_params);
    if (model == nullptr) {
        llama_backend_free();
        return {};
    }

    const llama_vocab * vocab = llama_model_get_vocab(model);
    const int prompt_count = -llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    if (prompt_count <= 0 || prompt_count > 1984) {
        llama_model_free(model);
        llama_backend_free();
        return {};
    }
    const int requested_tokens = std::min(std::clamp(max_tokens, 8, 1024), 2048 - prompt_count - 32);

    std::vector<llama_token> prompt_tokens(prompt_count);
    if (llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), prompt_tokens.data(), prompt_count, true, true) < 0) {
        llama_model_free(model);
        llama_backend_free();
        return {};
    }

    llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = 2048;
    context_params.n_batch = static_cast<uint32_t>(std::max(prompt_count, 1));
    context_params.n_threads = 0;
    context_params.n_threads_batch = 0;
    context_params.no_perf = true;

    llama_context * context = llama_init_from_model(model, context_params);
    if (context == nullptr) {
        llama_model_free(model);
        llama_backend_free();
        return {};
    }

    llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
    sampler_params.no_perf = true;
    llama_sampler * sampler = llama_sampler_chain_init(sampler_params);
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    llama_batch batch = llama_batch_get_one(prompt_tokens.data(), prompt_count);
    GenerationResult result;
    if (llama_decode(context, batch) == 0) {
        result.finish_reason = "length";
        const auto generation_start = std::chrono::steady_clock::now();
        for (int index = 0; index < requested_tokens; ++index) {
            llama_token token = llama_sampler_sample(sampler, context, -1);
            if (llama_vocab_is_eog(vocab, token)) {
                result.finish_reason = "stop";
                break;
            }
            char buffer[256];
            const int length = llama_token_to_piece(vocab, token, buffer, sizeof(buffer), 0, true);
            if (length <= 0) {
                result.finish_reason = "error";
                break;
            }
            result.text.append(buffer, static_cast<size_t>(length));
            result.tokens++;
            batch = llama_batch_get_one(&token, 1);
            if (llama_decode(context, batch) != 0) {
                result.finish_reason = "error";
                break;
            }
        }
        result.generation_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - generation_start).count();
    }

    llama_sampler_free(sampler);
    llama_free(context);
    llama_model_free(model);
    llama_backend_free();
    return result;
}

} // namespace

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_edgeoffice_app_OfflineRuntimePlugin_nativeGenerate(
        JNIEnv * env, jclass, jstring model_path, jstring prompt, jint max_tokens) {
    GenerationResult result;
    try {
        result = generate(read_string(env, model_path), read_string(env, prompt), max_tokens);
    } catch (...) {
        result = {};
    }
    jclass string_class = env->FindClass("java/lang/String");
    if (string_class == nullptr) return nullptr;
    jobjectArray values = env->NewObjectArray(4, string_class, nullptr);
    if (values == nullptr) return nullptr;
    const std::string fields[] = {result.text, std::to_string(result.tokens), std::to_string(result.generation_ms), result.finish_reason};
    for (int index = 0; index < 4; ++index) {
        jstring value = make_string(env, fields[index]);
        if (value == nullptr) return nullptr;
        env->SetObjectArrayElement(values, index, value);
        env->DeleteLocalRef(value);
    }
    return values;
}
