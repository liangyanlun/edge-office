# 本地模型目录

此目录只存放本地模型制品，Flask 不会把其中任何文件作为静态资源对外提供。

推荐结构：

```text
artifacts/models/
├─ office-student-int8/
│  └─ 0.1.0/
│     ├─ manifest.json
│     ├─ weights/
│     │  └─ model.onnx
│     ├─ tokenizer/
│     ├─ prompt-template.txt
│     ├─ benchmark.json
│     └─ checksums.sha256
└─ embeddings/
   └─ <本地 SentenceTransformer 模型目录>/
```

当前 `InferenceAdapter` 会扫描 `*/<version>/manifest.json`，并在运行状态接口中报告已发现的模型包；尚未放入权重时会使用演示回答适配器。不要把模型放进 `public/`。

若要启用本地 Embedding 模型，将完整路径设置为环境变量后启动服务：

```powershell
$env:RAG_EMBEDDING_MODEL = "artifacts\models\embeddings\your-local-model"
.\.venv\Scripts\python.exe run_flask.py
```

没有该变量或目录不存在时，系统继续使用离线哈希 Embedding，FAISS、SQLite、引用和 Agent 流程仍完整可用；该兜底仅用于演示和接口联调，不用于最终检索质量评测。
