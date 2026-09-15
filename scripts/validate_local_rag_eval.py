"""Validate a local, human-reviewed, document-version-isolated RAG evaluation set."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise ValueError(message)


def validate(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        fail("input must be a regular local JSONL file")
    question_ids: set[str] = set()
    version_groups: set[str] = set()
    records = 0
    for line_number, raw in enumerate(path.read_bytes().splitlines(), 1):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            fail(f"invalid standard JSON at line {line_number}: {error}")
        if not isinstance(row, dict) or set(row) - {
            "question_id", "question", "answerable", "expected_answer", "evidence",
            "human_reviewed", "version_isolation_group", "review_notes",
        }:
            fail(f"unknown or invalid fields at line {line_number}")
        question_id, question = row.get("question_id"), row.get("question")
        if not isinstance(question_id, str) or not question_id or question_id in question_ids:
            fail(f"question_id must be unique at line {line_number}")
        if not isinstance(question, str) or not question.strip() or len(question) > 2000:
            fail(f"question must be non-empty and bounded at line {line_number}")
        if row.get("human_reviewed") is not True or type(row.get("answerable")) is not bool:
            fail(f"human_reviewed=true and boolean answerable are required at line {line_number}")
        group = row.get("version_isolation_group")
        if not isinstance(group, str) or not group.strip():
            fail(f"version_isolation_group is required at line {line_number}")
        evidence = row.get("evidence")
        if not isinstance(evidence, list):
            fail(f"evidence must be a list at line {line_number}")
        if row["answerable"] and (not evidence or not isinstance(row.get("expected_answer"), str) or not row["expected_answer"].strip()):
            fail(f"answerable questions require an answer and evidence at line {line_number}")
        if not row["answerable"] and evidence:
            fail(f"unanswerable questions must not declare evidence at line {line_number}")
        for item in evidence:
            if not isinstance(item, dict) or set(item) != {"document_id", "version_id", "chunk_id"}:
                fail(f"evidence requires exact document/version/chunk IDs at line {line_number}")
            if any(not isinstance(item[key], str) or not item[key].strip() for key in item):
                fail(f"evidence IDs must be non-empty strings at line {line_number}")
        question_ids.add(question_id)
        version_groups.add(group)
        records += 1
    if records < 100:
        fail(f"at least 100 human-reviewed questions are required, got {records}")
    return {
        "schema": "local_rag_eval_validation_v1",
        "input": str(path.resolve()),
        "input_sha256": sha256(path),
        "records": records,
        "human_reviewed": records,
        "version_isolation_groups": len(version_groups),
        "passed": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        source, output = Path(args.input).resolve(), Path(args.output).resolve()
        if output.exists() or output.is_symlink():
            fail(f"refusing to overwrite validation report: {output}")
        result = validate(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, ValueError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 3
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
