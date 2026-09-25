# 微知 Edge Office · Flask + SQLite + FAISS Demo

当前源码开发标识：`0.2.0-dev.20260925`（尚非新安装包或手机 App 正式版）。[完整历史版本说明](CHANGELOG.md) 区分模型 Release、Windows 本地安装包和源码状态。

## 发布节奏

项目采用按影响范围分层的发布方式：网页承载小改动，Windows 桌面 App 承载较大功能变更，手机 App 只承载重大版本。这样可以避免每次小改动都重复构建和分发三套客户端。

详细规则见 [docs/release-policy.md](docs/release-policy.md)，历史版本、平台状态和证据见 [版本发布台账](outputs/edge-office-release-ledger/EdgeOffice-版本发布台账-20260925.xlsx)。

首发版默认不开放独立日历；会议纪要仍可整理时间节点。保留的日程实验模块和开发开关见 [docs/calendar-schedule.md](docs/calendar-schedule.md)。

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
- 独立 PPT 编辑工作区：原件只读保存、稳定对象 ID、修改前后预览、受限操作计划、确认发布、版本下载与恢复；
- PPT 首版只开放 `replace_paragraph`、`clone_paragraph`、`del_paragraph`、`replace_image`、`del_image`，不开放新增幻灯片、表格、图表、SmartArt、母版、备注或动画修改；
- Node 前端兼容测试和 Flask 后端 pytest 测试。

## PPT 编辑模块

“知识库”中的 PPTX 仍然只用于文本抽取和 RAG；需要修改演示文稿时，请使用单独的“PPT 编辑”入口。PPT 编辑文件保存在：

```text
artifacts/data/presentations/{document_id}/
  original/source.pptx
  versions/{version_id}/presentation.pptx
  versions/{version_id}/snapshot.json
  versions/{version_id}/slides/*.png
  staged/{patch_id}/candidate.pptx
  staged/{patch_id}/preview/*.png
```

原始文件永不覆盖。模型只生成五类 API 调用序列，后端会依次进行 AST 解析、对象与参数校验、副本执行、保存后重开、非目标页校验和预览渲染。通用 Agent 只接收 `patch_id`；确认接口不接受模型操作参数，并直接发布已经预览、验证且哈希一致的 staged 文件。

当前 0.8B 模型低于 PPT 编辑建议的 4B，前端会明确提示用户重点核对计划与预览。4B 专项模型通过评测后，只需替换 GGUF 与发布清单，`PptPlanner`、受限契约和确认链路不需要改动。Windows 优先在独立 PowerPoint COM 进程中导出 PNG；没有 Office 时尝试 LibreOffice，均不可用时显示安全的近似布局预览并明确标记。

主要接口：

```text
POST /api/v1/presentations/import
GET  /api/v1/presentations/{id}/slides
POST /api/v1/presentations/{id}/assets
POST /api/v1/presentations/{id}/patches
POST /api/v1/ppt-patches/{patch_id}/simulate
POST /api/v1/ppt-patches/{patch_id}/confirm
POST /api/v1/ppt-patches/{patch_id}/cancel
GET  /api/v1/ppt-jobs/{patch_id}/events
GET  /api/v1/presentations/{id}/versions/{version_id}/download
POST /api/v1/presentations/{id}/versions/{version_id}/restore
```

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

## Windows 安装包

Windows 版不需要用户安装 Node.js 或 Python。程序安装后会启动本地 Flask 服务，并通过 Windows Edge WebView2 在独立应用窗口中显示界面，不会打开默认浏览器；关闭应用窗口会停止服务。Windows 10/11 通常已自带 WebView2 Runtime，如启动时提示缺少 WebView2，再安装 Microsoft Edge WebView2 Runtime 即可。

运行时数据不会写入安装目录，而是保存在 `%LOCALAPPDATA%\EdgeOffice\artifacts\`：SQLite 数据库在 `data/`，FAISS 索引在 `indexes/`，模型在 `models/`。卸载程序不会删除这些用户材料。

GGUF 模型单独从 GitHub Releases 下载，避免让安装包额外增加约 812 MB。模型不可用时，应用顶部会显示“下载本地模型”按钮；点击后 Flask 只会从 `liangyanlun/edge-office` 的已配置 Release 下载，完成 SHA-256 校验后自动写入：

```text
%LOCALAPPDATA%\EdgeOffice\artifacts\models\qwen3_5_0p8_office_q8_0\
```

Release 至少需要上传同名 GGUF 资源 `Qwen3.5-0.8B-office.Q8_0.gguf`，并附带 `release.manifest.json` 或 `Qwen3.5-0.8B-office.Q8_0.SHA256SUMS.txt`（也兼容标准名 `SHA256SUMS.txt`）。发布清单优先校验文件名、SHA-256、量化格式、2048 上下文和验收状态；校验文件须包含一行 `SHA256<两个空格>文件名`，用于严格验证 GGUF 文件完整性。开发环境要求至少提供其中一种校验元数据。

`release.manifest.json` 示例：

```json
{
  "schema": "edge_office_model_release_v1",
  "model_file": "Qwen3.5-0.8B-office.Q8_0.gguf",
  "sha256": "GGUF 文件的 64 位 SHA-256",
  "quantization": "Q8_0",
  "context_length": 2048,
  "acceptance_passed": true
}
```

默认固定下载已验证的 `v0.1.0` Release，避免首次下载受 GitHub 匿名 API 限流影响；维护者可通过 `MODEL_RELEASE_TAG` 覆盖目标标签。`MODEL_RELEASE_REPOSITORY` 默认是 `liangyanlun/edge-office`，浏览器端不接受自定义下载链接或保存路径。

### 4B 模型入口（开发中）

工作台首页的“模型中心”已经预留 `Qwen3.5 Office 4B` 入口，固定指向 [v0.2.0-4b Release](https://github.com/liangyanlun/edge-office/releases/tag/v0.2.0-4b)。当前 Release 只有开发说明，没有 GGUF 文件，因此软件会显示“开发中”并禁止下载，避免误报 404 或安装不完整模型。模型完成验收后，将 `Qwen3.5-4B-office.Q4_K_M.gguf`、`release.manifest.json` 和同名 `SHA256SUMS.txt` 上传到该 Release，并在受控配置中设置 `MODEL_4B_DOWNLOAD_ENABLED=true`，入口即可启用固定地址下载和 SHA-256 校验。4B 文件会保存到 `artifacts/models/qwen3_5_4b_office_q4_k_m/`，不会覆盖 0.8B 模型。

维护者在已安装 Inno Setup 6 的 Windows 环境运行：

```powershell
.\packaging\build.ps1
```

当前安装包脚本仍标记 `v0.1.2`，输出 `dist-installer\EdgeOffice-Setup-v0.1.2.exe`；本次源码更新未重新打包。仅生成便携版可执行目录时运行 `.\packaging\build.ps1 -SkipInstaller`。

## 手机访问与 PWA

当前推荐的移动路线是“PWA + 可选 Capacitor 外壳”：手机复用本项目的 Web UI，Flask 继续负责 RAG、Agent 和 PPT 执行，避免在手机端复制 Office 文件修改逻辑。`public/manifest.webmanifest`、`public/sw.js` 和 `public/icon.svg` 提供可安装的应用壳；Service Worker 只缓存静态界面，不缓存 API、原始材料或模型。

默认仍只监听回环地址。若需要让同一 Wi-Fi 下的手机访问电脑服务，应显式配置配对模式：

```powershell
$env:EDGE_OFFICE_MODE="lan"
$env:EDGE_OFFICE_HOST="0.0.0.0"
$env:EDGE_OFFICE_PAIRING_CODE="至少 12 位的一次性配对码"
$env:EDGE_OFFICE_PAIRING_SECRET="至少 32 位的随机签名密钥"
python run_flask.py
```

手机先调用 `POST /api/v1/mobile/pair` 完成配对，再使用现有的相对 `/api/v1` 接口。能力探测使用 `GET /api/v1/mobile/bootstrap`；其中会明确返回 RAG、Agent、PPT、流式输出和当前模型是否适合 PPT。上传可以使用 `POST /api/v1/uploads/init`、`PUT /api/v1/uploads/{id}/parts/{n}` 和 `POST /api/v1/uploads/{id}/complete` 进行分片上传，合并完成后将 `uploadId` 提交给 `POST /api/v1/documents/import` 即可进入现有解析和 FAISS 索引流程。

生产环境不要把 Flask 开发服务器直接暴露到公网，应使用正式 WSGI 服务、HTTPS、设备撤销和反向代理；局域网模式也不应省略配对和来源校验。
在 `127.0.0.1` 或 HTTPS 地址下浏览器可以安装 PWA；普通局域网 HTTP 地址通常只能作为网页访问，若要显示“安装到手机”，请为局域网服务配置 HTTPS。

## Capacitor 手机 App

项目已生成 `android/` 和 `ios/` 原生工程。Capacitor 外壳复用 `public/` 的移动界面，手机端通过构建时的 `EDGE_OFFICE_SERVER_URL` 连接云端或局域网 Flask 服务，不把 RAG、FAISS、SQLite 或 PPT 执行器复制到手机。

```powershell
$env:EDGE_OFFICE_SERVER_URL="https://你的服务地址"
npx cap sync
npx cap open android
```

也可以直接执行 `npm run mobile:sync`。Android 构建需要 Android Studio/SDK；iOS 构建必须在 macOS + Xcode 上完成。没有设置 `EDGE_OFFICE_SERVER_URL` 时，App 会在首次启动时要求用户输入后端地址。

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

- 模型包放在 [artifacts/models/README.md](artifacts/models/README.md) 定义的位置，绝不放到 `public/`；
- 默认 RAG 嵌入模型为本地 `artifacts/models/bge-small-zh-v1.5`。它使用 `BAAI/bge-small-zh-v1.5` 的中文检索指令，生成 512 维归一化向量；模型卡说明它适用于中文检索，权重约 96MB。[模型卡](https://huggingface.co/BAAI/bge-small-zh-v1.5)
- 若克隆项目后缺少该模型，联网执行 `python scripts/download_rag_model.py` 下载一次；运行时不会联网下载，缺失时会明确降级到哈希向量，仅用于演示。
- RAG 先以 FAISS 与 BM25 各自召回候选，再结合句子级词项覆盖度重排序；最终只将 1～2 条紧凑证据输入 0.8B 模型，减少上下文和幻觉风险。
- 设置 `RAG_EMBEDDING_MODEL` 可替换本地 SentenceTransformer 路径；`RAG_QUERY_INSTRUCTION`、`RAG_TOP_K` 和 `RAG_CANDIDATE_K` 可用于研究对比实验。
- `RAG_RERANK_K`（默认 5）控制重排序候选证据数，最终最多注入 4 个证据块；`RAG_EVIDENCE_TOKEN_BUDGET`（默认 900）对注入上下文执行保守 token 预算。`RAG_MIN_CONFIDENCE`（默认 0.42）控制拒答阈值，`RAG_ALLOWED_SECURITY_LEVELS`（默认 `public,internal`）控制本地会话允许检索的材料级别。
- 浏览器通过 `POST /api/v1/documents/import` 上传本地 TXT、Markdown、PDF、DOCX、XLSX、CSV、PPTX 或 HTML。后端按扩展名白名单解析、限制 20MB 原始文件与 20 万字符解析文本，并记录原始文件 SHA256、MIME 类型、解析器版本、抽取质量和结构统计；不会接受宏格式、任意压缩包或可执行内容。
- 扫描 PDF 使用内置 RapidOCR + ONNX Runtime 离线识别，只处理没有原生文本的页面；默认最多 30 个 OCR 页面。低置信度结果会在知识库页面标记“需复核”，任一扫描页完全无法识别时整份文件拒绝导入，不会污染已有索引。
- XLSX 默认限制 30 个工作表、每表 5000 行、100 列；PPTX 默认限制 300 页。Office 文件在解析前检查内部路径、文件数、展开体积和异常压缩比例。
- 可用 `OCR_ENABLED=false` 关闭 OCR；`MAX_OCR_PAGES`、`MAX_XLSX_ROWS_PER_SHEET`、`MAX_XLSX_COLUMNS` 和 `MAX_PPTX_SLIDES` 可调整资源上限。纯图片 PPT 页面暂不做 OCR，真实用户权限和原文件留存策略仍待完善。
- 默认生成模型为 `artifacts/models/qwen3_0p8_gguf/Qwen3.5-0.8B.q3_k_l.gguf`；Flask 会通过 `llama-cpp-python` 在本进程中加载它，并将 FAISS 检索证据直接传入模型生成回答；
- 正式运行默认加载 `Qwen3.5-0.8B.Q4_K_M.gguf`，固定 `LLAMA_N_CTX=2048`。`LLAMA_RELEASE_MANIFEST` 必须绑定模型 SHA256、Q4_K_M/Q8_0/F16 格式和已通过的验收；只有显式设置 `LLAMA_RELEASE_REQUIRED=false` 才允许开发环境绕过。可通过 `LLAMA_N_THREADS` 和 `LLAMA_N_GPU_LAYERS` 调整 CPU 线程和 GPU 卸载层数；设置 `LLAMA_CPP_ENABLED=false` 可关闭真实推理并使用安全兜底；
- Agent 每轮只规划一个固定动作。模型输出受到 llama.cpp JSON Grammar 约束，并会被服务端以严格 JSON、字段、类型、大小、路径和权限策略再次校验；模型写出的 `confirmed:true` 一律拒绝。
- 高风险动作（发送邮件、删除待办、覆盖文件；日程提交仅在内部实验模式下）必须由用户在计划卡中显式确认。确认绑定本地浏览器会话、计划哈希、策略版本、过期时间与一次性 nonce；nonce 只保存在 Flask 进程内，不下发浏览器，参数变化、进程重启、过期或重放都会失效。
- 可通过 `GET /api/v1/agent/tools` 查看固定动作表；新计划 API 为 `POST /api/v1/plans`、`GET /api/v1/plans/{id}`、`POST /api/v1/plans/{id}/confirm`、`POST /api/v1/plans/{id}/cancel` 与 `GET /api/v1/audit/{requestId}`。
- 审计接口返回输入/模型输出哈希、模型与策略版本、规范化计划、检索索引与证据 ID、确认生命周期、幂等工具尝试、脱敏结果和耗时；不返回 nonce、邮件正文或文档正文。
- 正式 RAG 验收还需在本机准备至少 100 条人工审核问题；每条必须记录真实 `document_id/version_id/chunk_id`（无证据题必须为空），并按文档版本设置隔离组。运行 `python scripts/validate_local_rag_eval.py --input <本地评测.jsonl> --output <不可覆盖验证报告.json>`；该文件包含用户本地知识，只留在本机，不同步到训练服务器。
- 当前不暴露 Shell、任意 Python、任意 URL、任意 SQL 或真实外部发送；高风险动作只进行本地沙箱演练，后续接入真实服务仍需单独授权与连接器审查。
- 运行 `python scripts/evaluate_agent_plans.py --model <GGUF路径> --output <报告路径>` 可复现本地 ActionPlan 基线评测；当前基线结论见 [Agent评测报告](Agent评测报告.md)，尚未达到正式模型验收门槛。

## 旧版 Node 回退

```powershell
npm run start:node
```

接口事件、页面信息架构与指标字段已按 [前后端开发详细方案](前后端开发详细方案.md) 的方向设计，因此后续替换实现时不需要重做页面流程。
