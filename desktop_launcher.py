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


APP_NAME = "微知 Edge Office"


def find_available_port() -> int:
    for port in range(4173, 4184):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
            webview.create_window(
                APP_NAME,
                self.url,
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
