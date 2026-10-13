from pathlib import Path
from types import SimpleNamespace
import json

import pytest

from backend.app import create_app
from backend.inference import InferenceAdapter, LocalModelRegistry
from backend.model_catalog import FOUR_B_MODEL_ID
from backend.model_download import ModelReleaseDownloader


def test_available_does_not_mean_loaded(tmp_path):
    model = tmp_path / 'model.gguf'
    model.write_bytes(b'fake')
    adapter = InferenceAdapter(LocalModelRegistry(tmp_path), model_path=model, release_required=False)
    import backend.inference as inference
    if inference.Llama is not None:
        assert adapter.status()['status'] == 'llama-cpp-available'
        assert adapter.status()['loaded'] is False
    adapter._model = object()
    assert adapter.status()['status'] == 'llama-cpp-ready'


@pytest.mark.parametrize('prompt_tokens,budget', [(300, 1024), (1500, 516)])
def test_budget_counts_template_tokens_not_characters(prompt_tokens, budget):
    adapter = InferenceAdapter(None)
    model = SimpleNamespace(
        _office_chat_formatter=lambda **_: SimpleNamespace(prompt='测试', added_special=True),
        tokenize=lambda *_args, **_kwargs: [1] * prompt_tokens,
    )
    assert adapter._output_budget(model, []) == budget


def test_budget_rejects_full_context():
    adapter = InferenceAdapter(None)
    model = SimpleNamespace(
        _office_chat_formatter=lambda **_: SimpleNamespace(prompt='test', added_special=True),
        tokenize=lambda *_args, **_kwargs: [1] * 2010,
    )
    with pytest.raises(RuntimeError, match='上下文上限'):
        adapter._output_budget(model, [])


@pytest.mark.parametrize('message,code', [
    ('llama.cpp 输出被 token 上限截断', 'OUTPUT_TRUNCATED'),
    ('模型回答包含内部提示、截断内容或缺少有效引用', 'ANSWER_REJECTED'),
    ('未找到 GGUF 模型：C:/private/secret.gguf', 'MODEL_UNAVAILABLE'),
])
def test_fallback_has_specific_safe_reason(message, code, monkeypatch):
    adapter = InferenceAdapter(None)
    def fail(*_):
        raise RuntimeError(message)
    monkeypatch.setattr(adapter, '_generate_with_llama_cpp', fail)
    assert '原文' in adapter.compose_answer('question', [{'quote': '事实'}], True)
    metrics = adapter.last_generation_metrics()
    assert metrics['answerKind'] == 'extractive_fallback'
    assert metrics['fallbackCode'] == code
    assert 'secret' not in metrics['fallbackReason']


def test_4b_selection_is_used_by_general_and_ppt_tasks(tmp_path, monkeypatch):
    models = tmp_path / 'models'
    four = models / 'qwen3_5_4b_office_q4_k_m' / 'Qwen3.5-4B-PPT.Q4_K_M.gguf'
    four.parent.mkdir(parents=True)
    four.write_bytes(b'not-loaded-in-this-test')
    four.with_suffix('.SHA256SUMS.txt').write_text('placeholder', encoding='utf-8')
    (models / 'active_model.json').write_text(json.dumps({'modelId': FOUR_B_MODEL_ID}), encoding='utf-8')
    app = create_app({
        'DATA_DIR': tmp_path / 'data', 'INDEX_DIR': tmp_path / 'indexes',
        'DATABASE_PATH': tmp_path / 'data' / 'test.db', 'MODELS_DIR': models,
        'EMBEDDING_MODEL_PATH': '', 'LLAMA_CPP_ENABLED': False, 'TESTING': True,
    })
    assert app.extensions['inference'].model_path == four
    general = app.extensions['chat_inference']
    assert general is app.extensions['inference']
    assert '4B' in general.model_path.name
    assert app.extensions['agent'].inference is app.extensions['inference']
    assert app.extensions['ppt'].planner.inference is general
    runtime = app.test_client().get('/api/v1/runtime/status').json
    assert runtime['modelRoutingNotice']
    catalog = {item['id']: item for item in runtime['models']}
    assert catalog[FOUR_B_MODEL_ID]['active'] is True
    assert {'chat', 'rag', 'agent'}.issubset(catalog[FOUR_B_MODEL_ID]['capabilities'])
    for item in catalog.values():
        assert item['defaultSourceId'] == 'modelscope'

    # Isolate model quality from the routing contract: the SSE record must
    # identify the selected 4B even without installing a second 0.8B model.
    monkeypatch.setattr(general, 'status', lambda: {'name': four.stem})
    monkeypatch.setattr(app.extensions['agent'], 'execute', lambda *_args, **_kwargs: (
        '测试回答', [], {'action': 'respond_without_tool', 'timings': {'answerKind': 'generated'}}, []
    ))
    stream = app.test_client().post('/api/v1/chat/stream', json={
        'message': '你好', 'ragEnabled': False,
    }).get_data(as_text=True)
    assert 'Qwen3.5-4B-PPT.Q4_K_M' in stream
    assert '0.8B' not in stream

    # Downloading an inactive 0.8B must not refresh/replace an already loaded
    # 4B adapter, nor be blocked merely because that different file is open.
    general._model = object()
    inactive_downloader = app.extensions['model_downloader']
    assert inactive_downloader.can_replace()
    inactive_downloader.on_installed()
    assert general._model is not None


def test_start_without_source_prefers_verified_mirror(tmp_path, monkeypatch):
    model = tmp_path / 'model.gguf'
    downloader = ModelReleaseDownloader(
        enabled=True, repository='liangyanlun/edge-office', release_tag='v0.1.0',
        models_dir=tmp_path, model_path=model, manifest_path=tmp_path / 'manifest.json',
        checksum_path=tmp_path / 'checksum.txt', n_ctx=2048, release_required=True,
        mirror_repository='liangyl233/edge_model_0.8b', mirror_verified=True,
    )
    monkeypatch.setattr(downloader, '_run', lambda: None)
    assert downloader.start()['sourceId'] == 'modelscope'


def test_thinking_switch_is_passed_to_template(monkeypatch):
    import backend.inference as inference
    seen = {}
    def handler_factory(formatter):
        def handler(**kwargs):
            seen.update(kwargs)
            return formatter(messages=kwargs['messages'], enable_thinking=kwargs['enable_thinking']).prompt
        return handler
    monkeypatch.setattr(inference, 'chat_formatter_to_chat_completion_handler', handler_factory)
    model = SimpleNamespace(
        metadata={'tokenizer.chat_template': '{{ enable_thinking }}'},
        token_eos=lambda: 1, token_bos=lambda: -1,
        _model=SimpleNamespace(token_get_text=lambda _: '</s>'),
    )
    InferenceAdapter._configure_direct_response_handler(model)
    assert model.chat_handler(messages=[], enable_thinking=True) == 'False'
    assert seen['enable_thinking'] is False
