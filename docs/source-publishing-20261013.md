# 2026-10-13 源码发布记录

目标：`liangyanlun/edge-office`，`main` 分支；开发版本 `0.2.0-dev.20261013`。
保留历史，普通追加提交，不覆盖远程分支。此记录不表示安装包或模型 Release 更新。

## 包含

Flask 后端、网页/桌面共享界面、Android 离线运行时/JNI、手机 PPT 执行器与文件解析、模型目录选择、固定模型镜像来源、构建脚本、测试和文档。手机原生构建依赖的 llama.cpp 核心源代码及许可证随源码保留；训练数据和权重不在此仓库。

## 排除

个人对话、材料原件、SQLite/FAISS 索引、模型权重、缓存、密钥、签名文件、个人环境配置、Windows/Android 安装包、测试截图/日志、无关旅行网页。文件保留在本机，只是禁止进入本次提交。源代码中的合成测试数据不属于个人材料。

## 发布前检查

- 暂存树文件类别与凭据模式扫描通过（`node scripts/audit-source-index.mjs`）。自动扫描不能替代后续安全审查。
- `npm test`：17 passed。
- `python -m pytest tests_py -q`：77 passed，1 skipped；真实 Office 测试需显式本机启用。
- 仅导出暂存文件的干净副本，Android arm64 / API 24 的 CMake configure、generate 通过，未依赖未上传的 llama.cpp demo 或权重。
- 源码换行规范化后，项目文件的 staged diff whitespace 检查通过；第三方源代码保持原有样式。

## 获取后

先创建 Python 虚拟环境、安装 requirements、执行 `npm ci` 和 `npm run mobile:parser`；然后可运行 Flask。Android 另需 JDK 21、SDK、NDK 与 CMake，执行 `npm run mobile:sync` 再构建。模型在应用中单独下载。具体命令和能力边界见 README。

手机结构预览不是原版 PowerPoint 渲染；Android 真机、正式签名、4B 专项质量与 100 份真实 PPTX 验收仍未完成。
