"""
Tiny .env loader shared by every Supabase-touching script.

Reads `.env` at the repo root and exposes:
  - SUPABASE_URL
  - SUPABASE_KEY
  - EDIT_TOKEN

We deliberately avoid python-dotenv so there's no install step. The
file format we parse is the subset our .env actually uses:
  KEY=value
  (no quotes, no leading export, no multiline)

Lines starting with `#` and blank lines are ignored.
"""

import os
from pathlib import Path


def _load(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_ROOT = Path(__file__).parent.parent
_ENV = _load(_ROOT / ".env")


def _require(name: str) -> str:
    v = os.environ.get(name) or _ENV.get(name) or ""
    if not v:
        raise RuntimeError(
            f"{name} is not set. Add it to .env at the repo root "
            "or export it in this shell."
        )
    return v


SUPABASE_URL = _require("PUBLIC_SUPABASE_URL")
SUPABASE_KEY = _require("PUBLIC_SUPABASE_KEY")
EDIT_TOKEN = _require("EDIT_TOKEN")
