"""Versioned, fail-closed PowerPoint editing runtime."""

from .routes import create_ppt_blueprint
from .service import PptService

__all__ = ["PptService", "create_ppt_blueprint"]
