# 微知 Edge Office · Flask + SQLite + FAISS Demo

当前主版本已迁移为 Flask 后端：会话、文档、切片和 Agent 运行记录持久化至 SQLite；文档导入后会建立真实 FAISS 向量索引；受控 Agent 会在白名单工具中选择一次动作并生成可追溯回答。原 Node 内存版仍保留，可用于界面回退对照。

## 已实现

- Flask `/api/v1`、多轮会话与流式 SSE 响应；
- SQLite 持久化：会话、消息、文档、RAG 切片、Agent 运行和步骤；
- 离线混合 RAG：BGE 中文语义向量 + FAISS `IndexFlatIP` + BM25 词法召回 + 轻量重排序；
- 句子感知切片、稳定切片 ID、内容哈希、版本号、相邻片段补全、证据引用与检索审计；
- 原子索引代际：新索引先验证并写入 `artifacts/indexes/generations/`，再切换活动指针；构建失败时保留上一代可查询索引；
- 检索前权限过滤、重复证据抑制、低置信度拒答和引用编号校验；
- 受控单动作 Agent：14 个固定模型可见动作、严格三字段 ActionPlan、JSON Grammar 约束输出与确定性二次校验；
- 高风险操作的计划哈希绑定、5 分钟一次性确认、取消/过期/重放防护、幂等执行键与按请求 ID 查询的审计链；
- 所有办公连接器当前均为本地沙箱；页面会展示计划、风险和确认按钮，真实邮件/日历/文件写入尚未开放；
- Flask 进程内 `llama.cpp` GGUF 推理，不依赖 Ollama；
- 离线 TXT / Markdown / PDF+OCR / DOCX / XLSX / CSV / PPTX / HTML 导入，保留页码、段落、工作表单元格、幻灯片、表格与备注定位；
- Node 前端兼容测试和 Flask 后端 pytest 测试。

## 启动

在此目录打开 PowerShell：

```powershell
.\.venv\Scripts\Activate.ps1
python run_flask.py
```

浏览器访问 <http://127.0.0.1:4173>。停止服务时按 `Ctrl + C`。

如果 4173 端口已经被占用，可在当前 PowerShell 改用其他端口：

```powershell
$env:PORT=4300
python run_flask.py
```

然后访问 <http://127.0.0.1:4300>。

## 测试

```powershell
npm test
```

```powershell
.\.venv\Scripts\python.exe -m pytest tests_py
```

## 演示建议

依次点击以下示例问题，能看到“检索 → 引用 → 流式回答 → 指标”的完整闭环：

1. `这个项目的核心创新是什么？`
2. `系统的性能目标有哪些？`
3. `精准 RAG 为什么适合边缘设备？`

再进入“知识库”，导入一个 `.txt`、`.md`、`.pdf`、`.docx`、`.xlsx`、`.csv`、`.pptx` 或 `.html` 文件，例如包含“中期检查材料需要在周五前提交”的文本；回到对话页提问即可看到新材料被引用。PDF/OCR 引用标出页码，Excel 标出工作表和单元格范围，PPT 标出幻灯片页码。

## 模型与 RAG

- 模型包放在 [artifacts/models/README.md](</F:/大创前端代码/artifacts/models/README.md:1>) 定义的位置，绝不放到 `public/`；
- 默认 RAG 嵌入模型为本地 `artifacts/models/bge-small-zh-v1.5`。它使用 `BAAI/bge-small-zh-v1.5` 的中文检索指令，生成 512 维归一化向量；模型卡说明它适用于中文检索，权重约 96MB。[模型卡](https://huggingface.co/BAAI/bge-small-zh-v1.5)
- 若克隆项目后缺少该模型，联网执行 `python scripts/download_rag_model.py` 下载一次；运行时不会联网下载，缺失时会明确降级到哈希向量，仅用于演示。
- RAG 先以 FAISS 与 BM25 各自召回候选，再结合句子级词项覆盖度重排序；最终只将 1～2 条紧凑证据输入 0.8B 模型，减少上下文和幻觉风险。
- 设置 `RAG_EMBEDDING_MODEL` 可替换本地 SentenceTransformer 路径；`RAG_QUERY_INSTRUCTION`、`RAG_TOP_K` 和 `RAG_CANDIDATE_K` 可用于研究对比实验。
- `RAG_RERANK_K`（默认 5）控制重排序候选证据数，`RAG_MIN_CONFIDENCE`（默认 0.42）控制拒答阈值，`RAG_ALLOWED_SECURITY_LEVELS`（默认 `public,internal`）控制本地会话允许检索的材料级别。
- 浏览器通过 `POST /api/v1/documents/import` 上传本地 TXT、Markdown、PDF、DOCX、XLSX、CSV、PPTX 或 HTML。后端按扩展名白名单解析、限制 20MB 原始文件与 20 万字符解析文本，并记录原始文件 SHA256、MIME 类型、解析器版本、抽取质量和结构统计；不会接受宏格式、任意压缩包或可执行内容。
- 扫描 PDF 使用内置 RapidOCR + ONNX Runtime 离线识别，只处理没有原生文本的页面；默认最多 30 个 OCR 页面。低置信度结果会在知识库页面标记“需复核”，任一扫描页完全无法识别时整份文件拒绝导入，不会污染已有索引。
- XLSX 默认限制 30 个工作表、每表 5000 行、100 列；PPTX 默认限制 300 页。Office 文件在解析前检查内部路径、文件数、展开体积和异常压缩比例。
- 可用 `OCR_ENABLED=false` 关闭 OCR；`MAX_OCR_PAGES`、`MAX_XLSX_ROWS_PER_SHEET`、`MAX_XLSX_COLUMNS` 和 `MAX_PPTX_SLIDES` 可调整资源上限。纯图片 PPT 页面暂不做 OCR，真实用户权限和原文件留存策略仍待完善。
- 默认生成模型为 `artifacts/models/qwen3_0p8_gguf/Qwen3.5-0.8B.q3_k_l.gguf`；Flask 会通过 `llama-cpp-python` 在本进程中加载它，并将 FAISS 检索证据直接传入模型生成回答；
- 可通过 `LLAMA_MODEL_PATH` 切换 GGUF，通过 `LLAMA_N_CTX`、`LLAMA_N_THREADS` 和 `LLAMA_N_GPU_LAYERS` 调整上下文、CPU 线程和 GPU 卸载层数；设置 `LLAMA_CPP_ENABLED=false` 可关闭真实推理并使用安全兜底；
- Agent 每轮只规划一个固定动作。模型输出受到 llama.cpp JSON Grammar 约束，并会被服务端以严格 JSON、字段、类型、大小、路径和权限策略再次校验；模型写出的 `confirmed:true` 一律拒绝。
- 高风险动作（发送邮件、提交日程、删除待办、覆盖文件）必须由用户在计划卡中显式确认。确认绑定用户、计划哈希、策略版本、过期时间与一次性 nonce；参数变化、过期或重放都会失效。
- 可通过 `GET /api/v1/agent/tools` 查看固定动作表；新计划 API 为 `POST /api/v1/plans`、`GET /api/v1/plans/{id}`、`POST /api/v1/plans/{id}/confirm`、`POST /api/v1/plans/{id}/cancel` 与 `GET /api/v1/audit/{requestId}`。
- 当前不暴露 Shell、任意 Python、任意 URL、任意 SQL 或真实外部发送；高风险动作只进行本地沙箱演练，后续接入真实服务仍需单独授权与连接器审查。
- 运行 `python scripts/evaluate_agent_plans.py --model <GGUF路径> --output <报告路径>` 可复现本地 ActionPlan 基线评测；当前基线结论见 [Agent评测报告](</F:/大创前端代码/Agent评测报告.md:1>)，尚未达到正式模型验收门槛。

## 旧版 Node 回退

```powershell
npm run start:node
```

接口事件、页面信息架构与指标字段已按 [前后端开发详细方案](</F:/大创前端代码/前后端开发详细方案.md:1>) 的方向设计，因此后续替换实现时不需要重做页面流程。
