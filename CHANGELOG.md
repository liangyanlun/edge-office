# Edge Office 版本记录

版本号按发布物分别解释：模型 Release、Windows 安装包和应用源码不是同一个版本线。只有存在公开发行资源时才记作该平台“已发布”；GitHub 上有源码或本机有构建文件，不等于客户可下载的新应用。

| 标识 | 日期 | 类型及实际状态 | 主要变化与证据 |
| --- | --- | --- | --- |
| 未编号·初始原型 | 2026-08-20 | 源码开发基线，非发行版 | Flask、SQLite、FAISS 本地办公问答原型；commit `932e038`。 |
| 未编号·清理 | 2026-08-20 | 内部维护，非发行版 | 移除不应保留的立项原文和评测材料；commits `cf7f3de`、`3d58b6c`。 |
| 未编号·2026-09-15 开发态 | 2026-09-15 | 源码提交，非独立安装包 | RAG、Agent、运行指标与确认链路；commit `1f45cc8`。 |
| `v0.1.0`（模型） | 2026-09-15 | GitHub 正式 Release；**不是 Windows 安装包版本声明** | 0.8B Q8_0 GGUF 与 SHA256SUMS；[模型 Release](https://github.com/liangyanlun/edge-office/releases/tag/v0.1.0)。 |
| `v0.1.0`（Windows 本地构建） | 2026-09-16 | 本机安装包，公开分发未核实 | `EdgeOffice-Setup-v0.1.0.exe`；请勿和同号模型 Release 混同。 |
| `v0.1.1`（Windows 本地构建） | 2026-09-16 | 本机安装包，公开分发未核实 | `EdgeOffice-Setup-v0.1.1.exe`；非 GitHub Release。 |
| `v0.1.2`（Windows 本地构建） | 2026-09-16 | 本机安装包，公开分发未核实 | `EdgeOffice-Setup-v0.1.2.exe`，当前安装脚本版本；关联仓库提交 `cfe1c11` 为当时的源码基线，不代表本次改动已打包。 |
| `v0.2.0-4b`（模型占位） | 2026-09-24 | GitHub 预发布，**无 GGUF 资源** | [4B 模型占位 Release](https://github.com/liangyanlun/edge-office/releases/tag/v0.2.0-4b)；不能下载 4B，也不是 App 版本。 |
| `0.2.0-dev.20260925`（源码） | 2026-09-25 | GitHub `main` 开发版；**无本次 Windows/手机安装包** | PPT 编辑实验、移动端工程与访问链路、4B 模型入口、首发默认关闭日历；详见 [版本台账](outputs/edge-office-release-ledger/EdgeOffice-版本发布台账-20260925.xlsx)。 |

手机端目前只有工程与本地开发代码，尚无已验证、已公开分发的 App 安装包。网页是同一份 Flask 静态界面的本地/可部署源码，并不因此自动获得公开站点地址。发布口径见 [发布策略](docs/release-policy.md)。
