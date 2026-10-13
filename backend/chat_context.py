"""User-selected scope is trusted request context, never a model permission."""
from .agent import PlanValidationError

READ_TASKS = {"summary", "compare", "quote", "outline", "tasks"}
WRITE_TASKS = {"email", "polish", "minutes", "rewrite"}

def chat_context(payload, database):
    task = payload.get("task")
    if task is not None and (not isinstance(task, str) or task not in READ_TASKS | WRITE_TASKS):
        raise PlanValidationError("INVALID_TASK", "该任务暂不支持，请重新选择")
    ids = payload.get("documentIds")
    if ids is not None:
        if not isinstance(ids, list) or not ids or len(ids) > 8 or any(not isinstance(item, str) or not item or len(item) > 100 for item in ids):
            raise PlanValidationError("INVALID_DOCUMENT_SCOPE", "请选取 1 至 8 份材料，或选择全部材料")
        ids = list(dict.fromkeys(ids))
        if any(database.get_document(item) is None for item in ids):
            raise PlanValidationError("DOCUMENT_SCOPE_EXPIRED", "所选材料已被移除，请重新选择材料后发送")
    if task == "compare" and (ids is None or len(ids) != 2):
        raise PlanValidationError("COMPARE_SCOPE_REQUIRED", "请明确选择要对比的两份材料")
    rag_enabled = payload.get("ragEnabled") is not False
    if task in WRITE_TASKS:
        rag_enabled = False
    elif task in READ_TASKS:
        rag_enabled = True
    return task, ids, rag_enabled
