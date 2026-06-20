"""
Re-pack /murals/tofino/ tiles so the three columns end at similar y.

The default shortest-column masonry handles same-aspect images fine but
gets thrown off by Tonfio 4 — a 1125 x 2000 portrait that's 2.5× taller
than the five landscape tiles. The algorithm processed it last and
dumped the whole height onto col 2, leaving cols 1 and 3 looking
truncated.

This script re-reads the existing tofino rows from Supabase, sorts them
by aspect (tallest first), repacks with the same shortest-column rule,
and UPDATEs each row's x/y. Width / height ratio is preserved (drorna's
rule: no crop, no rotate, only scale).

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
    print(f"Loaded {len(rows)} tiles from /murals/{PAGE}/")

    # Stable-sort by aspect: tallest (largest h:w ratio) first. Tied
    # ratios stay in insertion order (original order_idx).
    rows.sort(key=lambda r: (-(r["h"] / max(1.0, r["w"])), r["order_idx"]))

    col_y = [TOP_START, TOP_START, TOP_START]
    plan = []
    for r in rows:
        col_i = min(range(3), key=lambda i: col_y[i])
        col = COLS[col_i]
        # Preserve aspect: rescale tile_w to column width, recompute h.
        natural_h_over_w = r["h"] / max(1.0, r["w"])
        new_w = col["w"]
        new_h = new_w * natural_h_over_w
        plan.append({
            "id": r["id"],
            "alt": r.get("alt"),
            "old": (round(r["x"], 1), round(r["y"], 1), round(r["w"], 1), round(r["h"], 1)),
            "new": (col["x"], round(col_y[col_i], 3), round(new_w, 3), round(new_h, 3)),
            "col": col_i + 1,
        })
        col_y[col_i] += new_h + ROW_GAP

    print(f"\nNew column heights: col1={col_y[0]:.1f}  col2={col_y[1]:.1f}  col3={col_y[2]:.1f}")
    print("\nPer-tile plan (old -> new):")
    for p in plan:
        print(f"  {p['alt']:20s} col {p['col']}  ({p['old']}) -> ({p['new']})")

    print("\nApplying...")
    for p in plan:
        patch_row(p["id"], {
            "x": p["new"][0],
            "y": p["new"][1],
            "w": p["new"][2],
            "h": p["new"][3],
        })
    print("done.")


if __name__ == "__main__":
    main()
