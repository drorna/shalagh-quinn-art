"""
Delete every site_text row whose id starts with `home.` (any variant).

Use this after a "let me clean-slate the home-page layout" edit session
— it removes typography, drag-offset, transform, and value overrides
in one shot so the markdown frontmatter is what the visitor sees,
period. Position-style overrides survive `unblock_markdown.py`, which
only nulls the .value column; this script removes the whole row.

Dry-run:  py scripts/wipe_home_overrides.py --dry-run
Commit:   py scripts/wipe_home_overrides.py
"""

import sys
import urllib.parse

import requests

from _env import SUPABASE_URL, SUPABASE_KEY, EDIT_TOKEN  # noqa: E402


def auth_headers(extra=None):
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "x-edit-token": EDIT_TOKEN,
    }
    if extra:
        h.update(extra)
    return h


def fetch_home_ids() -> list[str]:
    url = f"{SUPABASE_URL}/rest/v1/site_text?select=id&id=like.home.*"
    r = requests.get(url, headers=auth_headers())
    r.raise_for_status()
    return [row["id"] for row in r.json()]


def delete_row(row_id: str) -> bool:
    encoded = urllib.parse.quote(row_id, safe="")
    url = f"{SUPABASE_URL}/rest/v1/site_text?id=eq.{encoded}"
    r = requests.delete(url, headers=auth_headers({"Prefer": "return=minimal"}))
    if r.status_code in (200, 204):
        return True
    print(f"  FAILED {row_id}: {r.status_code} {r.text[:120]}")
    return False


def main():
    dry_run = "--dry-run" in sys.argv

    ids = fetch_home_ids()
    print(f"home.* rows to delete: {len(ids)}\n")
    for i in ids:
        print(f"  - {i}")

    if not ids:
        print("\nNothing to wipe.")
        return

    if dry_run:
        print("\nDry run — re-run without --dry-run to commit.")
        return

    print("\nDeleting...")
    deleted = sum(1 for i in ids if delete_row(i))
    print(f"deleted {deleted}/{len(ids)} rows.")


if __name__ == "__main__":
    main()
