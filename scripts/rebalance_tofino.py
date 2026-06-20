"""
Tofino tile layout, manual 2 / 2 / 2 split.

Six images, one of which (Tonfio 4) is a 1125 x 2000 portrait that
dwarfs every other tile. Pure masonry leaves one column either way
too tall or sparsely populated. We instead place EXACTLY two images
per column, pairing the tall outlier with the shortest landscape to
keep column heights within a few percent of each other.

Aspect ratios are preserved — only x and y change.

Run:
    py scripts/rebalance_tofino.py
"""

import urllib.parse
import requests
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _env import SUPABASE_URL, SUPABASE_KEY, EDIT_TOKEN  # noqa: E402

COLS = [
    {"x": 2.0,  "w": 31.0},
    {"x": 34.5, "w": 31.0},
    {"x": 67.0, "w": 31.0},
]
TOP_START = 4.0
ROW_GAP = 1.0
PAGE = "tofino"

# Hand-picked 2-image stacks per column. Picked to keep column heights
# within ~30 % of each other (Tonfio 4 in col 1 paired with the
# shortest landscape; tofino 2 in col 2 paired with another short;
# col 3 gets two near-identical landscapes).
STACKS = [
    ["Tonfio 4",  "tonfio 1"],   # col 1
    ["tofino 2",  "Tofino 9"],   # col 2
    ["Tofino",    "Tonfio 3"],   # col 3
]


def auth_headers(extra=None):
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "x-edit-token": EDIT_TOKEN,
    }
    if extra:
        h.update(extra)
    return h


def fetch_rows():
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles?page=eq.{PAGE}&select=*"
    r = requests.get(url, headers=auth_headers())
    r.raise_for_status()
    return r.json()


def patch_row(row_id: str, patch: dict):
    enc = urllib.parse.quote(row_id, safe="")
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles?id=eq.{enc}"
    r = requests.patch(
        url,
        headers=auth_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        data=json.dumps(patch),
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"patch failed {row_id}: {r.status_code} {r.text[:200]}")


def main():
    rows = fetch_rows()
    by_alt = {r["alt"]: r for r in rows}

    plan = []
    for col_i, stack in enumerate(STACKS):
        col = COLS[col_i]
        y = TOP_START
        order_in_col = 0
        for alt in stack:
            row = by_alt.get(alt)
            if row is None:
                print(f"  WARN: tile alt={alt!r} not found in DB; skipping")
                continue
            natural = row["h"] / max(1.0, row["w"])  # h/w preserved
            new_w = col["w"]
            new_h = new_w * natural
            plan.append({
                "id": row["id"],
                "alt": alt,
                "new": (col["x"], round(y, 3), round(new_w, 3), round(new_h, 3)),
                "col": col_i + 1,
            })
            y += new_h + ROW_GAP
            order_in_col += 1
        print(f"col {col_i + 1}: stops at y={y - ROW_GAP:.1f}")

    print("\nApplying...")
    for p in plan:
        patch_row(p["id"], {
            "x": p["new"][0],
            "y": p["new"][1],
            "w": p["new"][2],
            "h": p["new"][3],
        })
        print(f"  {p['alt']:18s} -> col {p['col']}  ({p['new']})")
    print("done.")


if __name__ == "__main__":
    main()
