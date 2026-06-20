"""
One-off script: take the user's "mural page" folder (downloaded as a
zip and extracted under Downloads/), process every image inside each
location subfolder, upload to Supabase Storage, and create mural_tiles
rows for each location's sub-page. Layout mirrors the home-page style
(3-column masonry, ~27 % wide tiles, height proportional to source
image aspect ratio).

Run with:
    py scripts/upload_murals.py
"""

import io
import json
import mimetypes
import os
import re
import sys
import urllib.parse
import uuid
from pathlib import Path

import requests
from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass


from _env import SUPABASE_URL, SUPABASE_KEY  # noqa: E402
BUCKET = "murals"
SOURCE_ROOT = Path("C:/Users/nadel/Downloads/mural-page-extracted/mural page")

# Locations that exist in the home-page mural tiles. Only these get a
# sub-page. Folder names (case-insensitive, trimmed) -> page slug.
LOCATION_TO_FOLDER = {
    "calgary": "calgary",
    "nepal": "Nepal",
    "oregon": "Oregon",
    "portugal": "Portugal",
    "sicamous": "Sicamous",
    "sooke": "Sooke",
    "tofino": "Tofino",
    "victoria": "Victoria",
}

# Tile geometry (matches the existing home-page tiles).
COLS = [
    {"x": 11.4, "w": 25.2},
    {"x": 37.5, "w": 27.8},
    {"x": 67.5, "w": 28.0},
]
TOP_START = 5.5
ROW_GAP = 0.8

MAX_LONGEST_SIDE = 2000
JPEG_QUALITY = 86


def slugify_filename(name: str) -> str:
    """Stable, URL-safe storage filename derived from the source name."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return base.strip("-")


def natural_key(s: str):
    """Numeric-aware sort so 'Nepal 2' comes before 'Nepal 10'."""
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", s)
    ]


def process_image(path: Path) -> tuple[bytes, int, int]:
    """Returns (jpg_bytes, width, height) for an image after EXIF fix,
    HEIC handling, and resize to max 2000 px longest side."""
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.thumbnail((MAX_LONGEST_SIDE, MAX_LONGEST_SIDE), Image.LANCZOS)
        w, h = img.size
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue(), w, h


def upload_to_storage(filename: str, data: bytes, content_type: str = "image/jpeg") -> str:
    """Upload to Supabase Storage and return the public URL."""
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": content_type,
        "x-upsert": "false",
        "cache-control": "max-age=31536000",
    }
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(filename)}"
    r = requests.post(url, data=data, headers=headers)
    if r.status_code in (200, 201):
        return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{urllib.parse.quote(filename)}"
    # Already exists? Try the public URL directly.
    if r.status_code == 409:
        return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{urllib.parse.quote(filename)}"
    raise RuntimeError(f"upload failed {r.status_code}: {r.text[:200]}")


def insert_tiles(rows: list[dict]) -> None:
    """Bulk insert mural_tiles rows."""
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles"
    r = requests.post(url, headers=headers, data=json.dumps(rows))
    if r.status_code not in (200, 201):
        raise RuntimeError(f"insert failed {r.status_code}: {r.text[:300]}")


def existing_tile_count(page_slug: str) -> int:
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles?page=eq.{page_slug}&select=id"
    r = requests.get(url, headers=headers)
    if r.status_code != 200:
        return 0
    return len(r.json() or [])


def masonry_layout(image_dims: list[tuple[int, int]]) -> list[dict]:
    """Pack N tiles into 3 columns: each tile drops into the currently
    shortest column. Returns list of {x, y, w, h, order_idx} in source
    order so the caller can pair with original images."""
    col_y = [TOP_START, TOP_START, TOP_START]
    layout: list[dict] = []
    for idx, (img_w, img_h) in enumerate(image_dims):
        # Pick the shortest column.
        col_i = min(range(3), key=lambda i: col_y[i])
        col = COLS[col_i]
        tile_w = col["w"]
        tile_h = tile_w * (img_h / max(1, img_w))
        layout.append({
            "x": col["x"],
            "y": round(col_y[col_i], 3),
            "w": tile_w,
            "h": round(tile_h, 3),
            "order_idx": idx,
        })
        col_y[col_i] += tile_h + ROW_GAP
    return layout


def gather_images(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    images = []
    for p in folder.iterdir():
        if not p.is_file():
            continue
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
            images.append(p)
    images.sort(key=lambda p: natural_key(p.stem))
    return images


def process_location(slug: str, folder_name: str) -> None:
    folder = SOURCE_ROOT / folder_name
    images = gather_images(folder)
    print(f"\n=== {slug}: {len(images)} images in '{folder_name}' ===")
    if not images:
        return

    existing = existing_tile_count(slug)
    if existing > 0:
        print(f"  skip: '{slug}' already has {existing} tiles in DB. "
              f"(Delete via Supabase if you want to re-seed.)")
        return

    # First pass: process all images so we know their final aspect ratios.
    processed: list[tuple[Path, bytes, int, int]] = []
    for i, p in enumerate(images, 1):
        try:
            data, w, h = process_image(p)
            processed.append((p, data, w, h))
            print(f"  [{i}/{len(images)}] processed {p.name} -> {w}x{h} ({len(data)//1024} KB)")
        except Exception as e:
            print(f"  [{i}/{len(images)}] FAILED {p.name}: {e}")

    layouts = masonry_layout([(w, h) for _, _, w, h in processed])

    rows = []
    for (path, data, _w, _h), layout in zip(processed, layouts):
        storage_name = f"{slug}-{uuid.uuid4().hex[:10]}.jpg"
        try:
            public_url = upload_to_storage(storage_name, data)
        except Exception as e:
            print(f"  upload FAILED for {path.name}: {e}")
            continue
        rows.append({
            "id": uuid.uuid4().hex,
            "src": public_url,
            "alt": path.stem,
            "x": layout["x"],
            "y": layout["y"],
            "w": layout["w"],
            "h": layout["h"],
            "rotation": 0,
            "object_position": "center",
            "label": None,
            "href": None,
            "order_idx": layout["order_idx"],
            "page": slug,
        })

    if rows:
        insert_tiles(rows)
        print(f"  OK inserted {len(rows)} tiles for /murals/{slug}/")


def main():
    if not SOURCE_ROOT.exists():
        print(f"Source folder not found: {SOURCE_ROOT}")
        sys.exit(1)
    for slug, folder_name in LOCATION_TO_FOLDER.items():
        process_location(slug, folder_name)


if __name__ == "__main__":
    main()
