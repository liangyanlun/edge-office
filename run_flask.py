from __future__ import annotations

import os
import sys
from pathlib import Path

# Some Windows installations add the global Python site-packages even when the
# project dependencies are supplied through PYTHONPATH. Prefer this project's
# virtual environment to avoid mixing an incompatible global torchvision with
# the virtualenv torch used by sentence-transformers.
_global_site = (Path(sys.base_prefix) / "Lib" / "site-packages").resolve()
sys.path[:] = [entry for entry in sys.path if not entry or Path(entry).resolve() != _global_site]

from backend.app import create_app


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "4173"))
    # Loopback remains the safe default. Set EDGE_OFFICE_HOST explicitly for a
    # paired LAN/mobile session; never expose the development server publicly.
    host = os.getenv("EDGE_OFFICE_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1", "localhost"} and os.getenv("EDGE_OFFICE_MODE", "local") == "local":
        raise RuntimeError("非本机地址必须设置 EDGE_OFFICE_MODE=lan 并配置配对码与签名密钥")
    app.run(host=host, port=port, debug=False, threaded=True)
