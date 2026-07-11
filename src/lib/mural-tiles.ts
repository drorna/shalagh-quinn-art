/**
 * mural-tiles — the murals canvas data, frozen from Supabase on 2026-07-11.
 *
 * The tiles were authored with the (now removed) visual editor and lived
 * in the `mural_tiles` table; the images lived in the `murals` storage
 * bucket. Both were snapshotted into the repo so the site has no runtime
 * or build-time dependency on Supabase:
 *   - rows  → src/data/mural-tiles.json
 *   - images → public/images/murals-board/
 *
 * To change the board now, edit the JSON (x/y/w/h are % of canvas WIDTH)
 * and drop new images under public/images/murals-board/.
 */
import tilesJson from "../data/mural-tiles.json";

export type MuralTile = {
  id: string;
  /** Site-relative image path under public/, e.g. /images/murals-board/… */
  src: string;
  alt: string;
  /** % of canvas WIDTH (not height) — keeps tiles stable as the canvas grows. */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  object_position: string;
  /** Optional label shown bottom-right (e.g. "nepal"). */
  label: string | null;
  /** Optional link target (e.g. "/murals/nepal/"). */
  href: string | null;
  /** Insertion order — used as the final sort key. */
  order_idx: number;
  /** Board slug — 'home' for /murals/, otherwise the sub-page slug. */
  page: string;
  created_at?: string;
  updated_at?: string;
};

export function slugify(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const byPosition = (a: MuralTile, b: MuralTile) =>
  a.y - b.y || a.x - b.x || (a.order_idx || 0) - (b.order_idx || 0);

export function allTiles(): MuralTile[] {
  return (tilesJson as MuralTile[]).slice().sort(byPosition);
}

/** Tiles for one board: rows authored on the page slug plus rows whose
 *  label slugifies to it (the dynamic-from-label contract). */
export function tilesFor(page: string): MuralTile[] {
  const seen = new Set<string>();
  const acc: MuralTile[] = [];
  for (const t of allTiles()) {
    if (t.page === page && !seen.has(t.id)) { seen.add(t.id); acc.push(t); }
  }
  if (page !== "home") {
    for (const t of allTiles()) {
      if (slugify(t.label) === page && !seen.has(t.id)) { seen.add(t.id); acc.push(t); }
    }
  }
  return acc;
}

/** Every sub-page slug that should exist: distinct page values + label slugs. */
export function allSlugs(): string[] {
  const slugs = new Set<string>();
  for (const t of allTiles()) {
    if (t.page && t.page !== "home") slugs.add(t.page);
    const fromLabel = slugify(t.label);
    if (fromLabel) slugs.add(fromLabel);
  }
  return Array.from(slugs);
}
