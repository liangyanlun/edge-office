# 本地 Agent ActionPlan 评测报告

评测日期：2026-08-19（本机离线）

## 测试对象与边界

- 模型：`Qwen3.5-0.8B.q3_k_l.gguf`，SHA256 `e038dfb2b15c528bcf91454c13f4fa27b7761fc8dd07d2954702578e6df42b42`。
- 这是当前已有的基线 GGUF，不是项目训练完成的 Qwen3-0.6B，不能替代后者的训练或验收成绩。
- 13 条合成办公指令，覆盖检索、引用、日程、待办、邮件草稿与高风险操作。
- 评测只测模型产生 ActionPlan；不会联网，也不会调用真实邮箱、日历、待办或文件系统。

## 结果对比

| 方案 | 严格 JSON | 工具正确 | 必填参数 | 平均规划耗时 |
| --- | ---: | ---: | ---: | ---: |
| 通用 `arguments` Grammar | 0.0% | 0.0% | 0.0% | 6.90 s |
| 工具专属封闭 Schema | 92.3% | 38.5% | 61.5% | 3.46 s |
| 可信意图门控 + 封闭 Schema | 92.3% | 92.3% | 92.3% | 2.42 s |

完整可复现记录位于：

- [基线](</F:/大创前端代码/artifacts/evaluations/agent_plan_qwen3_0p8_baseline.json>)
- [封闭 Schema](</F:/大创前端代码/artifacts/evaluations/agent_plan_qwen3_0p8_closed_schema.json>)
- [门控优化版](</F:/大创前端代码/artifacts/evaluations/agent_plan_qwen3_0p8_optimized.json>)

## 当前最优实现

运行时采用“确定性意图门控 → 单一候选工具的封闭 JSON Grammar → 严格解析与策略校验 → 失败时确定性安全回退”。这适合 0.8B 量级本地模型：小模型只负责补全必要参数，不能扩大工具范围，也不能确认操作。

高风险动作始终需要服务端确认，且确认绑定计划哈希、用户、策略版本、过期时间与一次性 nonce。模型输出不合格时不会执行工具，只会走安全回退或请求补充信息。

## 结论与下一步

该基线模型尚未达到 Agent 验收要求（严格 JSON >= 99.5%、正确工具 >= 92%、必填参数 >= 90%）。门控后的工具与参数指标达到 92.3%，但仍有 1 条格式截断，不能宣称通过。

下一步应将训练完成的 Qwen3-0.6B GGUF 放入 `artifacts/models/qwen3_0p6b/`，用 `DC_model/data/eval/v3/phase1_agent_eval.jsonl` 的冻结集执行同一评测脚本，并保留模型、量化和评测哈希；只有达标后才替换默认模型。
