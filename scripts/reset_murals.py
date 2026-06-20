"""
Wipe-and-rebuild for SUB-PAGE mural_tiles only.

Scope per Drorna 2026-06-18: leave the home /murals/ location-selector
tiles completely untouched. Only rows where page != 'home' get
deleted, and only sub-page rows are re-created from the new
Downloads/mural-page-extracted/mural page tree.

Rules:
  - never crop, never rotate, never swap landscape for portrait
  - the only freedom is "scale" — tile width/height ratio always
    matches the source image's natural ratio
  - existing sub-page positions / labels are lost on purpose

Each /murals/<slug>/ sub-page gets one tile per photo in its folder.
Tiles flow down a 1-column layout at canvas-full width so aspect ratios
are preserved exactly.

A backup of the old rows is written next to this script before anything
is deleted (mural_tiles_backup_<UTC>.json), home rows included so the
restore path is symmetric.

Run:
    py scripts/reset_murals.py
"""

import io
import json
import re
import sys
import time
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


SUPABASE_URL = "https://zjifkawkhxjryfkhqssn.supabase.co"
SUPABASE_KEY = "sb_publishable_3VcUVR1O0F-pFthIqHUmrw_AObZrMf6"
EDIT_TOKEN = "80nl4NHCW-cUk-3GL1P8zg"
BUCKET = "murals"
SOURCE_ROOT = Path("C:/Users/nadel/Downloads/mural-page-extracted/mural page")
BACKUP_DIR = Path(__file__).parent

MAX_LONGEST_SIDE = 2000
JPEG_QUALITY = 86

# Tile layout: 3-column masonry that matches the existing /murals/ home
# look. Each new tile drops into the currently-shortest column; its
# height = column-width * (img_h / img_w) so the source aspect ratio is
# preserved exactly. Drorna's rule "scale only, never crop / rotate /
# change orientation" is automatic — the tile box always matches the
# image box.
COLS = [
    {"x": 2.0,  "w": 31.0},
    {"x": 34.5, "w": 31.0},
    {"x": 67.0, "w": 31.0},
]
TOP_START = 4.0
ROW_GAP = 1.0


def slugify(s: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", s.strip().lower())
    return base.strip("-")


def natural_key(s: str):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", s)]


def auth_headers(extra: dict | None = None) -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "x-edit-token": EDIT_TOKEN,
    }
    if extra:
        h.update(extra)
    return h


def fetch_all_tiles() -> list[dict]:
    """Page through mural_tiles in 1000-row chunks (PostgREST default cap)."""
    rows: list[dict] = []
    page = 0
    while True:
        url = f"{SUPABASE_URL}/rest/v1/mural_tiles?select=*&limit=1000&offset={page * 1000}"
        r = requests.get(url, headers=auth_headers())
        r.raise_for_status()
        batch = r.json() or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    return rows


def delete_sub_page_tiles() -> int:
    """Delete every row whose page != 'home'. Home tiles (the location
    selector on /murals/) are preserved exactly as drorna left them."""
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles?page=neq.home"
    r = requests.delete(url, headers=auth_headers({"Prefer": "return=representation"}))
    if r.status_code in (200, 204):
        return len(r.json() or []) if r.text else 0
    raise RuntimeError(f"delete failed {r.status_code}: {r.text[:200]}")


def process_image(path: Path) -> tuple[bytes, int, int]:
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.thumbnail((MAX_LONGEST_SIDE, MAX_LONGEST_SIDE), Image.LANCZOS)
        w, h = img.size
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue(), w, h


def upload(filename: str, data: bytes) -> str:
    headers = auth_headers({
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
        "cache-control": "max-age=31536000",
    })
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(filename)}"
    r = requests.post(url, data=data, headers=headers)
    if r.status_code in (200, 201):
        return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{urllib.parse.quote(filename)}"
    if r.status_code == 409:
        return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{urllib.parse.quote(filename)}"
    raise RuntimeError(f"upload failed {r.status_code}: {r.text[:200]}")


def insert(rows: list[dict]) -> None:
    if not rows:
        return
    # Insert in batches of 100 so a single bad row doesn't blow up the whole job.
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles"
    headers = auth_headers({
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    })
    for i in range(0, len(rows), 100):
        chunk = rows[i:i + 100]
        r = requests.post(url, headers=headers, data=json.dumps(chunk))
        if r.status_code not in (200, 201):
            raise RuntimeError(f"insert failed at offset {i}: {r.status_code}: {r.text[:300]}")


def gather_images(folder: Path) -> list[Path]:
    if not folder.exists() or not folder.is_dir():
        return []
    imgs = [p for p in folder.iterdir() if p.is_file()
            and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}]
    imgs.sort(key=lambda p: natural_key(p.stem))
    return imgs


def discover_locations() -> list[tuple[str, str, Path]]:
    """Returns [(slug, display_name, folder_path)] for every non-empty
    subfolder of SOURCE_ROOT, sorted alphabetically."""
    out: list[tuple[str, str, Path]] = []
    for p in sorted(SOURCE_ROOT.iterdir(), key=lambda x: x.name.lower()):
        if not p.is_dir():
            continue
        if not gather_images(p):
            continue
        display = p.name.strip()
        # Drop trailing whitespace and pluralisation oddities ("Vietnam " -> "Vietnam").
        out.append((slugify(display), display, p))
    return out


def build_sub_tiles(slug: str, images: list[Path]) -> list[dict]:
    """3-column masonry: each image drops into the currently-shortest
    column at column-width. Tile height = column-width * (img_h / img_w)
    so the source aspect ratio is preserved exactly."""
    col_y = [TOP_START, TOP_START, TOP_START]
    rows: list[dict] = []
    for idx, path in enumerate(images):
        try:
            data, w, h = process_image(path)
        except Exception as e:
            print(f"    process FAILED {path.name}: {e}")
            continue
        storage = f"site/{slug}-{uuid.uuid4().hex[:10]}.jpg"
        try:
            public = upload(storage, data)
        except Exception as e:
            print(f"    upload FAILED {path.name}: {e}")
            continue
        col_i = min(range(3), key=lambda i: col_y[i])
        col = COLS[col_i]
        tile_w = col["w"]
        tile_h = tile_w * (h / max(1, w))
        rows.append({
            "id": uuid.uuid4().hex,
            "src": public,
            "alt": path.stem,
            "x": col["x"],
            "y": round(col_y[col_i], 3),
            "w": tile_w,
            "h": round(tile_h, 3),
            "rotation": 0,
            "object_position": "center",
            "label": None,
            "href": None,
            "order_idx": idx,
            "page": slug,
        })
        col_y[col_i] += tile_h + ROW_GAP
        print(f"    [{idx + 1}/{len(images)}] {path.name} -> {w}x{h}, col {col_i + 1}, tile h={tile_h:.1f}")
    return rows


def main():
    if not SOURCE_ROOT.exists():
        print(f"Source folder not found: {SOURCE_ROOT}")
        sys.exit(1)

    print("Step 1/4: backing up current mural_tiles...")
    existing = fetch_all_tiles()
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup_path = BACKUP_DIR / f"mural_tiles_backup_{ts}.json"
    backup_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    home_count = sum(1 for r in existing if r.get("page") == "home")
    sub_count = len(existing) - home_count
    print(f"  saved {len(existing)} rows to {backup_path} ({home_count} home preserved, {sub_count} sub-page to replace)")

    print("\nStep 2/4: discovering locations...")
    locations = discover_locations()
    print(f"  found {len(locations)} non-empty location folders:")
    for slug, display, _ in locations:
        print(f"    - {display:30s} -> /murals/{slug}/")

    print("\nStep 3/4: deleting sub-page tiles (home left intact)...")
    delete_sub_page_tiles()
    leftover = fetch_all_tiles()
    non_home = sum(1 for r in leftover if r.get("page") != "home")
    home_left = sum(1 for r in leftover if r.get("page") == "home")
    print(f"  rows remaining: {len(leftover)} ({home_left} home kept, {non_home} non-home leftover — expected 0)")

    print("\nStep 4/4: building per-location sub-page tiles...")
    total_sub = 0
    for slug, display, folder in locations:
        images = gather_images(folder)
        print(f"\n  /murals/{slug}/ - {len(images)} images:")
        sub_rows = build_sub_tiles(slug, images)
        insert(sub_rows)
        total_sub += len(sub_rows)
        print(f"  -> inserted {len(sub_rows)} tiles for /murals/{slug}/")

    print(f"\nDone. {total_sub} sub-page tiles inserted across {len(locations)} locations. Home page untouched.")


if __name__ == "__main__":
    main()
