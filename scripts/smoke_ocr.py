"""Create an in-memory scanned PDF and verify the fully local OCR pipeline."""
from __future__ import annotations

import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from backend.parsers import parse_upload


def main() -> int:
    image = Image.new("RGB", (1600, 500), "white")
    draw = ImageDraw.Draw(image)
    font_path = Path("C:/Windows/Fonts/arial.ttf")
    font = ImageFont.truetype(str(font_path), 92) if font_path.is_file() else ImageFont.load_default()
    draw.text((80, 150), "PROJECT DEADLINE FRIDAY", fill="black", font=font)
    payload = io.BytesIO()
    image.save(payload, format="PDF", resolution=150)
    image.close()
    parsed = parse_upload("ocr-smoke.pdf", payload.getvalue(), 20_000, ocr_enabled=True, max_ocr_pages=2)
    print(json.dumps({
        "parser": parsed.parser_name,
        "quality": parsed.extraction_quality,
        "metadata": parsed.metadata,
        "containsExpectedText": "PROJECT" in parsed.content.upper() and "FRIDAY" in parsed.content.upper(),
    }, ensure_ascii=False))
    return 0 if "PROJECT" in parsed.content.upper() and "FRIDAY" in parsed.content.upper() else 1


if __name__ == "__main__":
    raise SystemExit(main())
