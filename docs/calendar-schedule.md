# 日程实验模块（首发默认关闭）

## 当前能力

首发版不提供独立日历：界面不显示日程工具，Agent 不创建或提交日程，查询接口返回 `FEATURE_UNAVAILABLE`。会议纪要中的时间节点仍可作为文字整理。以前保存的本地事件和实验代码保留，不删除或迁移。当前不连接 Outlook、Google Calendar 或其他外部日历。

开发测试时可显式设置 `EDGE_OFFICE_CALENDAR_EXPERIMENTAL=true` 并重启 Flask 服务，恢复以下实验接口和工具；此开关不应作为首发版本的用户操作说明。默认时区为 `Asia/Shanghai`，可通过 `EDGE_OFFICE_TIMEZONE` 覆盖。

仅在实验模式下，可以输入：

```text
明天早上八点开会，时长 60 分钟
```

系统会将“明天”和“早上八点”在后端确定性解析为带时区的 ISO 时间，并生成日程草稿。日期计算、时区和冲突判断不交给小模型自由推理。

实验模式下检查本地日程：

```text
检查明天日程有没有冲突
```

也可以调用只读接口：

```text
GET /api/v1/calendar/events?date=明天
GET /api/v1/calendar/conflicts?start=2026-09-25T00:00:00+08:00&end=2026-09-26T00:00:00+08:00
```

## 安全边界

- `calendar_create_draft` 只生成草稿，不写入外部日历。
- `calendar_find_slots` 只读取本地 `calendar_events` 表。
- `calendar_commit` 属于高风险动作，必须先展示计划并由用户确认；即使确认，也只保存到本地沙箱。
- 时间缺失、非法日期、无效时区会进入澄清，不允许模型猜测。

## 运行时实现

1. `backend/schedule.py` 负责中文相对日期、时间和时长解析。
2. `backend/database.py` 保存本地事件并使用区间相交规则检测冲突。
3. `backend/agent.py` 先用确定性意图门控选择日程工具，再绑定后端解析出的时间字段。
4. `backend/app.py` 暴露事件查询和冲突查询接口。

0.8B 模型只负责提出草稿或补充问题。即使将来切换到 4B，日期归一化、冲突检测、权限和确认仍由服务端执行。
