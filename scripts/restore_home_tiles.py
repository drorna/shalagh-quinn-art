"""
Recover the /murals/ home location-selector tiles from the oldest backup
we made before reset_murals.py was run.

Why this exists: reset_murals.py was supposed to leave page='home' rows
alone, but on its first run the home tiles were lost anyway (see the
gap between backup files 210244Z -> 210637Z). The 28 original home
tiles are still present in mural_tiles_backup_20260618T210244Z.json so
we read them back and re-insert with their original ids preserved.

Idempotent: skips any home row whose id is already in the DB.
"""

import json
import sys
from pathlib import Path

import requests

SUPABASE_URL = "https://zjifkawkhxjryfkhqssn.supabase.co"
SUPABASE_KEY = "sb_publishable_3VcUVR1O0F-pFthIqHUmrw_AObZrMf6"
BACKUP = Path(__file__).parent / "mural_tiles_backup_20260618T210244Z.json"


def auth_headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    if extra:
        h.update(extra)
    return h


def existing_ids() -> set:
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles?select=id&page=eq.home"
    r = requests.get(url, headers=auth_headers())
    r.raise_for_status()
    return {row["id"] for row in r.json()}


def insert(rows: list[dict]):
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/mural_tiles"
    headers = auth_headers({
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    })
    r = requests.post(url, headers=headers, data=json.dumps(rows))
    if r.status_code not in (200, 201):
        raise RuntimeError(f"insert failed {r.status_code}: {r.text[:300]}")


def main():
    if not BACKUP.exists():
        print(f"backup not found: {BACKUP}")
        sys.exit(1)
    all_rows = json.loads(BACKUP.read_text(encoding="utf-8"))
    home_rows = [r for r in all_rows if r.get("page") == "home"]
    print(f"backup has {len(home_rows)} home rows (out of {len(all_rows)} total).")

    have = existing_ids()
    print(f"DB currently has {len(have)} home rows.")

    to_insert = []
    for row in home_rows:
        if row["id"] in have:
            continue
        # PostgREST will reject created_at / updated_at if columns are
        # generated — drop them and let the DB default them.
        clean = {k: v for k, v in row.items() if k not in ("created_at", "updated_at")}
        to_insert.append(clean)

    print(f"inserting {len(to_insert)} home rows...")
    insert(to_insert)
    after = existing_ids()
    print(f"done. home now has {len(after)} rows.")


if __name__ == "__main__":
    main()
