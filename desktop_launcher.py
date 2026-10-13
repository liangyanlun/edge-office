from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path

if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
    # llama-cpp-python locates DLLs relative to its package. Keep the bundled
    # location explicit so the Windows onedir build never falls back to a
    # missing external package path.
    os.environ.setdefault("LLAMA_CPP_LIB_PATH", str(Path(sys._MEIPASS) / "llama_cpp" / "lib"))

import webview
from werkzeug.serving import BaseWSGIServer, make_server

from backend.app import create_app
from backend.desktop_storage import save_model_directory


APP_NAME = "微知 Edge Office"


class DesktopBridge:
    def __init__(self, app, url: str) -> None:
        self._app = app
        self._url = url
        self._window = None

    def _trusted_window(self):
        if self._window is None or self._window.get_current_url() not in (self._url, self._url + "/", self._url + "/index.html"):
            raise ValueError("请从本机应用工作区选择位置")
        return self._window

    def get_installation_info(self) -> dict:
        self._trusted_window()
        return {"applicationDirectory": str(Path(sys.executable).parent if getattr(sys, "frozen", False) else self._app.config["ROOT_DIR"]),
                "modelsDirectory": str(self._app.config["MODELS_DIR"])}

    def choose_model_directory(self, model_id: str) -> dict:
        try:
            window = self._trusted_window()
            downloader = self._app.extensions["model_downloaders"].get(model_id)
            if model_id == "default" or downloader is None:
                raise ValueError("未找到该模型配置")
            initial = downloader.model_path.parent
            selection = window.create_file_dialog(webview.FileDialog.FOLDER,
                directory=str(initial if initial.is_dir() else Path.home()))
            if not selection:
                return {"cancelled": True}
            location = save_model_directory(self._app, model_id, Path(selection[0]))
            return {"cancelled": False, "modelDirectory": location}
        except (OSError, ValueError):
            return {"error": "无法保存下载位置。请选择可写文件夹，并确认该模型尚未下载且没有下载任务正在进行。"}


def find_available_port() -> int:
    for port in range(4173, 4184):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("未找到可用的本地端口（4173-4183）")


def wait_until_listening(port: int, timeout_seconds: float = 6.0) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.25)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


class DesktopApplication:
    def __init__(self) -> None:
        self.port = find_available_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.app = create_app()
        self.server: BaseWSGIServer = make_server("127.0.0.1", self.port, self.app, threaded=True)
        self.server_thread = threading.Thread(target=self.server.serve_forever, name="edge-office-server", daemon=True)
        self._stopped = False

    def start(self) -> None:
        self.server_thread.start()
        if not wait_until_listening(self.port):
            self.stop()
            raise RuntimeError("本地服务未能启动")

        try:
            bridge = DesktopBridge(self.app, self.url)
            bridge._window = webview.create_window(
                APP_NAME,
                self.url,
                js_api=bridge,
                width=1440,
                height=920,
                min_size=(1024, 700),
                background_color="#0f172a",
            )
            # Windows 上使用 Edge WebView2：前端渲染在独立原生窗口中，不再拉起默认浏览器。
            webview.start(gui="edgechromium", debug=False)
        finally:
            self.stop()

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    DesktopApplication().start()
