"""
Replace src/assets/images/prints/print-*.{jpg,png} with the new set
that drorna dropped in Downloads. Keeps `_hand-prints.png` (the title
asset) untouched.

Source: prints/<n>.JPG|png|HEIC inside the zip drorna downloaded. We
process each with EXIF-transpose + HEIC handler, resize so the longest
side is <= 2000 px, save as JPG quality 86, named print-NN-<slug>.jpg
where NN is the source number zero-padded for natural sort.

Run:
    py scripts/reset_prints.py
"""

import io
import re
import shutil
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass


SOURCE_ZIP = Path("C:/Users/nadel/Downloads/prints-20260620T190508Z-3-001.zip")
DEST_DIR = Path(__file__).parent.parent / "src" / "assets" / "images" / "prints"
EXTRACT_TMP = Path(__file__).parent / "_prints_extract_tmp"
MAX_LONGEST_SIDE = 2000
JPEG_QUALITY = 86


def natural_sort_key(s: str):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", s)]


def process(src: Path) -> bytes:
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.thumbnail((MAX_LONGEST_SIDE, MAX_LONGEST_SIDE), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue()


def main():
    if not SOURCE_ZIP.exists():
        print(f"zip not found: {SOURCE_ZIP}")
        sys.exit(1)

    EXTRACT_TMP.mkdir(exist_ok=True)
    print(f"Extracting {SOURCE_ZIP.name} -> {EXTRACT_TMP}...")
    with zipfile.ZipFile(SOURCE_ZIP) as z:
        z.extractall(EXTRACT_TMP)

    # The zip lays files under a top-level "prints/" folder.
    src_root = EXTRACT_TMP / "prints"
    if not src_root.exists():
        # fall back to flat layout
        src_root = EXTRACT_TMP

    images = [
        p for p in src_root.iterdir()
        if p.is_file()
        and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
    ]
    images.sort(key=lambda p: natural_sort_key(p.stem))
    print(f"Found {len(images)} source images.")

    # Wipe existing print-*.* from DEST_DIR but preserve _hand-prints.png
    # and any other non-print-prefixed files.
    print("Clearing old print-*.* from destination...")
    removed = 0
    for old in DEST_DIR.glob("print-*"):
        old.unlink()
        removed += 1
    print(f"  removed {removed} files.")

    print("Processing + writing new tiles...")
    for idx, src in enumerate(images, 1):
        try:
            data = process(src)
        except Exception as e:
            print(f"  [{idx}/{len(images)}] FAILED {src.name}: {e}")
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", src.stem.lower()).strip("-") or "x"
        out = DEST_DIR / f"print-{idx:02d}-{slug}.jpg"
        out.write_bytes(data)
        print(f"  [{idx}/{len(images)}] {src.name} -> {out.name} ({len(data)//1024} KB)")

    shutil.rmtree(EXTRACT_TMP, ignore_errors=True)
    print(f"\nDone. {DEST_DIR} now has {len(list(DEST_DIR.glob('print-*')))} new prints.")


if __name__ == "__main__":
    main()
