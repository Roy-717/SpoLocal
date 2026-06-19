"""Normalize cover images into square JPEG thumbnails.

Performs center crop and resize for consistent artwork dimensions.
Used by playlist and player cover rendering."""

from __future__ import annotations

import io
from typing import Optional

from PIL import Image

# Shared defaults for playlist tiles, player art, queue thumbs, and on-disk cache filenames.
DEFAULT_THUMB_MAX_SIDE = 128
DEFAULT_JPEG_QUALITY = 68


def square_thumb_jpeg(
    raw: bytes,
    *,
    max_side: int = DEFAULT_THUMB_MAX_SIDE,
    quality: int = DEFAULT_JPEG_QUALITY,
) -> Optional[bytes]:
    """
    Center-crop to square and resize to max_side. Fixes letterboxed YouTube thumbs and odd embeds.
    Returns JPEG bytes, or None if input cannot be decoded.
    """
    if not raw:
        return None
    try:
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        w, h = im.size
        if w < 1 or h < 1:
            return None
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        im = im.crop((left, top, left + side, top + side))
        im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=quality, optimize=True)
        return out.getvalue()
    except Exception:
        return None
