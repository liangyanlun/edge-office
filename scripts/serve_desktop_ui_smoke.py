"""Serve only temporary synthetic runtime data for the desktop browser check."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.app import create_app

with tempfile.TemporaryDirectory(prefix="edge-office-ui-storage-") as folder:
    root=Path(folder)
    app=create_app({"DATA_DIR":root/"data","INDEX_DIR":root/"indexes","MODELS_DIR":root/"models",
                    "DATABASE_PATH":root/"data/test.db","EMBEDDING_MODEL_PATH":"",
                    "LLAMA_CPP_ENABLED":False,"TESTING":True})
    app.run(host="127.0.0.1",port=18173,use_reloader=False)
