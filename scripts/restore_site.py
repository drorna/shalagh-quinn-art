"""
Restore site_text / site_image / mural_tiles from a backup_site.py
snapshot.

Default behaviour: read backups/latest.json and idempotently upsert
every row back into Supabase. Existing rows whose id is in the snapshot
are overwritten; rows NOT in the snapshot are left alone (we don't
delete what the snapshot didn't see, to avoid trashing newly-added
rows that the snapshot pre-dates).

Pass a path to restore from a specific snapshot instead:
    py scripts/restore_site.py backups/20260618-220000.json
"""

import json
import sys
from pathlib import Path

import requests

SUPABASE_URL = "https://zjifkawkhxjryfkhqssn.supabase.co"
SUPABASE_KEY = "sb_publishable_3VcUVR1O0F-pFthIqHUmrw_AObZrMf6"
BACKUPS_DIR = Path(__file__).parent.parent / "backups"


def auth_headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    if extra:
        h.update(extra)
    return h


def upsert(table: str, rows: list[dict]) -> None:
    if not rows:
        return
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = auth_headers({
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    })
    # Batch by 100 — keeps single-row failures isolated.
    for i in range(0, len(rows), 100):
        chunk = rows[i:i + 100]
        # Strip generated columns so PostgREST accepts the row on re-insert.
        clean = [{k: v for k, v in r.items()
                  if k not in ("created_at", "updated_at")} for r in chunk]
        r = requests.post(url, headers=headers, data=json.dumps(clean))
        if r.status_code not in (200, 201, 204):
            raise RuntimeError(f"upsert {table} batch@{i} failed {r.status_code}: {r.text[:300]}")


def main():
    if len(sys.argv) > 1:
        snap_path = Path(sys.argv[1])
    else:
        snap_path = BACKUPS_DIR / "latest.json"
    if not snap_path.exists():
        print(f"snapshot not found: {snap_path}")
        sys.exit(1)

    snapshot = json.loads(snap_path.read_text(encoding="utf-8"))
    print(f"Restoring from {snap_path}")
    print(f"  generated at: {snapshot.get('_meta', {}).get('generated_at_utc', '?')}")

    for table in ("site_text", "site_image", "mural_tiles"):
        rows = snapshot.get(table, [])
        print(f"  upserting {len(rows)} rows into {table}...")
        upsert(table, rows)
    print("done.")


if __name__ == "__main__":
    main()
