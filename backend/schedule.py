from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone as dt_timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class ScheduleParseError(ValueError):
    """Raised when a schedule request does not contain a safe, unambiguous time."""


def _zone(timezone: str) -> tzinfo:
    """Resolve a named zone on Windows even when the optional tzdata package is absent."""
    try:
        return ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        fixed_offsets = {"UTC": 0, "Asia/Shanghai": 8 * 60}
        if timezone in fixed_offsets:
            minutes = fixed_offsets[timezone]
            return dt_timezone(timedelta(minutes=minutes), name=timezone)
        raise ScheduleParseError("时区配置无效")


_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_TIME_RE = re.compile(
    r"(?P<period>凌晨|早上|上午|中午|下午|晚上)?\s*"
    r"(?P<hour>[0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})"
    r"(?:[:：](?P<minute>[0-9]{1,2})|\s*(?:点|时)(?:(?P<half>半)|(?P<minute_cn>[0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分)?)"
)
_EXPLICIT_DATE_RE = re.compile(r"(?P<month>[0-9]{1,2})\s*月\s*(?P<day>[0-9]{1,2})\s*[日号]?")
_DURATION_RE = re.compile(r"(?:时长|持续|用时)\s*(?P<minutes>[0-9]{1,3})\s*分钟")


def _cn_number(value: str) -> int:
    if value.isdigit():
        return int(value)
    if value == "十":
        return 10
    if "十" in value:
        left, right = value.split("十", 1)
        return (_CN_DIGITS.get(left, 1) * 10) + (_CN_DIGITS.get(right, 0) if right else 0)
    try:
        return int("".join(str(_CN_DIGITS[item]) for item in value))
    except (KeyError, ValueError) as exc:
        raise ScheduleParseError("无法识别时间数字") from exc


def _resolve_date(text: str, now: datetime) -> datetime.date:
    explicit = _EXPLICIT_DATE_RE.search(text)
    if explicit:
        month, day = int(explicit.group("month")), int(explicit.group("day"))
        try:
            candidate = now.replace(month=month, day=day).date()
        except ValueError as exc:
            raise ScheduleParseError("日期不存在，请检查月份和日期") from exc
        if candidate < now.date() and month != now.month:
            candidate = candidate.replace(year=now.year + 1)
        return candidate
    if "后天" in text:
        return (now + timedelta(days=2)).date()
    if "明天" in text:
        return (now + timedelta(days=1)).date()
    return now.date()


def _resolve_time(text: str) -> tuple[int, int]:
    match = _TIME_RE.search(text)
    if not match:
        raise ScheduleParseError("请补充明确的开始时间，例如‘明天 08:00’")
    hour = _cn_number(match.group("hour"))
    minute = int(match.group("minute") or 0)
    if match.group("half"):
        minute = 30
    elif match.group("minute_cn"):
        minute = _cn_number(match.group("minute_cn"))
    period = match.group("period") or ""
    if period in {"下午", "晚上"} and hour < 12:
        hour += 12
    if period == "中午" and hour < 11:
        hour += 12
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise ScheduleParseError("开始时间超出有效范围")
    return hour, minute


def _title(text: str) -> str:
    cleaned = re.sub(r"请?(?:帮我)?(?:创建|安排|新增)?(?:一个)?日程(?:草稿)?", "", text)
    cleaned = re.sub(r"^(?:提交|确认|保存)\s*", "", cleaned)
    cleaned = re.sub(r"(?:明天|后天|今天|[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*[日号]?)", "", cleaned)
    cleaned = _TIME_RE.sub("", cleaned)
    cleaned = re.sub(r"(?:时长|持续|用时)\s*[0-9]{1,3}\s*分钟", "", cleaned)
    cleaned = re.sub(r"[，,。；;：:、\s]+", " ", cleaned).strip(" ：:，,。")
    if not cleaned or cleaned in {"开会", "会议"}:
        return "会议"
    return cleaned[:120]


def parse_schedule_text(text: str, *, timezone: str = "Asia/Shanghai", now: datetime | None = None) -> dict[str, object]:
    """Normalize simple Chinese schedule language without asking the model to do date math."""
    text = str(text or "").strip()
    if not text:
        raise ScheduleParseError("日程内容不能为空")
    zone = _zone(timezone)
    current = (now or datetime.now(zone)).astimezone(zone)
    date = _resolve_date(text, current)
    hour, minute = _resolve_time(text)
    duration_match = _DURATION_RE.search(text)
    duration = int(duration_match.group("minutes")) if duration_match else 60
    if not 1 <= duration <= 24 * 60:
        raise ScheduleParseError("日程时长必须在 1 分钟到 24 小时之间")
    start = datetime(date.year, date.month, date.day, hour, minute, tzinfo=zone)
    end = start + timedelta(minutes=duration)
    return {
        "title": _title(text),
        "startAt": start.isoformat(),
        "endAt": end.isoformat(),
        "timezone": timezone,
        "durationMinutes": duration,
    }


def day_window(text: str, *, timezone: str = "Asia/Shanghai", now: datetime | None = None) -> tuple[str, str]:
    """Return an inclusive local-day window for read-only conflict checks."""
    zone = _zone(timezone)
    current = (now or datetime.now(zone)).astimezone(zone)
    date = _resolve_date(text, current)
    start = datetime(date.year, date.month, date.day, tzinfo=zone)
    return start.isoformat(), (start + timedelta(days=1)).isoformat()
