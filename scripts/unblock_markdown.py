"""
Delete the text-VALUE site_text overrides that were shadowing the
markdown frontmatter. After running this, every word that lives in
shalagh-quinn-art/pages/*.md is the live source of truth — edit in
Obsidian, see the change on the site.

What gets deleted:
  - site_text rows where value IS NOT NULL AND id begins with one of:
      home.        (the explicit-id home-page elements)
      auto:/:li:   (the handles list <li> items)
      about.       (the about page editable text)
      murals.      (the murals intro)
      portraits.   (portraits page subtitle)
      prints.      (prints page subtitle)
      writing.     (writing page body)

What survives (intentionally):
  - rows where value IS NULL — these are pure position / typography
    overrides (font_family, offset_x, transform). Drorna's drag-to-
    move customisations stay.
  - custom: rows — drorna's hand-added floating text boxes.
  - mural_tiles / site_image / other tables — different concern.

Dry-run first:  py scripts/unblock_markdown.py --dry-run
Commit:         py scripts/unblock_markdown.py
"""

import sys
import urllib.parse

import requests

SUPABASE_URL = "https://zjifkawkhxjryfkhqssn.supabase.co"
SUPABASE_KEY = "sb_publishable_3VcUVR1O0F-pFthIqHUmrw_AObZrMf6"

PREFIXES = ("home.", "auto:/:li:", "about.", "murals.", "portraits.", "prints.", "writing.")


def auth_headers(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    if extra:
        h.update(extra)
    return h


def fetch_all() -> list[dict]:
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


def should_delete(row: dict) -> bool:
    if row.get("value") is None:
        return False
    raw_id = row["id"]
    # Strip the @mobile / @desktop variant suffix for prefix matching.
    base = raw_id.split("@", 1)[0]
    return any(base.startswith(p) for p in PREFIXES)


def delete_value_only(row_id: str) -> bool:
    """Setting value to null preserves typography/position overrides on
    the same row but removes the text-content override."""
    encoded = urllib.parse.quote(row_id, safe="")
    url = f"{SUPABASE_URL}/rest/v1/site_text?id=eq.{encoded}"
    r = requests.patch(
        url,
        headers=auth_headers({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        data='{"value":null}',
    )
    if r.status_code in (200, 204):
        return True
    print(f"  FAILED {row_id}: {r.status_code} {r.text[:100]}")
    return False


def main():
    dry_run = "--dry-run" in sys.argv

    print("Fetching all site_text rows...")
    rows = fetch_all()
    targets = [r for r in rows if should_delete(r)]
    print(f"  total: {len(rows)}, value-overrides to clear: {len(targets)}\n")

    for r in targets:
        v = (r["value"] or "")[:50].replace("\n", "\\n")
        print(f"  - {r['id']:50s} value={v!r}")

    if not targets:
        print("\nNothing to clear.")
        return

    if dry_run:
        print("\nDry run — re-run without --dry-run to commit.")
        return

    print("\nClearing value column on each row...")
    cleared = sum(1 for r in targets if delete_value_only(r["id"]))
    print(f"cleared {cleared}/{len(targets)}.")


if __name__ == "__main__":
    main()
