/**
 * Floating navigation strip for edit mode.
 *
 * Always visible (top-left of the viewport) when ?edit=<token> is on:
 *   - ← back, → forward, ⌂ home
 *   - "page ▾" dropdown listing every page on the site, including every
 *     live /murals/[slug]/ board pulled from Supabase
 *   - "view" — opens the same URL in a new tab without ?edit so you can
 *     see the public version
 *
 * All in-app links carry ?edit=1 so the editor session never drops.
 */
import { supabase } from "../lib/supabase";

const EDIT_TOKEN_HASH = "1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67";
const LOCAL_STORAGE_KEY = "shalagh.murals.editToken";

export function initEditNav(): void {
  if (typeof window === "undefined") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isEditMode(): Promise<boolean> {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("edit");
  if (fromUrl && fromUrl !== "1") {
    if ((await sha256Hex(fromUrl)) === EDIT_TOKEN_HASH) {
      try { localStorage.setItem(LOCAL_STORAGE_KEY, fromUrl); } catch {}
      url.searchParams.set("edit", "1");
      window.history.replaceState({}, "", url.toString());
      return true;
    }
    return false;
  }
  if (url.searchParams.get("edit") === "1") {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) return (await sha256Hex(stored)) === EDIT_TOKEN_HASH;
    } catch {}
  }
  return false;
}

async function boot() {
  if (!(await isEditMode())) return;
  injectStyles();
  const bar = render();
  document.body.appendChild(bar);
  populatePagesDropdown(bar);
}

function withEdit(href: string): string {
  try {
    const u = new URL(href, location.origin);
    u.searchParams.set("edit", "1");
    return u.pathname + (u.search || "") + (u.hash || "");
  } catch {
    return href;
  }
}

function render(): HTMLElement {
  const here = location.pathname;
  const bar = document.createElement("nav");
  bar.className = "edit-nav";
  bar.dataset.noEdit = "";
  bar.setAttribute("aria-label", "edit navigation");
  bar.innerHTML = `
    <button class="en-btn" data-nav="back" title="back (Alt+←)">←</button>
    <button class="en-btn" data-nav="fwd"  title="forward (Alt+→)">→</button>
    <a class="en-btn" href="${withEdit("/")}" title="home">⌂</a>
    <div class="en-sep"></div>
    <details class="en-dd">
      <summary>pages ▾</summary>
      <ul class="en-list" data-pages-list><li class="en-loading">loading…</li></ul>
    </details>
    <a class="en-btn en-view" href="${stripEdit(location.pathname + location.search)}" target="_blank" rel="noopener" title="view public">view</a>
    <span class="en-here">${here}</span>
  `;
  bar.querySelector<HTMLButtonElement>("[data-nav='back']")!.addEventListener("click", () => history.back());
  bar.querySelector<HTMLButtonElement>("[data-nav='fwd']")!.addEventListener("click", () => history.forward());
  return bar;
}

function stripEdit(p: string): string {
  try {
    const u = new URL(p, location.origin);
    u.searchParams.delete("edit");
    return u.pathname + (u.search || "");
  } catch {
    return p;
  }
}

async function populatePagesDropdown(bar: HTMLElement) {
  const list = bar.querySelector<HTMLUListElement>("[data-pages-list]")!;
  // Static, always-present pages
  const items: { label: string; href: string }[] = [
    { label: "home",      href: "/" },
    { label: "about",     href: "/about/" },
    { label: "murals",    href: "/murals/" },
    { label: "portraits", href: "/portraits/" },
    { label: "prints",    href: "/prints/" },
    { label: "upload",    href: "/upload/" },
  ];

  // Live murals sub-pages
  try {
    const { data } = await supabase.from("mural_tiles").select("page, label");
    const slugs = new Set<string>();
    for (const row of (data || []) as Array<{ page: string | null; label: string | null }>) {
      if (row.page && row.page !== "home") slugs.add(row.page);
      const fromLabel = slugify(row.label);
      if (fromLabel) slugs.add(fromLabel);
    }
    const sorted = Array.from(slugs).sort();
    for (const slug of sorted) {
      items.push({ label: `↳ murals / ${slug}`, href: `/murals/${slug}/` });
    }
  } catch (e) {
    console.warn("[edit-nav] couldn't load mural slugs", e);
  }

  list.innerHTML = items
    .map((it) => {
      const isHere = location.pathname === it.href;
      return `<li><a class="en-pageitem ${isHere ? "is-here" : ""}" href="${withEdit(it.href)}">${escapeHtml(it.label)}</a></li>`;
    })
    .join("");
}

function slugify(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function injectStyles() {
  if (document.getElementById("edit-nav-styles")) return;
  const s = document.createElement("style");
  s.id = "edit-nav-styles";
  s.textContent = `
    .edit-nav {
      position: fixed;
      top: 14px;
      left: 14px;
      z-index: 2000;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(22, 22, 22, 0.92);
      backdrop-filter: blur(6px);
      border: 1px solid #444;
      border-radius: 8px;
      padding: 6px 8px;
      font-family: monospace;
      font-size: 13px;
      color: #fff;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45);
    }
    .edit-nav .en-btn {
      background: #222;
      color: #fff;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 4px 9px;
      font-family: monospace;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
    }
    .edit-nav .en-btn:hover { background: #333; }
    .edit-nav .en-sep {
      width: 1px;
      height: 18px;
      background: #444;
      margin: 0 2px;
    }
    .edit-nav details.en-dd {
      position: relative;
    }
    .edit-nav details.en-dd > summary {
      list-style: none;
      cursor: pointer;
      background: #222;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 4px 10px;
      font-family: monospace;
      font-size: 13px;
      color: #fff;
      user-select: none;
    }
    .edit-nav details.en-dd[open] > summary { background: #4cc2ff; color: #000; border-color: #4cc2ff; }
    .edit-nav details.en-dd > summary::-webkit-details-marker { display: none; }
    .edit-nav .en-list {
      position: absolute;
      top: 100%;
      left: 0;
      margin: 6px 0 0;
      padding: 6px 0;
      list-style: none;
      background: #161616;
      border: 1px solid #444;
      border-radius: 6px;
      min-width: 220px;
      max-height: 55vh;
      overflow-y: auto;
      box-shadow: 0 12px 28px rgba(0,0,0,0.55);
    }
    .edit-nav .en-list li { margin: 0; padding: 0; }
    .edit-nav .en-pageitem {
      display: block;
      padding: 6px 14px;
      color: #fff;
      font-family: monospace;
      font-size: 12px;
      text-decoration: none;
    }
    .edit-nav .en-pageitem:hover { background: #2a2a2a; }
    .edit-nav .en-pageitem.is-here { background: #4cc2ff; color: #000; }
    .edit-nav .en-loading { padding: 8px 14px; color: #888; font-size: 11px; }
    .edit-nav .en-here {
      color: #888;
      padding: 0 4px;
      font-size: 11px;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .edit-nav .en-view { background: #4cc2ff; color: #000; border-color: #4cc2ff; font-weight: bold; }
  `;
  document.head.appendChild(s);
}
