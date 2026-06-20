"""
Snapshot the editor-managed Supabase tables to backups/ so any vandalism
or accidental wipe is recoverable.

What gets dumped:
  - site_text     (per-element typography + value overrides)
  - site_image    (per-image positional + src overrides)
  - mural_tiles   (free-positioning canvas tiles, home + every sub-page)

Output: backups/YYYYMMDD-HHMMSS.json with all three tables in one file,
plus updates backups/latest.json so a restore script can grab the most
recent state without a directory listing. Old snapshots beyond
KEEP_COUNT are pruned automatically so the directory doesn't grow
without bound.

Run:
    py scripts/backup_site.py

Recommended cadence: daily via GitHub Action (see .github/workflows/),
or manually before any risky cleanup.
"""

import json
import sys
import time
from pathlib import Path

import requests

SUPABASE_URL = "https://zjifkawkhxjryfkhqssn.supabase.co"
SUPABASE_KEY = "sb_publishable_3VcUVR1O0F-pFthIqHUmrw_AObZrMf6"
# Plaintext edit token. After the RLS migration this is also required on
# read-only requests if you ever want to inspect the row count on a
# restricted bucket (here only writes are gated, so reads work without).
EDIT_TOKEN = "80nl4NHCW-cUk-3GL1P8zg"
BACKUPS_DIR = Path(__file__).parent.parent / "backups"
KEEP_COUNT = 10  # most recent snapshots kept; older ones deleted


def auth_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "x-edit-token": EDIT_TOKEN,
    }


def fetch_table(table: str) -> list[dict]:
    """Page through a table in 1000-row chunks."""
    rows: list[dict] = []
    page = 0
    while True:
        url = f"{SUPABASE_URL}/rest/v1/{table}?select=*&limit=1000&offset={page * 1000}"
        r = requests.get(url, headers=auth_headers())
        r.raise_for_status()
        batch = r.json() or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    return rows


def prune_old_snapshots() -> None:
    snaps = sorted(BACKUPS_DIR.glob("20*.json"), key=lambda p: p.name)
    excess = len(snaps) - KEEP_COUNT
    if excess <= 0:
        return
    for old in snaps[:excess]:
        print(f"  pruning {old.name}")
        old.unlink()


def main():
    BACKUPS_DIR.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())

    snapshot = {
        "_meta": {
            "generated_at_utc": ts,
            "supabase_url": SUPABASE_URL,
            "tables": ["site_text", "site_image", "mural_tiles"],
        },
    }
    print(f"Snapshotting {ts}...")
    for table in ("site_text", "site_image", "mural_tiles"):
        print(f"  fetching {table}...", end=" ", flush=True)
        rows = fetch_table(table)
        snapshot[table] = rows
        print(f"{len(rows)} rows")

    snap_path = BACKUPS_DIR / f"{ts}.json"
    snap_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    print(f"  wrote {snap_path}")

    # Also update latest.json so restore_site.py can grab the freshest
    # without a directory listing.
    latest_path = BACKUPS_DIR / "latest.json"
    latest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    print(f"  wrote {latest_path}")

    prune_old_snapshots()
    print("done.")


if __name__ == "__main__":
    main()
