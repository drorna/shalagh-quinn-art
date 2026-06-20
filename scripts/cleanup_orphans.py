"""
Delete known-stale site_text rows from previous home-page layouts.

Background: before the home-hero gained explicit data-editable-text ids
(home.hero.explorePlus etc.) the auto-tagger assigned position-based
ids like auto:/:span:1, auto:/:span:1#2 to whatever spans happened to
exist. Earlier sessions of the editor saved overrides keyed to those
positional ids. The home-hero markup later changed (nav row was
replaced by the Explore curtain, upload button moved), the positions
shifted, and old rows started landing on wrong elements. Even after
the explicit-id fix, the orphan rows still sit in the table — harmless
but easy to confuse with live data when debugging.

This script removes ONLY:
  - auto:/:span:1@<variant>            ("UPLOAD" leftover)
  - auto:/:span:1#<n>@<variant>        ("contact" + similar)
  - auto:/:span:2@<variant>            ("+" leftover)
  - auto:/:a:<n>@<variant>             (the old 4-link nav row's <a>s)
  - auto:/:a:1#<n>@<variant>           (the old enter links + nav row)

It leaves alone:
  - auto:/:li:<n>@<variant>            (handle list customisations)
  - anything for /about/, /murals/ etc. (different pages)
  - custom: rows (drorna's hand-added floating text boxes)
  - the new explicit ids (home.hero.*, home.identity.*, etc.)

Dry-run first: `py scripts/cleanup_orphans.py --dry-run`
Then commit: `py scripts/cleanup_orphans.py`
"""

import re
import sys
import urllib.parse

import requests

SUPABASE_URL = "https://zjifkawkhxjryfkhqssn.supabase.co"
SUPABASE_KEY = "sb_publishable_3VcUVR1O0F-pFthIqHUmrw_AObZrMf6"
EDIT_TOKEN = "80nl4NHCW-cUk-3GL1P8zg"

# Patterns that match only the orphan home-page auto-tag ids.
ORPHAN_PATTERNS = [
    re.compile(r"^auto:/:span:1(#\d+)?@(mobile|desktop)$"),
    re.compile(r"^auto:/:span:2(#\d+)?@(mobile|desktop)$"),
    re.compile(r"^auto:/:a:[1-4](#\d+)?@(mobile|desktop)$"),
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


def fetch_all_site_text() -> list[dict]:
    rows = []
    page = 0
    while True:
        url = f"{SUPABASE_URL}/rest/v1/site_text?select=id,value&limit=1000&offset={page * 1000}"
        r = requests.get(url, headers=auth_headers())
        r.raise_for_status()
        batch = r.json() or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    return rows


def is_orphan(row_id: str) -> bool:
    return any(p.match(row_id) for p in ORPHAN_PATTERNS)


def delete_ids(ids: list[str]) -> None:
    """Delete by id one at a time. PostgREST's in.(…) filter is awkward
    when the ids contain colons / hashes / slashes (our auto-tag scheme)
    so we do single-row deletes — slower but reliable."""
    if not ids:
        return
    deleted = 0
    for row_id in ids:
        encoded = urllib.parse.quote(row_id, safe="")
        url = f"{SUPABASE_URL}/rest/v1/site_text?id=eq.{encoded}"
        r = requests.delete(url, headers=auth_headers({"Prefer": "return=minimal"}))
        if r.status_code not in (200, 204):
            print(f"  FAILED {row_id}: {r.status_code} {r.text[:100]}")
            continue
        deleted += 1
    print(f"  deleted {deleted}/{len(ids)} rows.")


def main():
    dry_run = "--dry-run" in sys.argv

    print("Fetching all site_text rows...")
    rows = fetch_all_site_text()
    print(f"  total rows: {len(rows)}")

    orphans = [r for r in rows if is_orphan(r["id"])]
    print(f"\nFound {len(orphans)} orphan rows to delete:")
    for r in orphans:
        v = (r.get("value") or "")[:40].replace("\n", "\\n")
        print(f"  - {r['id']:30s} value={v!r}")

    if not orphans:
        print("\nNothing to clean.")
        return

    if dry_run:
        print("\nDry run — no deletions performed. Re-run without --dry-run to commit.")
        return

    print("\nDeleting...")
    delete_ids([r["id"] for r in orphans])
    print(f"deleted {len(orphans)} rows.")


if __name__ == "__main__":
    main()
