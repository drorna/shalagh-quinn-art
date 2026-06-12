/**
 * Live image / logo editor.
 *
 * Marks any element with [data-editable-image="<id>"]:
 *   - On every load: applies overrides from public.site_image
 *     (src swap, width/height, offset, scale, rotation, filter).
 *   - In edit mode (?edit=<token>): click → handles + floating toolbar
 *     (Replace, size sliders, rotation slider, Reset). Drag any handle
 *     to resize; drag the body to nudge offset. Auto-save to Supabase
 *     on each change.
 *
 * Re-uses the same SHA-256 edit-token gate as the other editors and
 * shares the "mural:save" indicator event.
 */
import {
  fetchAllSiteImages,
  upsertSiteImage,
  subscribeSiteImages,
  uploadSiteImageFile,
  effectiveVariantId,
  type SiteImage,
} from "../lib/supabase";

const EDIT_TOKEN_HASH = "1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67";
const LOCAL_STORAGE_KEY = "shalagh.murals.editToken";

let editMode = false;
let cache: Map<string, SiteImage> = new Map();
let selected: HTMLElement | null = null;
let toolbar: HTMLElement | null = null;

export function initImageEditor(): void {
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

async function checkEditAccess(): Promise<boolean> {
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
  editMode = await checkEditAccess();
  injectStyles();
  autoTagImages();
  cache = await fetchAllSiteImages();
  applyAll();

  if (editMode) {
    document.body.classList.add("is-image-edit");
    mountToolbar();
    bindHover();
    document.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (
        !t.closest("[data-editable-image]") &&
        !t.closest(".image-edit-toolbar") &&
        !t.closest(".img-handle")
      ) {
        unselect();
      }
    });
  }

  subscribeSiteImages(async () => {
    cache = await fetchAllSiteImages();
    applyAll();
    if (selected) renderToolbar(selected);
  });
}

function getEditableImages(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editable-image]"));
}

/**
 * Walk the document and tag every meaningful <img> with a stable
 * auto-id so brand-new pages get image editing for free. Id derived
 * from pathname + tag + nth-of-type.
 *
 * Skipped:
 *   - elements that already have data-editable-image
 *   - tiles inside the murals canvas (they have their own editor)
 *   - icons inside toolbars / panels
 */
function autoTagImages() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const skipInside =
    ".murals-canvas, .mural-tile, .mural-edit-toolbar, .mural-edit-panel, .mural-mini-panel, " +
    ".text-edit-toolbar, .image-edit-toolbar, [data-editable-image]";
  const seen = new Map<string, number>();
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
    if (img.closest("[data-editable-image]")) continue;
    if (img.closest(skipInside)) continue;
    // Skip tiny decorative icons (under 16px)
    if (img.complete && img.naturalWidth && img.naturalWidth < 16) continue;

    const parent = img.parentElement;
    let nth = 1;
    if (parent) {
      const siblings = Array.from(parent.querySelectorAll("img"));
      nth = siblings.indexOf(img) + 1;
    }
    const base = `auto-img:${path}:${nth}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const id = count > 1 ? `${base}#${count}` : base;

    // Wrap the img in a span so handles + transforms apply cleanly.
    const wrapper = document.createElement("span");
    wrapper.dataset.editableImage = id;
    wrapper.style.display = img.style.display === "block" ? "inline-block" : "inline-block";
    img.parentElement?.insertBefore(wrapper, img);
    wrapper.appendChild(img);
  }
}

function applyAll() {
  for (const el of getEditableImages()) applyOverride(el);
}

function rowFor(baseId: string): SiteImage | undefined {
  return (
    cache.get(effectiveVariantId(baseId)) ||
    cache.get(`${baseId}@desktop`) ||
    cache.get(baseId)
  );
}

function applyOverride(el: HTMLElement) {
  const baseId = el.dataset.editableImage!;
  const row = rowFor(baseId);
  if (!row) {
    // Reset wrapper styles we might have added
    el.style.removeProperty("transform");
    el.style.removeProperty("filter");
    return;
  }
  // Swap src on <img> children (Astro <Image> renders an <img>)
  if (row.src) {
    const img = el.tagName === "IMG" ? (el as HTMLImageElement) : el.querySelector<HTMLImageElement>("img");
    if (img && img.src !== row.src) {
      img.src = row.src;
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
    }
  }
  if (row.width)           el.style.width  = row.width;
  if (row.height)          el.style.height = row.height;
  if (row.object_position) {
    const img = el.tagName === "IMG" ? (el as HTMLImageElement) : el.querySelector<HTMLImageElement>("img");
    if (img) img.style.objectPosition = row.object_position;
  }

  const tx = row.offset_x || "0px";
  const ty = row.offset_y || "0px";
  const rot = row.rotation || 0;
  const scl = row.scale || 1;
  const transform = `translate(${tx}, ${ty}) rotate(${rot}deg) scale(${scl})`;
  el.style.transform = transform;
  el.style.transformOrigin = "center center";
  el.style.filter = row.filter || "";
}

/* ===================== Edit interactions ===================== */

function bindHover() {
  for (const el of getEditableImages()) {
    el.classList.add("is-editable-image");
    el.addEventListener("pointerdown", onMouseDown as any);
  }
}

function onMouseDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  const target = e.target as HTMLElement;
  if (target.closest(".img-handle, .image-edit-toolbar")) return;

  e.preventDefault();
  e.stopPropagation();

  // Click vs drag detection
  const startX = e.clientX;
  const startY = e.clientY;
  const initial = rowFor(el.dataset.editableImage!) || ({} as SiteImage);
  const x0 = parsePx(initial.offset_x);
  const y0 = parsePx(initial.offset_y);
  let dragging = false;

  try { el.setPointerCapture(e.pointerId); } catch {}

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) > 3) {
      dragging = true;
      select(el);
    }
    if (dragging) {
      updateRow(el, {
        offset_x: `${Math.round(x0 + dx)}px`,
        offset_y: `${Math.round(y0 + dy)}px`,
      });
      applyOverride(el);
      positionToolbar(el);
    }
  };
  const up = async () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    if (!dragging) {
      select(el);
    } else {
      const variantId = effectiveVariantId(el.dataset.editableImage!);
      const row = cache.get(variantId);
      if (row) await upsertSiteImage(row);
    }
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function select(el: HTMLElement) {
  if (selected && selected !== el) unselect();
  selected = el;
  el.classList.add("is-image-selected");
  attachHandles(el);
  renderToolbar(el);
  positionToolbar(el);
}

function unselect() {
  if (!selected) return;
  selected.classList.remove("is-image-selected");
  selected.querySelectorAll(".img-handle").forEach((h) => h.remove());
  if (toolbar) toolbar.style.display = "none";
  selected = null;
}

function attachHandles(el: HTMLElement) {
  el.querySelectorAll(".img-handle").forEach((h) => h.remove());
  const corners: Array<["nw" | "ne" | "se" | "sw", string]> = [
    ["nw", "left:-7px;top:-7px;cursor:nwse-resize"],
    ["ne", "right:-7px;top:-7px;cursor:nesw-resize"],
    ["se", "right:-7px;bottom:-7px;cursor:nwse-resize"],
    ["sw", "left:-7px;bottom:-7px;cursor:nesw-resize"],
  ];
  for (const [dir, style] of corners) {
    const h = document.createElement("div");
    h.className = `img-handle img-handle--${dir}`;
    h.setAttribute("style", style);
    el.appendChild(h);
    bindResize(h, el, dir);
  }
}

function bindResize(handle: HTMLElement, el: HTMLElement, dir: "nw" | "ne" | "se" | "sw") {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const r = el.getBoundingClientRect();
    const startW = r.width;
    const aspect = r.width / Math.max(1, r.height);
    const dirX = dir === "ne" || dir === "se" ? 1 : -1;

    try { handle.setPointerCapture(e.pointerId); } catch {}

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * dirX;
      const newW = Math.max(20, startW + dx);
      updateRow(el, {
        width:  `${Math.round(newW)}px`,
        height: `${Math.round(newW / aspect)}px`,
      });
      applyOverride(el);
      positionToolbar(el);
    };
    const up = async () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      const row = cache.get(effectiveVariantId(el.dataset.editableImage!));
      if (row) await upsertSiteImage(row);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function updateRow(el: HTMLElement, patch: Partial<SiteImage>): SiteImage {
  const baseId = el.dataset.editableImage!;
  const variantId = effectiveVariantId(baseId);
  const current = cache.get(variantId) || rowFor(baseId) || ({
    id: variantId, src: null, width: null, height: null,
    offset_x: null, offset_y: null, rotation: 0, scale: 1, filter: null, object_position: null,
  } as SiteImage);
  const next = { ...current, id: variantId, ...patch } as SiteImage;
  cache.set(variantId, next);
  return next;
}

function parsePx(v: string | null | undefined): number {
  if (!v) return 0;
  const m = v.match(/(-?[\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/* ===================== Toolbar ===================== */

function mountToolbar() {
  toolbar = document.createElement("div");
  toolbar.className = "image-edit-toolbar";
  toolbar.dataset.noEdit = "";
  toolbar.style.display = "none";
  document.body.appendChild(toolbar);
}

function positionToolbar(el: HTMLElement) {
  if (!toolbar) return;
  toolbar.style.display = "flex";
  if (window.matchMedia("(max-width: 767px)").matches) {
    toolbar.style.position = "fixed";
    toolbar.style.left = "0";
    toolbar.style.right = "0";
    toolbar.style.bottom = "0";
    toolbar.style.top = "auto";
    toolbar.classList.add("is-mobile");
  } else {
    const r = el.getBoundingClientRect();
    toolbar.style.position = "fixed";
    toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 420, r.left))}px`;
    toolbar.style.top  = `${Math.max(8, r.top - 56)}px`;
    toolbar.style.right = "auto";
    toolbar.style.bottom = "auto";
    toolbar.classList.remove("is-mobile");
  }
}

function renderToolbar(el: HTMLElement) {
  if (!toolbar) return;
  const baseId = el.dataset.editableImage!;
  const id = effectiveVariantId(baseId);
  const row = rowFor(baseId) || ({} as SiteImage);

  toolbar.innerHTML = `
    <label class="ie-btn">
      replace
      <input type="file" accept="image/*" hidden data-replace />
    </label>
    <label class="ie-field" title="rotation">
      rot
      <input type="range" min="-180" max="180" step="1" value="${row.rotation ?? 0}" data-field="rotation" />
      <output>${Math.round(row.rotation ?? 0)}°</output>
    </label>
    <label class="ie-field" title="scale">
      scale
      <input type="range" min="0.2" max="3" step="0.01" value="${row.scale ?? 1}" data-field="scale" />
      <output>${(row.scale ?? 1).toFixed(2)}</output>
    </label>
    <button class="ie-btn ie-reset" type="button" title="reset to defaults">⟲ reset</button>
  `;

  toolbar.querySelector<HTMLInputElement>("[data-replace]")!.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const url = await uploadSiteImageFile(file);
    if (!url) { alert("Upload failed (see console)"); return; }
    const next = updateRow(el, { src: url });
    applyOverride(el);
    await upsertSiteImage(next);
    input.value = "";
  });

  toolbar.querySelectorAll<HTMLInputElement>("[data-field]").forEach((ctrl) => {
    const out = ctrl.parentElement?.querySelector("output");
    ctrl.addEventListener("input", () => {
      const f = ctrl.dataset.field as "rotation" | "scale";
      const v = parseFloat(ctrl.value);
      updateRow(el, { [f]: v } as any);
      applyOverride(el);
      if (out) out.textContent = f === "rotation" ? `${Math.round(v)}°` : v.toFixed(2);
    });
    ctrl.addEventListener("change", async () => {
      const row = cache.get(id);
      if (row) await upsertSiteImage(row);
    });
  });

  toolbar.querySelector<HTMLButtonElement>(".ie-reset")!.addEventListener("click", async () => {
    const blank: SiteImage = {
      id, src: null, width: null, height: null,
      offset_x: null, offset_y: null, rotation: 0, scale: 1, filter: null, object_position: null,
    };
    cache.set(id, blank);
    // Restore original src on the underlying <img>: easiest way is to reload the page,
    // but we don't want to lose other edits, so just clear styles and let next nav refresh src.
    applyOverride(el);
    await upsertSiteImage(blank);
    renderToolbar(el);
  });
}

/* ===================== Styles ===================== */

function injectStyles() {
  if (document.getElementById("image-edit-styles")) return;
  const s = document.createElement("style");
  s.id = "image-edit-styles";
  s.textContent = `
    [data-editable-image] {
      display: inline-block;
      transform-origin: center center;
    }
    body.is-image-edit [data-editable-image].is-editable-image {
      cursor: move;
      transition: outline 120ms ease;
      position: relative;
    }
    body.is-image-edit [data-editable-image].is-editable-image:hover {
      outline: 1px dashed rgba(76, 194, 255, 0.65);
      outline-offset: 4px;
    }
    body.is-image-edit [data-editable-image].is-image-selected {
      outline: 2px solid #4cc2ff;
      outline-offset: 0;
    }
    .img-handle {
      position: absolute;
      width: 14px; height: 14px;
      background: #fff; border: 1px solid #4cc2ff;
      box-sizing: border-box;
      z-index: 50;
      border-radius: 2px;
    }
    .image-edit-toolbar {
      gap: 10px;
      align-items: center;
      background: #161616;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 6px 10px;
      font-family: monospace;
      font-size: 12px;
      color: #fff;
      z-index: 1100;
      box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      max-width: 100vw;
      overflow-x: auto;
    }
    .image-edit-toolbar.is-mobile {
      gap: 12px;
      padding: 10px 14px env(safe-area-inset-bottom);
      border-radius: 12px 12px 0 0;
      font-size: 14px;
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
    }
    .image-edit-toolbar.is-mobile .ie-btn { padding: 8px 14px; font-size: 14px; min-height: 38px; }
    .image-edit-toolbar.is-mobile .ie-field input[type="range"] { width: 130px; }
    .image-edit-toolbar .ie-btn {
      background: #4cc2ff; color: #000; border: 0; border-radius: 3px;
      padding: 5px 10px; cursor: pointer; font: inherit; font-weight: bold;
    }
    .image-edit-toolbar .ie-btn.ie-reset {
      background: #222; color: #aaa; border: 1px solid #555; font-weight: normal;
    }
    .image-edit-toolbar .ie-field {
      display: inline-flex; align-items: center; gap: 6px;
      color: #aaa;
    }
    .image-edit-toolbar .ie-field input[type="range"] { width: 110px; }
    .image-edit-toolbar .ie-field output { color: #fff; min-width: 36px; }
  `;
  document.head.appendChild(s);
}
