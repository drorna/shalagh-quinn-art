/**
 * Murals canvas — Supabase-backed free-positioning collage.
 *
 * View mode  : tiles are absolutely positioned in %; just shown, links work.
 * Edit mode  : ?edit=<token> unlocks an InDesign-style canvas —
 *              drag body to move, 8 handles to resize, X to delete,
 *              floating mini-panel for label/link/rotation/object-position,
 *              keyboard: Esc deselect, Delete delete, Shift+resize keeps aspect.
 *              Every change is saved to Supabase immediately. Realtime sync
 *              keeps the second computer up to date.
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

const EDIT_TOKEN_HASH = "1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67";
const LOCAL_STORAGE_KEY = "shalagh.murals.editToken";

const MIN_TILE_PCT = 4;       // smallest tile size (% of canvas)
const DEFAULT_TILE_PCT = 20;  // default tile size when adding
const CANVAS_MIN_HEIGHT_PX = 800;

let canvas: HTMLElement | null = null;
let tiles: MuralTile[] = [];
let editMode = false;
let selectedId: string | null = null;
let topZ = 1;
let pageSlug: string = "home";

export function initMuralsBoard(slug: string = "home"): void {
  pageSlug = slug;
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

  if (tokenFromUrl && tokenFromUrl !== "1") {
    const hash = await sha256Hex(tokenFromUrl);
    if (hash === EDIT_TOKEN_HASH) {
      try { localStorage.setItem(LOCAL_STORAGE_KEY, tokenFromUrl); } catch {}
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
  canvas = document.querySelector<HTMLElement>("[data-mural-canvas]");
  if (!canvas) return;

  // Tile styles are global — JS-created DOM doesn't pick up Astro's scoped CSS.
  injectGlobalTileStyles();

  editMode = await checkEditAccess();
  if (editMode) {
    document.body.classList.add("is-mural-edit");
    injectEditorStyles();
    mountToolbar();
    mountPanel();
    bindKeyboard();
    canvas.addEventListener("mousedown", (e) => {
      // Click on empty canvas → deselect
      if (e.target === canvas) selectTile(null);
    });
  }

  await loadAndRender();

  // Re-compute tile positions/sizes when the window resizes (they live in
  // % of canvas WIDTH, but top/height are pre-computed to px).
  let resizeRaf: number | null = null;
  window.addEventListener("resize", () => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      reapplyAllTileStyles();
    });
  });

  // Realtime sync
  supabase
    .channel("mural_tiles_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "mural_tiles" },
      () => loadAndRender()
    )
    .subscribe();
}

async function loadAndRender() {
  tiles = await fetchTiles(pageSlug);
  // Initialise topZ from existing tiles' order_idx (used as z-index)
  topZ = tiles.reduce((m, t) => Math.max(m, t.order_idx || 0), 0) + 1;
  render();
}

function render() {
  if (!canvas) return;
  // Clear (keep canvas itself, drop children)
  canvas.innerHTML = "";

  if (tiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "murals-canvas__loading";
    empty.textContent = editMode ? "empty — click + add image to start" : "";
    canvas.appendChild(empty);
  }

  for (const t of tiles) canvas.appendChild(buildTileEl(t));

  resizeCanvasHeight();
  refreshSelection();
}

/** Derive an automatic href when a label is set but no href is. */
function autoHrefFor(t: MuralTile): string | null {
  if (t.href) return t.href;
  if (!t.label) return null;
  const slug = t.label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug ? `/murals/${slug}/` : null;
}

function buildTileEl(t: MuralTile): HTMLElement {
  const effectiveHref = autoHrefFor(t);
  const el = document.createElement(effectiveHref && !editMode ? "a" : "div") as HTMLElement;
  el.className = "mural-tile";
  el.dataset.id = t.id;
  if (effectiveHref && !editMode) (el as HTMLAnchorElement).href = effectiveHref;
  // In edit mode the outer tile must allow overflow (handles live outside).
  // The image is clipped by an inner wrapper.
  if (editMode) el.style.overflow = "visible";
  applyTileStyle(el, t);

  // Inner wrapper clips the image to the tile bounds
  const inner = document.createElement("div");
  inner.className = "mural-tile__inner";
  el.appendChild(inner);

  const img = document.createElement("img");
  img.className = "mural-tile__img";
  img.src = t.src;
  img.alt = t.alt || "";
  img.loading = "lazy";
  img.style.objectPosition = t.object_position || "center";
  img.draggable = false;
  inner.appendChild(img);

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

/**
 * Apply position/size to a tile element.
 *
 * Important: all of t.x, t.y, t.w, t.h are percentages of the canvas WIDTH.
 * The canvas height changes as you scroll/drag, but tile dimensions never
 * track it — that decoupling is what stops the runaway-grow loop where
 * larger canvas → larger tiles → still-larger canvas.
 */
function applyTileStyle(el: HTMLElement, t: MuralTile) {
  const cw = canvas ? canvas.getBoundingClientRect().width : 0;
  el.style.left = `${t.x}%`;          // % of width — natural CSS behaviour
  el.style.width = `${t.w}%`;          // % of width
  el.style.top = `${(t.y / 100) * cw}px`;   // % of width, computed to px
  el.style.height = `${(t.h / 100) * cw}px`;
  el.style.zIndex = String(t.order_idx || 0);
  el.style.transform = t.rotation ? `rotate(${t.rotation}deg)` : "";
}

/** Re-apply styles to every tile (called on window resize). */
function reapplyAllTileStyles() {
  if (!canvas) return;
  for (const t of tiles) {
    const el = canvas.querySelector<HTMLElement>(`.mural-tile[data-id="${t.id}"]`);
    if (el) applyTileStyle(el, t);
  }
  resizeCanvasHeight();
}

function resizeCanvasHeight() {
  if (!canvas) return;
  // All tile dimensions are % of canvas WIDTH, so the bottom-most tile's
  // pixel position is (max(y + h) / 100) * canvasWidth — independent of
  // the canvas's current height. This is what avoids the feedback loop.
  const baseW = canvas.getBoundingClientRect().width;
  const baseFloor = Math.max(CANVAS_MIN_HEIGHT_PX, window.innerHeight * 1.5);
  const bottomPct = tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
  const bottomPx = (bottomPct / 100) * baseW;
  const desired = Math.max(baseFloor, bottomPx + window.innerHeight);
  canvas.style.height = `${Math.round(desired)}px`;
}

/**
 * Auto-scroll the page when the cursor approaches the top/bottom edge of the
 * viewport during a drag or resize. Kept running on a rAF loop while the
 * caller is actively dragging.
 */
let autoScrollY = 0;
let autoScrollRaf: number | null = null;
let lastDragClientX = 0;
let lastDragClientY = 0;
let onAutoScrollTick: (() => void) | null = null;
function setAutoScroll(clientY: number, onTick?: () => void) {
  // Wider trigger zone + much higher peak speed.
  // Curve is quadratic so the edge ramps up aggressively but it's gentle
  // in the middle of the trigger band.
  const edge = 160;      // px from edge to start
  const maxSpeed = 60;   // px per frame at the very edge
  let speed = 0;
  if (clientY < edge) {
    const t = (edge - clientY) / edge;          // 0..1
    speed = -Math.round(t * t * maxSpeed);
  } else if (clientY > window.innerHeight - edge) {
    const t = (clientY - (window.innerHeight - edge)) / edge;
    speed = Math.round(t * t * maxSpeed);
  }
  autoScrollY = speed;
  if (onTick) onAutoScrollTick = onTick;
  lastDragClientY = clientY;
  if (autoScrollY !== 0 && autoScrollRaf === null) {
    const tick = () => {
      if (autoScrollY === 0) { autoScrollRaf = null; return; }
      window.scrollBy(0, autoScrollY);
      // Run the caller's callback so the dragged tile follows the scroll
      // without needing more mouse movement.
      if (onAutoScrollTick) onAutoScrollTick();
      autoScrollRaf = requestAnimationFrame(tick);
    };
    autoScrollRaf = requestAnimationFrame(tick);
  }
}
function stopAutoScroll() {
  autoScrollY = 0;
  onAutoScrollTick = null;
  if (autoScrollRaf !== null) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = null;
  }
}

/* ============================================================
   EDIT MODE INTERACTIONS
   ============================================================ */

function selectTile(id: string | null) {
  selectedId = id;
  // Bring selected tile to front
  if (id) {
    const t = tiles.find((x) => x.id === id);
    if (t) {
      topZ += 1;
      t.order_idx = topZ;
      const el = canvas?.querySelector<HTMLElement>(`.mural-tile[data-id="${id}"]`);
      if (el) el.style.zIndex = String(topZ);
      void upsertTile(t);
    }
  }
  refreshSelection();
  renderPanel();
}

function refreshSelection() {
  if (!canvas) return;
  // Remove existing handles
  canvas.querySelectorAll(".mural-handle, .mural-delete").forEach((n) => n.remove());

  for (const el of canvas.querySelectorAll<HTMLElement>(".mural-tile")) {
    const isSel = el.dataset.id === selectedId;
    el.classList.toggle("is-selected", isSel);
    if (isSel) attachHandles(el);
  }
}

function attachHandles(el: HTMLElement) {
  const t = tiles.find((x) => x.id === el.dataset.id);
  if (!t) return;

  // 8 resize handles
  const positions: Array<["nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w", string]> = [
    ["nw", "left:-6px;top:-6px;cursor:nwse-resize"],
    ["n",  "left:50%;top:-6px;transform:translateX(-50%);cursor:ns-resize"],
    ["ne", "right:-6px;top:-6px;cursor:nesw-resize"],
    ["e",  "right:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize"],
    ["se", "right:-6px;bottom:-6px;cursor:nwse-resize"],
    ["s",  "left:50%;bottom:-6px;transform:translateX(-50%);cursor:ns-resize"],
    ["sw", "left:-6px;bottom:-6px;cursor:nesw-resize"],
    ["w",  "left:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize"],
  ];
  for (const [dir, style] of positions) {
    const h = document.createElement("div");
    h.className = `mural-handle mural-handle--${dir}`;
    h.dataset.dir = dir;
    h.setAttribute("style", style);
    el.appendChild(h);
    bindResize(h, el, t, dir);
  }

  // Delete button (top-right, outside the tile)
  const del = document.createElement("button");
  del.type = "button";
  del.className = "mural-delete";
  del.title = "delete tile (or press Delete)";
  del.textContent = "×";
  del.addEventListener("mousedown", (e) => e.stopPropagation());
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await removeTile(t);
  });
  el.appendChild(del);
}

function attachEditHandlers(el: HTMLElement, t: MuralTile) {
  el.addEventListener("mousedown", (e) => {
    // Ignore clicks on handles/delete; they have their own listeners
    const target = e.target as HTMLElement;
    if (target.closest(".mural-handle, .mural-delete")) return;

    e.preventDefault();
    // Begin a tentative drag. If movement < 3px → treat as click.
    const startX = e.clientX;
    const startY = e.clientY;
    const scrollAtStart = window.scrollY;
    const startLeft = t.x;
    const startTop = t.y;
    let dragging = false;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 3) {
        dragging = true;
        selectTile(t.id);
      }
      if (dragging) {
        moveTile(ev.clientX, ev.clientY);
      }
    };
    // Recompute position using a given mouse client coordinate. Called both
    // by mousemove and by the auto-scroll loop (when the cursor is parked
    // near an edge and the page is scrolling under it).
    const moveTile = (clientX: number, clientY: number) => {
      lastDragClientX = clientX;
      lastDragClientY = clientY;
      const cr = canvas!.getBoundingClientRect();
      // dx/dy in pixels: account for page scroll that happened during the drag
      const dx = clientX - startX;
      const dy = (clientY + window.scrollY) - (startY + scrollAtStart);
      const dxPct = (dx / cr.width) * 100;
      const dyPct = (dy / cr.width) * 100;
      t.x = clamp(startLeft + dxPct, 0, 100 - t.w);
      t.y = Math.max(0, startTop + dyPct);
      el.style.left = `${t.x}%`;
      el.style.top = `${(t.y / 100) * cr.width}px`;
      resizeCanvasHeight();
      setAutoScroll(clientY, () => moveTile(lastDragClientX, lastDragClientY));
    };
    const onUp = async () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      stopAutoScroll();
      if (!dragging) {
        // Plain click → select
        selectTile(t.id);
      } else {
        await upsertTile(t);
        resizeCanvasHeight();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function bindResize(
  handle: HTMLElement,
  tileEl: HTMLElement,
  t: MuralTile,
  dir: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const scrollAtStart = window.scrollY;
    const startLeft = t.x;
    const startTop = t.y;
    const startW = t.w;
    const startH = t.h;
    const aspect = startW / startH;

    const onMove = (ev: MouseEvent) => {
      runResize(ev.clientX, ev.clientY, ev.shiftKey);
    };
    const runResize = (clientX: number, clientY: number, shiftKey: boolean) => {
      const canvasRect = canvas!.getBoundingClientRect();
      // dy includes page-scroll that happened mid-resize
      const dx = clientX - startX;
      const dy = (clientY + window.scrollY) - (startY + scrollAtStart);
      const dxPct = (dx / canvasRect.width) * 100;
      const dyPct = (dy / canvasRect.width) * 100;
      let newL = startLeft, newT = startTop, newW = startW, newH = startH;

      if (dir.includes("e")) newW = Math.max(MIN_TILE_PCT, startW + dxPct);
      if (dir.includes("w")) { newW = Math.max(MIN_TILE_PCT, startW - dxPct); newL = startLeft + (startW - newW); }
      if (dir.includes("s")) newH = Math.max(MIN_TILE_PCT, startH + dyPct);
      if (dir.includes("n")) { newH = Math.max(MIN_TILE_PCT, startH - dyPct); newT = startTop + (startH - newH); }

      // Shift = keep aspect ratio (corner only)
      if (shiftKey && (dir === "nw" || dir === "ne" || dir === "se" || dir === "sw")) {
        // Match the dominant axis change
        if (Math.abs(newW - startW) > Math.abs(newH - startH)) {
          const desiredH = newW / aspect;
          if (dir.includes("n")) newT = startTop + (startH - desiredH);
          newH = desiredH;
        } else {
          const desiredW = newH * aspect;
          if (dir.includes("w")) newL = startLeft + (startW - desiredW);
          newW = desiredW;
        }
      }

      // Clamp to canvas bounds
      newL = clamp(newL, 0, 100 - MIN_TILE_PCT);
      newT = Math.max(0, newT);
      newW = clamp(newW, MIN_TILE_PCT, 100 - newL);
      newH = Math.max(MIN_TILE_PCT, newH);

      t.x = newL; t.y = newT; t.w = newW; t.h = newH;
      const cw = canvasRect.width;
      tileEl.style.left = `${t.x}%`;
      tileEl.style.width = `${t.w}%`;
      tileEl.style.top = `${(t.y / 100) * cw}px`;
      tileEl.style.height = `${(t.h / 100) * cw}px`;
      // Sync side-panel sliders if open
      syncPanelSliders(t);
      // Grow canvas + auto-scroll near edges (matches drag behaviour)
      resizeCanvasHeight();
      setAutoScroll(clientY, () => runResize(lastDragClientX, lastDragClientY, shiftKey));
      lastDragClientX = clientX;
      lastDragClientY = clientY;
    };
    const onUp = async () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      stopAutoScroll();
      await upsertTile(t);
      resizeCanvasHeight();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

async function removeTile(t: MuralTile) {
  if (!confirm("Delete this image?")) return;
  await deleteImageFile(t.src);
  await deleteTile(t.id);
  tiles = tiles.filter((x) => x.id !== t.id);
  if (selectedId === t.id) selectedId = null;
  render();
  renderPanel();
}

function bindKeyboard() {
  window.addEventListener("keydown", async (e) => {
    if (!editMode) return;
    if (e.key === "Escape") {
      selectTile(null);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (!selectedId) return;
      const t = tiles.find((x) => x.id === selectedId);
      if (!t) return;
      // Avoid accidental delete while typing in panel
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
      e.preventDefault();
      await removeTile(t);
    }
  });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/* ============================================================
   TOOLBAR (top) + FLOATING PANEL
   ============================================================ */

function mountToolbar() {
  const bar = document.createElement("div");
  bar.className = "mural-edit-toolbar";
  bar.innerHTML = `
    <span class="mural-edit-toolbar__title">murals editor</span>
    <label class="mural-edit-toolbar__btn">
      + add image
      <input type="file" accept="image/*" multiple hidden data-add-files />
    </label>
    <span class="mural-edit-toolbar__hint">drag = move · corners = resize · Shift = keep ratio · Esc / Delete</span>
    <span class="mural-edit-toolbar__save" data-save-indicator></span>
    <a class="mural-edit-toolbar__exit" href="?">exit edit</a>
  `;
  document.body.appendChild(bar);

  bar.querySelector<HTMLInputElement>("[data-add-files]")?.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;
    for (const f of Array.from(input.files)) await addImage(f);
    input.value = "";
  });

  // Wire up save indicator
  const indicator = bar.querySelector<HTMLElement>("[data-save-indicator]");
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("mural:save", (e) => {
    if (!indicator) return;
    const detail = (e as CustomEvent).detail;
    const ok = detail?.ok !== false;
    indicator.textContent = ok ? "saved ✓" : "save failed!";
    indicator.classList.remove("is-ok", "is-err", "is-visible");
    indicator.classList.add(ok ? "is-ok" : "is-err", "is-visible");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => indicator.classList.remove("is-visible"), 1800);
  });
}

async function addImage(file: File) {
  const up = await uploadImageFile(file);
  if (!up) { alert("Upload failed. See console."); return; }

  const { naturalW, naturalH } = await readImageSize(up.src);
  const w = DEFAULT_TILE_PCT;
  const h = Math.max(MIN_TILE_PCT, w * (naturalH / naturalW));

  // Place the new tile at the user's current viewport, not at the top.
  // Convert "viewport center" → tile y in % of canvas width.
  const canvasRect = canvas!.getBoundingClientRect();
  const viewportCenterAbs = window.scrollY + window.innerHeight / 2;
  const canvasTopAbs = window.scrollY + canvasRect.top;
  const offsetIntoCanvasPx = viewportCenterAbs - canvasTopAbs - (h / 100) * canvasRect.width / 2;
  const yPct = Math.max(0, (offsetIntoCanvasPx / canvasRect.width) * 100);
  // Centre horizontally
  const xPct = Math.max(0, (100 - w) / 2);

  topZ += 1;
  const t: MuralTile = {
    id: crypto.randomUUID(),
    src: up.src,
    alt: file.name.replace(/\.[^.]+$/, ""),
    x: xPct,
    y: yPct,
    w,
    h,
    rotation: 0,
    object_position: "center",
    label: null,
    href: null,
    order_idx: topZ,
    page: pageSlug,
  };
  await upsertTile(t);
  tiles.push(t);
  render();
  selectTile(t.id);
}

function readImageSize(src: string): Promise<{ naturalW: number; naturalH: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ naturalW: img.naturalWidth, naturalH: img.naturalHeight });
    img.onerror = () => resolve({ naturalW: 1, naturalH: 1 });
    img.src = src;
  });
}

function mountPanel() {
  const panel = document.createElement("aside");
  panel.className = "mural-mini-panel";
  panel.dataset.panel = "";
  panel.style.display = "none";
  document.body.appendChild(panel);
}

function renderPanel() {
  const panel = document.querySelector<HTMLElement>("[data-panel]");
  if (!panel) return;
  const t = tiles.find((x) => x.id === selectedId);
  if (!t) {
    panel.style.display = "none";
    return;
  }
  // Pin the panel to the top-right of the viewport so it never covers a tile
  panel.style.display = "block";
  panel.style.position = "fixed";
  panel.style.right = "16px";
  panel.style.top = "80px";
  panel.style.left = "auto";

  panel.innerHTML = `
    <div class="mural-mini-panel__head">
      <strong>tile</strong>
      <button class="mural-mini-panel__close" type="button">×</button>
    </div>
    <label class="mural-mini-row">
      <span>label</span>
      <input type="text" value="${escapeAttr(t.label || "")}" data-field="label" placeholder='e.g. "nepal"' />
    </label>
    <label class="mural-mini-row">
      <span>link</span>
      <input type="text" value="${escapeAttr(t.href || "")}" data-field="href" placeholder='e.g. "/murals/nepal/"' />
    </label>
    <label class="mural-mini-row">
      <span>rotation</span>
      <input type="range" min="-30" max="30" step="0.5" value="${t.rotation}" data-field="rotation" />
      <output>${t.rotation}°</output>
    </label>
    <div class="mural-mini-row">
      <span>object position</span>
      <div class="mural-mini-objpos" data-objpos>
        <div class="mural-mini-objpos__dot" style="${objectPositionToDot(t.object_position)}"></div>
      </div>
      <output data-objpos-out>${t.object_position}</output>
    </div>
  `;

  panel.querySelector(".mural-mini-panel__close")?.addEventListener("click", () => selectTile(null));

  panel.querySelectorAll<HTMLInputElement>("[data-field]").forEach((ctrl) => {
    ctrl.addEventListener("input", () => {
      const field = ctrl.dataset.field as keyof MuralTile;
      let v: any = ctrl.value;
      if (field === "rotation") v = parseFloat(v);
      if ((field === "label" || field === "href") && v === "") v = null;
      (t as any)[field] = v;
      const out = ctrl.parentElement?.querySelector("output");
      if (out && field === "rotation") out.textContent = `${v}°`;
      const tEl = canvas!.querySelector<HTMLElement>(`.mural-tile[data-id="${t.id}"]`);
      if (tEl) {
        if (field === "rotation") tEl.style.transform = v ? `rotate(${v}deg)` : "";
        if (field === "label") {
          // Re-render that tile only
          const newEl = buildTileEl(t);
          tEl.replaceWith(newEl);
        }
      }
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
      const x = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
      const y = clamp(((e.clientY - r.top) / r.height) * 100, 0, 100);
      const v = `${Math.round(x)}% ${Math.round(y)}%`;
      t.object_position = v;
      if (padOut) padOut.textContent = v;
      const dot = pad.querySelector<HTMLElement>(".mural-mini-objpos__dot");
      if (dot) { dot.style.left = `${x}%`; dot.style.top = `${y}%`; }
      const img = canvas!.querySelector<HTMLImageElement>(`.mural-tile[data-id="${t.id}"] .mural-tile__img`);
      if (img) img.style.objectPosition = v;
    };
    pad.addEventListener("mousedown", (e) => { dragging = true; update(e); });
    window.addEventListener("mousemove", (e) => { if (dragging) update(e); });
    window.addEventListener("mouseup", () => { if (dragging) { dragging = false; upsertTile(t); } });
  }
}

function syncPanelSliders(_t: MuralTile) {
  // (Optional) Could update width/height shown in panel if we expose them.
}

/* ============================================================
   STYLES
   ============================================================ */

function injectGlobalTileStyles() {
  if (document.getElementById("mural-tile-styles")) return;
  const s = document.createElement("style");
  s.id = "mural-tile-styles";
  s.textContent = `
    .mural-tile {
      position: absolute;
      display: block;
      line-height: 0;
      color: #fff;
      background: #111;
      transform-origin: center center;
      transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1);
      box-sizing: border-box;
    }
    .mural-tile__inner {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }
    .mural-tile__img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      pointer-events: none;
      user-select: none;
      -webkit-user-drag: none;
    }
    .mural-tile:hover .mural-tile__img { opacity: 0.94; }
    .mural-tile__label {
      position: absolute;
      right: 14px;
      bottom: 14px;
      color: #fff;
      font-family: "Caveat", "Patrick Hand", cursive;
      font-weight: 700;
      font-size: clamp(2.2rem, 3.6vw, 3.6rem);
      line-height: 0.95;
      text-align: right;
      text-shadow: 0 2px 16px rgba(0, 0, 0, 0.85), 0 0 4px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      z-index: 2;
      letter-spacing: 0.01em;
    }
    .mural-tile__label-arrow {
      display: block;
      margin-top: 2px;
      font-weight: 700;
      font-size: 0.85em;
    }
  `;
  document.head.appendChild(s);
}

function injectEditorStyles() {
  if (document.getElementById("mural-edit-styles")) return;
  const s = document.createElement("style");
  s.id = "mural-edit-styles";
  s.textContent = `
    body.is-mural-edit .murals-page { padding-bottom: 100px; }
    /* Keep the back arrow fully usable in edit mode — site navigation
       should work exactly like the public site, just with the editor
       layered on top. */
    body.is-mural-edit .mural-tile { cursor: grab; }
    body.is-mural-edit .mural-tile:active { cursor: grabbing; }
    body.is-mural-edit .mural-tile.is-selected { outline: 2px solid #4cc2ff; outline-offset: 0; }

    .mural-handle {
      position: absolute;
      width: 12px;
      height: 12px;
      background: #fff;
      border: 1px solid #4cc2ff;
      box-sizing: border-box;
      z-index: 10;
    }

    .mural-delete {
      position: absolute;
      top: -28px;
      right: -2px;
      width: 26px;
      height: 26px;
      background: #fff;
      color: #000;
      border: 1px solid #4cc2ff;
      border-radius: 50%;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 0;
      z-index: 11;
      font-weight: bold;
    }
    .mural-delete:hover { background: #ff5a5a; color: #fff; border-color: #ff5a5a; }

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
    .mural-edit-toolbar__title { font-weight: bold; color: #4cc2ff; }
    .mural-edit-toolbar__btn {
      padding: 8px 14px;
      background: #4cc2ff;
      color: #000;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      font-weight: bold;
      font-family: monospace;
    }
    .mural-edit-toolbar__hint { color: #888; font-size: 12px; }
    .mural-edit-toolbar__exit {
      color: #aaa;
      padding: 6px 10px;
      text-decoration: underline;
    }
    .mural-edit-toolbar__save {
      margin-left: auto;
      padding: 4px 10px;
      border-radius: 3px;
      font-weight: bold;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .mural-edit-toolbar__save.is-visible {
      opacity: 1;
      transform: translateY(0);
    }
    .mural-edit-toolbar__save.is-ok { background: #2a4; color: #fff; }
    .mural-edit-toolbar__save.is-err { background: #c33; color: #fff; }

    .mural-mini-panel {
      position: absolute;
      width: 260px;
      background: #161616;
      color: #fff;
      font-family: monospace;
      font-size: 12px;
      padding: 12px;
      border-radius: 4px;
      border: 1px solid #444;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      z-index: 999;
    }
    .mural-mini-panel__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .mural-mini-panel__close { background: none; border: 0; color: #aaa; font-size: 18px; cursor: pointer; }
    .mural-mini-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
    .mural-mini-row > span { color: #888; font-size: 11px; }
    .mural-mini-row input[type="text"] {
      background: #222; color: #fff; border: 1px solid #555; padding: 5px; border-radius: 3px;
      font-family: monospace; font-size: 12px;
    }
    .mural-mini-row input[type="range"] { width: 100%; }
    .mural-mini-objpos {
      position: relative; width: 100%; height: 80px;
      background: #222; border: 1px solid #555; cursor: crosshair;
    }
    .mural-mini-objpos__dot {
      position: absolute; width: 10px; height: 10px;
      background: #4cc2ff; border-radius: 50%;
      transform: translate(-50%, -50%); pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function objectPositionToDot(pos: string): string {
  const m = (pos || "").match(/(-?[\d.]+)%\s+(-?[\d.]+)%/);
  if (m) return `left: ${m[1]}%; top: ${m[2]}%;`;
  return `left: 50%; top: 50%;`;
}
