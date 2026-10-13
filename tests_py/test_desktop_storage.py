import json
from pathlib import Path
import pytest
from backend.app import create_app
from backend.config import default_config
from backend.desktop_storage import save_model_directory, read_storage_preferences
from desktop_launcher import DesktopBridge


def app_at(tmp_path):
    return create_app({'DATA_DIR':tmp_path/'data','INDEX_DIR':tmp_path/'indexes',
                      'DATABASE_PATH':tmp_path/'data/test.db','MODELS_DIR':tmp_path/'models',
                      'EMBEDDING_MODEL_PATH':'','LLAMA_CPP_ENABLED':False,'TESTING':True})


def test_choose_directory_persists_and_reconfigures_only_models(tmp_path, monkeypatch):
    app = app_at(tmp_path)
    root = tmp_path / 'other disk 中文'; root.mkdir()
    model_id = 'qwen3.5-0.8b-office'
    path = save_model_directory(app, model_id, root)
    d = app.extensions['model_downloader']
    assert d.model_path.parent == Path(path)
    assert d.models_dir == root
    assert app.extensions['inference'].model_path == d.model_path
    assert app.config['DATABASE_PATH'] == tmp_path/'data/test.db'
    monkeypatch.setenv('EDGE_OFFICE_HOME', str(tmp_path))
    settings = app.config['MODEL_STORAGE_SETTINGS']
    assert read_storage_preferences(settings)[model_id] == path
    # Config restart consumes the persisted per-model directory.
    from backend import config
    original = config.read_storage_preferences
    monkeypatch.setattr(config, 'read_storage_preferences', lambda _: original(settings))
    assert Path(default_config()['MODEL_0P8_MODEL_PATH']).parent == Path(path)
    assert not list(root.glob('.edge-office-write-probe-*'))


def test_directory_change_blocked_during_download_and_for_installed_model(tmp_path):
    app = app_at(tmp_path); root = tmp_path/'new'; root.mkdir()
    d = app.extensions['model_downloader']
    d._set_state(state='downloading')
    with pytest.raises(ValueError, match='下载正在'): save_model_directory(app, 'qwen3.5-0.8b-office', root)
    d._set_state(state='idle'); d.model_path.parent.mkdir(parents=True,exist_ok=True); d.model_path.write_bytes(b'keep model')
    with pytest.raises(ValueError, match='已下载'): save_model_directory(app, 'qwen3.5-0.8b-office', root)
    assert d.model_path.read_bytes() == b'keep model'
    # Native picker only: no arbitrary path-taking HTTP endpoint.
    assert app.test_client().post('/api/v1/models/qwen3.5-0.8b-office/directory',json={'path':str(root)}).status_code in (404,405)


def test_native_bridge_refuses_external_page(tmp_path):
    app = app_at(tmp_path)
    bridge = DesktopBridge(app,'http://127.0.0.1:4173')
    class Window:
        def get_current_url(self): return 'https://evil.example/'
        def create_file_dialog(self,*args,**kwargs): raise AssertionError('must not open')
    bridge._window=Window()
    assert bridge.choose_model_directory('qwen3.5-4b-office').get('error')
