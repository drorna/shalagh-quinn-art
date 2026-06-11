/**
 * Murals board — Supabase-backed image collage.
 *
 * View mode  : fetches tiles and renders the grid.
 * Edit mode  : ?edit=1  → toolbar with +Add image, per-tile resize/move/rotate/delete,
 *              saves directly to Supabase on every change. Both computers see the
 *              same state on reload.
 */
import {
  supabase,
  fetchTiles,
  upsertTile,
  deleteTile,
  uploadImageFile,
  deleteImageFile,
  type MuralTile,
} from "../lib/supabase";

const GRID_COLS = 24;        // total columns in the grid
const ROW_HEIGHT_PX = 20;    // grid-auto-rows
const GAP_PX = 12;

/**
 * Hash-based edit gate.
 *
 * The plaintext token NEVER appears in this file or in the bundle —
 * only the SHA-256 hash. Edit mode unlocks when one of:
 *   1. URL contains ?edit=<token> whose hash matches EDIT_TOKEN_HASH.
 *   2. The browser already stored a verified token in localStorage.
 *
 * To rotate the token: generate a fresh one + hash (`crypto.randomBytes(16).toString('base64url')`),
 * paste the new hash here, push, and share the new token URL.
 */
const EDIT_TOKEN_HASH = "1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67";
const LOCAL_STORAGE_KEY = "shalagh.murals.editToken";

let grid: HTMLElement | null = null;
let tiles: MuralTile[] = [];
let editMode = false;
let selectedTileId: string | null = null;

export function initMuralsBoard(): void {
  if (typeof window === "undefined") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function checkEditAccess(): Promise<boolean> {
  const url = new URL(location.href);
  const tokenFromUrl = url.searchParams.get("edit");

  if (tokenFromUrl) {
    const hash = await sha256Hex(tokenFromUrl);
    if (hash === EDIT_TOKEN_HASH) {
      // Remember on this device so the next visit doesn't need the token
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, tokenFromUrl);
      } catch {}
      // Strip the token from the URL bar so it isn't exposed in screenshots / history
      url.searchParams.delete("edit");
      url.searchParams.set("edit", "1");
      window.history.replaceState({}, "", url.toString());
      return true;
    }
    return false;
  }

  // Allow ?edit=1 (no token) only if a valid token is already stored
  if (url.searchParams.get("edit") === "1") {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const hash = await sha256Hex(stored);
        return hash === EDIT_TOKEN_HASH;
      }
    } catch {}
  }
  return false;
}

async function boot() {
  grid = document.querySelector<HTMLElement>("[data-mural-grid]");
  if (!grid) return;

  editMode = await checkEditAccess();

  if (editMode) {
    document.body.classList.add("is-mural-edit");
    injectEditorStyles();
    mountToolbar();
    mountPanel();
  }

  await loadAndRender();

  // Realtime: any tile change → re-render. Lets the second computer see updates live.
  supabase
    .channel("mural_tiles_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "mural_tiles" },
      () => {
        loadAndRender();
      }
    )
    .subscribe();
}

async function loadAndRender() {
  tiles = await fetchTiles();
  render();
}

function render() {
  if (!grid) return;
  // Clear (keep loading element only if no tiles)
  grid.innerHTML = "";
  if (tiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "murals-grid__loading";
    empty.textContent = editMode
      ? "empty — click + Add image to start"
      : "";
    grid.appendChild(empty);
  }
  for (const t of tiles) grid.appendChild(buildTileEl(t));
  if (editMode) refreshSelection();
}

function buildTileEl(t: MuralTile): HTMLElement {
  const el = document.createElement(t.href && !editMode ? "a" : "div");
  el.className = "mural-tile";
  el.dataset.id = t.id;
  if (t.href && !editMode) (el as HTMLAnchorElement).href = t.href;
  applyTileStyle(el, t);

  const img = document.createElement("img");
  img.className = "mural-tile__img";
  img.src = t.src;
  img.alt = t.alt || "";
  img.loading = "lazy";
  img.style.objectPosition = t.object_position || "center";
  el.appendChild(img);

  if (t.label) {
    const label = document.createElement("span");
    label.className = "mural-tile__label";
    label.textContent = t.label;
    if (t.href) {
      const arrow = document.createElement("span");
      arrow.className = "mural-tile__label-arrow";
      arrow.textContent = ">";
      label.appendChild(arrow);
    }
    el.appendChild(label);
  }

  if (editMode) attachEditHandlers(el, t);
  return el;
}

function applyTileStyle(el: HTMLElement, t: MuralTile) {
  // Use grid-column / grid-row + dense packing.
  // Clamp w to grid width, h to a reasonable minimum.
  const w = Math.max(1, Math.min(GRID_COLS, t.w || 6));
  const h = Math.max(1, t.h || 8);
  el.style.gridColumn = `span ${w}`;
  el.style.gridRow = `span ${h}`;
  el.style.transform = t.rotation ? `rotate(${t.rotation}deg)` : "";
}

/* ============================================================
   EDIT MODE
   ============================================================ */

function attachEditHandlers(el: HTMLElement, t: MuralTile) {
  // Click selects (use mousedown so click doesn't fight resize handles)
  el.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("[data-handle]")) return;
    selectedTileId = t.id;
    refreshSelection();
    renderPanel();
  });

  // Resize handles (right + bottom + corner)
  const mkHandle = (kind: "right" | "bottom" | "corner") => {
    const h = document.createElement("div");
    h.className = `mural-tile__handle mural-tile__handle--${kind}`;
    h.dataset.handle = kind;
    el.appendChild(h);
    enableResize(h, el, t, kind);
  };
  mkHandle("right");
  mkHandle("bottom");
  mkHandle("corner");

  // Delete button
  const del = document.createElement("button");
  del.className = "mural-tile__delete";
  del.type = "button";
  del.textContent = "×";
  del.title = "delete tile";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this image?")) return;
    await deleteImageFile(t.src);
    await deleteTile(t.id);
    tiles = tiles.filter((x) => x.id !== t.id);
    if (selectedTileId === t.id) selectedTileId = null;
    render();
  });
  el.appendChild(del);
}

function enableResize(
  handle: HTMLElement,
  tileEl: HTMLElement,
  tile: MuralTile,
  axis: "right" | "bottom" | "corner"
) {
  let startX = 0,
    startY = 0,
    startW = 0,
    startH = 0,
    gridLeft = 0,
    cellW = 0;
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = tile.w || 6;
    startH = tile.h || 8;
    const gr = grid!.getBoundingClientRect();
    gridLeft = gr.left;
    cellW = (gr.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS + GAP_PX;
    document.body.style.cursor =
      axis === "right" ? "ew-resize" : axis === "bottom" ? "ns-resize" : "nwse-resize";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (axis !== "bottom") {
      const dx = e.clientX - startX;
      const dW = Math.round(dx / cellW);
      tile.w = Math.max(1, Math.min(GRID_COLS, startW + dW));
    }
    if (axis !== "right") {
      const dy = e.clientY - startY;
      const dH = Math.round(dy / (ROW_HEIGHT_PX + GAP_PX));
      tile.h = Math.max(1, startH + dH);
    }
    applyTileStyle(tileEl, tile);
  });
  window.addEventListener("mouseup", async () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    await upsertTile(tile);
  });
}

function refreshSelection() {
  if (!grid) return;
  for (const el of grid.querySelectorAll<HTMLElement>(".mural-tile")) {
    el.classList.toggle("is-selected", el.dataset.id === selectedTileId);
  }
}

/* ============================================================
   TOOLBAR + PANEL
   ============================================================ */

function mountToolbar() {
  const bar = document.createElement("div");
  bar.className = "mural-edit-toolbar";
  bar.innerHTML = `
    <span class="mural-edit-toolbar__title">murals editor (live)</span>

    <label class="mural-edit-toolbar__btn">
      + add image
      <input type="file" accept="image/*" multiple hidden data-add-files />
    </label>

    <span class="mural-edit-toolbar__hint">drag corner = resize · click tile = open panel · × = delete</span>

    <a class="mural-edit-toolbar__exit" href="?">exit edit</a>
  `;
  document.body.appendChild(bar);

  bar.querySelector<HTMLInputElement>("[data-add-files]")?.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;
    for (const f of Array.from(input.files)) {
      await addImage(f);
    }
    input.value = "";
  });
}

async function addImage(file: File) {
  const up = await uploadImageFile(file);
  if (!up) {
    alert("Upload failed. See console.");
    return;
  }
  const t: MuralTile = {
    id: crypto.randomUUID(),
    src: up.src,
    alt: file.name.replace(/\.[^.]+$/, ""),
    x: 0,
    y: 0,
    w: 8,
    h: 10,
    rotation: 0,
    object_position: "center",
    label: null,
    href: null,
    order_idx: tiles.length,
  };
  await upsertTile(t);
  tiles.push(t);
  render();
}

function mountPanel() {
  const panel = document.createElement("aside");
  panel.className = "mural-edit-panel";
  panel.dataset.panel = "";
  panel.innerHTML = `<p class="mural-edit-panel__hint">click a tile to edit</p>`;
  document.body.appendChild(panel);
}

function renderPanel() {
  const panel = document.querySelector<HTMLElement>("[data-panel]");
  if (!panel) return;
  const t = tiles.find((x) => x.id === selectedTileId);
  if (!t) {
    panel.innerHTML = `<p class="mural-edit-panel__hint">click a tile to edit</p>`;
    return;
  }
  panel.innerHTML = `
    <div class="mural-edit-panel__head">
      <strong>tile</strong>
      <button class="mural-edit-panel__close" type="button">×</button>
    </div>

    <label class="mural-edit-row">
      <span>label (optional, e.g. "nepal")</span>
      <input type="text" value="${escapeAttr(t.label || "")}" data-field="label" />
    </label>

    <label class="mural-edit-row">
      <span>link (optional, e.g. "/murals/nepal/")</span>
      <input type="text" value="${escapeAttr(t.href || "")}" data-field="href" />
    </label>

    <label class="mural-edit-row">
      <span>width (cols, 1–${GRID_COLS})</span>
      <input type="range" min="1" max="${GRID_COLS}" step="1" value="${t.w}" data-field="w" />
      <output>${t.w}</output>
    </label>

    <label class="mural-edit-row">
      <span>height (rows)</span>
      <input type="range" min="1" max="60" step="1" value="${t.h}" data-field="h" />
      <output>${t.h}</output>
    </label>

    <div class="mural-edit-row">
      <span>object position (drag inside)</span>
      <div class="mural-edit-objpos" data-objpos>
        <div class="mural-edit-objpos__dot" style="${objectPositionToDot(t.object_position)}"></div>
      </div>
      <output data-objpos-out>${t.object_position}</output>
    </div>

    <label class="mural-edit-row">
      <span>rotation (deg)</span>
      <input type="range" min="-30" max="30" step="0.5" value="${t.rotation}" data-field="rotation" />
      <output>${t.rotation}</output>
    </label>
  `;

  panel.querySelector(".mural-edit-panel__close")?.addEventListener("click", () => {
    selectedTileId = null;
    refreshSelection();
    renderPanel();
  });

  panel.querySelectorAll<HTMLInputElement>("[data-field]").forEach((ctrl) => {
    ctrl.addEventListener("input", () => {
      const field = ctrl.dataset.field as keyof MuralTile;
      let v: any = ctrl.value;
      if (field === "w" || field === "h" || field === "rotation") v = parseFloat(v);
      if ((field === "label" || field === "href") && v === "") v = null;
      (t as any)[field] = v;
      const out = ctrl.parentElement?.querySelector("output");
      if (out && (field === "w" || field === "h" || field === "rotation"))
        out.textContent = String(v);
      const el = grid!.querySelector<HTMLElement>(`.mural-tile[data-id="${t.id}"]`);
      if (el) applyTileStyle(el, t);
    });
    ctrl.addEventListener("change", () => upsertTile(t));
  });

  // object-position pad
  const pad = panel.querySelector<HTMLElement>("[data-objpos]");
  const padOut = panel.querySelector<HTMLElement>("[data-objpos-out]");
  if (pad) {
    let dragging = false;
    const update = (e: MouseEvent) => {
      const r = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
      const v = `${Math.round(x)}% ${Math.round(y)}%`;
      t.object_position = v;
      if (padOut) padOut.textContent = v;
      const dot = pad.querySelector<HTMLElement>(".mural-edit-objpos__dot");
      if (dot) {
        dot.style.left = `${x}%`;
        dot.style.top = `${y}%`;
      }
      const tileEl = grid!.querySelector<HTMLImageElement>(
        `.mural-tile[data-id="${t.id}"] .mural-tile__img`
      );
      if (tileEl) tileEl.style.objectPosition = v;
    };
    pad.addEventListener("mousedown", (e) => {
      dragging = true;
      update(e);
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) update(e);
    });
    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        upsertTile(t);
      }
    });
  }
}

/* ============================================================
   STYLE INJECTION
   ============================================================ */

function injectEditorStyles() {
  if (document.getElementById("mural-edit-styles")) return;
  const s = document.createElement("style");
  s.id = "mural-edit-styles";
  s.textContent = `
    body.is-mural-edit .murals-page { padding-bottom: 88px; }
    body.is-mural-edit .murals-page__back { pointer-events: none; opacity: 0.3; }
    body.is-mural-edit .mural-tile { outline: 1px dashed rgba(255,255,255,0.15); cursor: pointer; }
    body.is-mural-edit .mural-tile.is-selected { outline: 2px solid #ffcc00; }

    .mural-tile__handle {
      position: absolute;
      background: rgba(255,204,0,0.55);
      z-index: 5;
    }
    .mural-tile__handle--right  { top: 0; right: 0; width: 8px; height: 100%; cursor: ew-resize; }
    .mural-tile__handle--bottom { left: 0; bottom: 0; width: 100%; height: 8px; cursor: ns-resize; }
    .mural-tile__handle--corner { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; background: #ffcc00; }

    .mural-tile__delete {
      position: absolute;
      top: 6px;
      left: 6px;
      width: 26px;
      height: 26px;
      background: rgba(0,0,0,0.75);
      color: #fff;
      border: 1px solid #fff;
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0;
      z-index: 5;
      transition: background var(--duration-fast) var(--ease-out);
    }
    .mural-tile__delete:hover { background: #d33; }

    .mural-edit-toolbar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: #161616;
      color: #fff;
      font-family: monospace;
      font-size: 13px;
      padding: 12px 18px;
      display: flex;
      gap: 16px;
      align-items: center;
      border-top: 1px solid #444;
      z-index: 1000;
    }
    .mural-edit-toolbar__title { font-weight: bold; color: #ffcc00; }
    .mural-edit-toolbar__btn {
      padding: 8px 14px;
      background: #ffcc00;
      color: #000;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      font-weight: bold;
      font-family: monospace;
    }
    .mural-edit-toolbar__hint { color: #888; }
    .mural-edit-toolbar__exit {
      margin-left: auto;
      color: #aaa;
      padding: 6px 10px;
      text-decoration: underline;
    }

    .mural-edit-panel {
      position: fixed;
      top: 60px;
      right: 16px;
      width: 280px;
      background: #161616;
      color: #fff;
      font-family: monospace;
      font-size: 13px;
      padding: 14px;
      border-radius: 4px;
      border: 1px solid #444;
      z-index: 1000;
      max-height: calc(100vh - 140px);
      overflow-y: auto;
    }
    .mural-edit-panel__hint { color: #888; margin: 0; }
    .mural-edit-panel__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .mural-edit-panel__close { background: none; border: 0; color: #aaa; font-size: 20px; cursor: pointer; }
    .mural-edit-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 12px; }
    .mural-edit-row > span { color: #aaa; }
    .mural-edit-row input[type="range"] { width: 100%; }
    .mural-edit-row input[type="text"] {
      background: #222; color: #fff; border: 1px solid #555; padding: 6px; border-radius: 3px;
    }
    .mural-edit-objpos { position: relative; width: 100%; height: 100px; background: #222; border: 1px solid #555; cursor: crosshair; }
    .mural-edit-objpos__dot {
      position: absolute;
      width: 10px;
      height: 10px;
      background: #ffcc00;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function objectPositionToDot(pos: string): string {
  const m = (pos || "").match(/(-?[\d.]+)%\s+(-?[\d.]+)%/);
  if (m) return `left: ${m[1]}%; top: ${m[2]}%;`;
  return `left: 50%; top: 50%;`;
}
