from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


def render_presentation(pptx_path: Path, output_dir: Path, allow_external: bool = True) -> dict[str, Any]:
    """Render previews with Office in an isolated process, then degrade safely."""
    output_dir.mkdir(parents=True, exist_ok=True)
    for old in output_dir.glob("slide-*.png"):
        old.unlink(missing_ok=True)
    if allow_external and os.name == "nt" and _render_with_powerpoint_worker(pptx_path, output_dir):
        return {"mode": "powerpoint-com-worker", "approximate": False, "count": len(list(output_dir.glob("slide-*.png")))}
    if allow_external and _render_with_libreoffice(pptx_path, output_dir):
        return {"mode": "libreoffice", "approximate": False, "count": len(list(output_dir.glob("slide-*.png")))}
    count = _render_approximate(pptx_path, output_dir)
    return {"mode": "safe-layout-preview", "approximate": True, "count": count}


def _render_with_powerpoint_worker(pptx_path: Path, output_dir: Path) -> bool:
    executable = shutil.which("powershell") or shutil.which("pwsh")
    if not executable:
        return False
    script = r"""
$ErrorActionPreference='Stop'
$inputPath=[IO.Path]::GetFullPath($args[0]); $outputPath=[IO.Path]::GetFullPath($args[1])
$ppt=$null; $deck=$null
try {
  $ppt=New-Object -ComObject PowerPoint.Application
  $deck=$ppt.Presentations.Open($inputPath,$true,$true,$false)
  foreach($slide in $deck.Slides) { $slide.Export((Join-Path $outputPath ("slide-{0}.png" -f $slide.SlideIndex)),"PNG",1280,720) }
} finally { if($deck){$deck.Close()}; if($ppt){$ppt.Quit()} }
"""
    try:
        result = subprocess.run(
            [executable, "-NoProfile", "-NonInteractive", "-Command", script, str(pptx_path), str(output_dir)],
            capture_output=True, timeout=90, check=False,
        )
        return result.returncode == 0 and bool(list(output_dir.glob("slide-*.png")))
    except (OSError, subprocess.SubprocessError):
        return False


def _render_with_libreoffice(pptx_path: Path, output_dir: Path) -> bool:
    executable = shutil.which("soffice") or shutil.which("libreoffice")
    if not executable:
        return False
    try:
        import pypdfium2 as pdfium
        with tempfile.TemporaryDirectory(prefix="edge-office-ppt-") as temp:
            result = subprocess.run(
                [executable, "--headless", "--convert-to", "pdf", "--outdir", temp, str(pptx_path)],
                capture_output=True, timeout=90, check=False,
            )
            pdf_path = Path(temp) / f"{pptx_path.stem}.pdf"
            if result.returncode != 0 or not pdf_path.is_file():
                return False
            document = pdfium.PdfDocument(str(pdf_path))
            for index, page in enumerate(document):
                page.render(scale=1.5).to_pil().convert("RGB").save(output_dir / f"slide-{index + 1}.png")
        return bool(list(output_dir.glob("slide-*.png")))
    except Exception:
        return False


def _render_approximate(pptx_path: Path, output_dir: Path) -> int:
    presentation = Presentation(str(pptx_path))
    width, height = 1280, 720
    font = ImageFont.load_default()
    for index, slide in enumerate(presentation.slides, start=1):
        image = Image.new("RGB", (width, height), "white")
        draw = ImageDraw.Draw(image)
        for shape in slide.shapes:
            left = round(shape.left / presentation.slide_width * width)
            top = round(shape.top / presentation.slide_height * height)
            right = round((shape.left + shape.width) / presentation.slide_width * width)
            bottom = round((shape.top + shape.height) / presentation.slide_height * height)
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    with Image.open(__import__("io").BytesIO(shape.image.blob)) as source:
                        source.thumbnail((max(1, right - left), max(1, bottom - top)))
                        image.paste(source.convert("RGB"), (left, top))
                except Exception:
                    draw.rectangle((left, top, right, bottom), outline="#98a5b5", width=2)
            elif getattr(shape, "has_text_frame", False):
                text = shape.text.strip()
                if text:
                    draw.multiline_text((left + 4, top + 4), text[:600], fill="#1f2c3d", font=font, spacing=5)
            else:
                draw.rectangle((left, top, right, bottom), outline="#d9dfe7", width=1)
        draw.text((12, 694), f"Layout preview · Slide {index}", fill="#8995a5", font=font)
        image.save(output_dir / f"slide-{index}.png")
    return len(presentation.slides)
