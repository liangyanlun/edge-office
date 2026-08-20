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
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
