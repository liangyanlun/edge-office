# 2026-09-30 模型运行与下载修复

本轮只修改应用运行时，不修改训练代码、GGUF 权重或用户模型选择文件。修复纳入 2026-10-01 的 Windows `v0.2.0-preview.3` 与 Android `0.2.0-dev.20261001.1` 本机试用构建；尚未公开发行到 GitHub Release。

## 问题与修正

- 4B PPT-SFT 在通用 RAG 问答中复述材料，256 token 截断后降级成原文摘录。即使关闭思考并提高到 512，它仍会复述证据标题并被守卫拒绝，不能声称仅提高预算已修好 4B 的通用能力。
- （历史路由，已在 2026-10-01.2 修正）普通问答、写作和通用 Agent 曾明确使用 0.8B；当前选中的 4B 当时只保留给 PPT 工作区。现已改为全局模型选择：选中哪个已校验模型，界面、SSE、已保存回答和 PPT Planner 均使用哪个模型。
- 右上角区分“模型已安装 · 首次使用会加载”与“模型运行中”。原文兜底显示安全失败原因：截断、答案被拒绝、模型缺失、校验失败、加载失败或推理失败。底层异常的路径和细节不进入回答指标。
- 默认下载来源优先已核验 ModelScope；GitHub 保持手动可选，不偷偷切换来源。已安装模型仍显示来源选择和“打开国内镜像”，GitHub 按钮明确标注名称。固定来源、分片合并、内置 SHA-256 与主机白名单不放宽。

## 2048 与输出预算

当前运行时仍使用 2048 总上下文。训练中的序列总长与单独的生成额度不是同一个参数；训练具体配置仍以训练工程为准。

普通回答的目标输出为 1024 token。Qwen 模板可用时先渲染相同的禁用思考模板，再用实际 tokenizer 计算：

```text
输出预算 = min(1024, 2048 - 实际模板输入 token - 32)
```

例如输入 783 token 时仍可分配 1024；输入 1500 token 时只能分配 516。剩余空间不足 32 token 时明确要求缩短问题/减少材料，不用字符数代替 token 数。其他自定义格式继续受 llama-cpp-python 原生上下文限制。模型正常结束就立即停止，不会为了耗尽预算而填充内容。

Android JNI 使用相同 2048 总上下文/1024 目标额度，按其真实 tokenizer 输入数限制输出，并传回真实停止原因。Agent 的 96 token 结构化计划与 PPT 的专用计划预算不随普通回答额度一起扩大。

若以后需要可靠地生成 2048 token 正文，需要先为输入预留额外空间，调整运行上下文、发布清单和评测，而不是仅将输出参数改成 2048。

## 验证与边界

- `python -m pytest tests_py`：71 项通过，测试数据库/索引均使用临时目录。
- `npm test`：14 项通过（新增静态资源白名单测试）。
- `node --check public/app.js` 与 `node --check public/offline-runtime.js`：通过。
- `npm run mobile:sync`：成功同步移动端静态资源。
- Android `:app:assembleDebug --no-daemon --offline`：Java/JNI 联合编译通过；未完成手机真机验收。
- 只读复测同一历史问题：本地 0.8B 输入 712 token，输出 160 token，约 5.5 秒，正常停止并通过现有答案格式检查；未写入测试对话。这不是完整 RAG 正确率评测。
- 正在运行的已安装 Windows App 使用冻结源码，不会因为工作区文件变化自动更新；需重新打包安装后生效。已有历史答案不会自动重写。
- Windows 与移动端打包仅复制白名单应用资源；原始 `public/` 中无关的 HTML、测试文件和模型不被复制，原文件不删除。软件升级不清空用户运行目录。

## 2026-10-01 模型选择语义修正

此前运行时把 4B 选择保留给 PPT，并在普通对话中另开 0.8B；这与用户对“选择模型”的直觉不一致。现在选择已校验的 4B 后，Windows Flask 的聊天、RAG、Agent 和 PPT Planner 共用同一个 4B `InferenceAdapter`；Android 离线插件的普通推理也使用当前激活模型。选择 0.8B 时所有入口统一使用 0.8B。手机 PPT 编辑仍未开放，此修改不新增该功能。SSE `modelName`、运行状态、模型卡 capability 和失败提示同步反映实际模型。4B 仍要求用户核对生成内容、PPT 预览和引用，模型选择不会跳过服务端验证。

- 回归：71 项 Python 测试与 14 项 Node 测试通过。新增断言覆盖 4B 选中后 Agent/PPT 共用 adapter、SSE 记录 4B、无需额外安装 0.8B，以及 4B 已加载时下载未激活的 0.8B 不会刷新或替换当前模型。
- Windows preview.4 便携程序在隔离 `build/smoke-preview4` 目录启动；通过环境指定现有 4B 与 SHA 文件只读验证，不更改个人模型选择。普通问答实际 `modelName=Qwen3.5-4B-PPT.Q4_K_M`、`answerKind=generated`，74 个输入 token / 18 个输出 token，生成阶段 2143ms（约 8.4 token/s），包含首次模型加载的端到端耗时约 13.6 秒。运行状态与 PPT Planner 的模型名一致。这只验证模型路由与本机推理，不代表全面回答质量评测。
- Windows 切换仍通过固定 ID 和完整 SHA-256 校验，重启生效；Android 激活后下一次推理使用所选文件。原件保护、PPT 确认和执行验证保持不变。新构建需重新安装；旧回答的模型记录不回写。
- 最终安装包：Windows `dist-installer/EdgeOffice-Setup-v0.2.0-preview.4.exe`，Android `dist-mobile/EdgeOffice-Android-offline-debug-v0.2.0-dev.20261001.2.apk`（versionCode 10）；均成功编译。Windows 最终静态资源白名单 13 个文件，Android 除桥接文件外同样只包含应用资源；未包含数据库、材料或 GGUF 模型。模型权重与旧版本安装包保留。SHA-256 分别记录在 `dist-installer/SHA256SUMS-v0.2.0-preview.4.txt` 与 `dist-mobile/SHA256SUMS-offline.txt`。Windows 未签名、Android 为调试签名；未执行安装向导或手机真机验收。本轮未上传 GitHub。

## 2026-10-01 preview.3 打包验证（历史版本）

- Windows 便携程序在独立 `build/smoke-preview3` 数据目录启动；首次启动无材料与对话，默认下载源为 ModelScope。只读使用已有 0.8B GGUF 与校验文件，74 个输入 token / 14 个输出 token，正常停止，生成阶段 534ms，界面指标为实际模型名与 `generated`，加载后状态转为 `llama-cpp-ready`。未更改现有用户运行目录。这是安装内容的冒烟测试，不是安装向导或全部功能验收。
- Android APK：`dist-mobile/EdgeOffice-Android-offline-debug-v0.2.0-dev.20261001.1.apk`，versionCode 9、minSdk 24、arm64-v8a。包含本地 JNI 推理库，不包含模型、数据库或材料；Capacitor 配置无 `server.url`，不是连接电脑服务的客户端。Debug 签名，未进行手机真机验收。
- 两个平台的最终静态资源均仅含应用白名单文件（Android 额外生成两个空 Cordova 桥接文件），不包含原 `public/chongqing-8d.html`；该原文件仍保留在工作区。
- Windows 安装包：`dist-installer/EdgeOffice-Setup-v0.2.0-preview.3.exe`，Inno Setup 编译成功，未签名、未执行安装向导验收。旧版本安装包保留。
- 校验记录：Android 位于 `dist-mobile/SHA256SUMS-offline.txt`；Windows 位于 `dist-installer/SHA256SUMS-v0.2.0-preview.3.txt`。此次只构建本机试用包，没有上传源码或 GitHub Release。
