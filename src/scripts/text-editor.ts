/**
 * Live text + font editor.
 *
 * View mode  : looks up every editable element on the page in `site_text`
 *              and applies value / font_family / font_size / etc.
 * Edit mode  : same, plus a unified select → resize/move → edit-text model.
 *
 * Interaction model (uniform across desktop + mobile):
 *   1. Tap an editable element       → select it (handles + toolbar, no keyboard).
 *   2. Tap the body of the selected  → enter text editing (contenteditable, keyboard).
 *   3. Drag the body                 → move (offset_x / offset_y).
 *   4. Drag a corner handle          → resize: font_size scales with the box.
 *   5. Tap outside                   → deselect.
 *   6. On <a> / <button>             → toolbar exposes "open link" so navigation
 *                                      is an explicit action, never accidental.
 *
 * Positional fields (offset_x/y, rotation) are stored per viewport variant
 * and DO NOT fall back from desktop to mobile — each variant edits its own
 * position independently, so live mobile geometry matches edit-mode mobile.
 */
import {
  fetchAllSiteText,
  upsertSiteText,
  deleteSiteText,
  subscribeSiteText,
  effectiveVariantId,
  currentVariant,
  type SiteText,
} from "../lib/supabase";
import { startAlignGuides, endAlignGuides, computeAlignSnap } from "./align-guides";

const EDIT_TOKEN_HASH = "1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67";
const LOCAL_STORAGE_KEY = "shalagh.murals.editToken";

const FONT_CATALOGUE: { label: string; family: string; stack: string }[] = [
  { label: "Caveat (default handwritten)", family: "Caveat",            stack: '"Caveat", cursive' },
  { label: "Patrick Hand",                  family: "Patrick Hand",      stack: '"Patrick Hand", cursive' },
  { label: "Architects Daughter",           family: "Architects Daughter", stack: '"Architects Daughter", cursive' },
  { label: "Permanent Marker",              family: "Permanent Marker",  stack: '"Permanent Marker", sans-serif' },
  { label: "Shadows Into Light",            family: "Shadows Into Light", stack: '"Shadows Into Light", cursive' },
  { label: "Indie Flower",                  family: "Indie Flower",      stack: '"Indie Flower", cursive' },
  { label: "Kalam",                         family: "Kalam",             stack: '"Kalam", cursive' },
  { label: "Times New Roman",               family: "Times New Roman",   stack: '"Times New Roman", Times, serif' },
  { label: "Cormorant Garamond",            family: "Cormorant Garamond", stack: '"Cormorant Garamond", serif' },
  { label: "EB Garamond",                   family: "EB Garamond",       stack: '"EB Garamond", serif' },
  { label: "Playfair Display",              family: "Playfair Display",  stack: '"Playfair Display", serif' },
  { label: "Inter",                         family: "Inter",             stack: '"Inter", sans-serif' },
  { label: "Helvetica / Arial",             family: "Arial",             stack: 'Arial, "Helvetica Neue", sans-serif' },
];

let editMode = false;
let selectedEl: HTMLElement | null = null;
let editingEl: HTMLElement | null = null;
let toolbar: HTMLElement | null = null;
let textCache: Map<string, SiteText> = new Map();

export function initTextEditor(): void {
  if (typeof window === "undefined") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
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
  autoTagPlainText();

  textCache = await fetchAllSiteText();
  renderCustomBoxes();
  applyAllOverrides();
  preloadFontsInUse();

  if (editMode) {
    document.body.classList.add("is-text-edit");
    mountToolbar();
    bindEditClicks();
    patchInternalLinks();
    mountAddButton();
    const outside = (e: Event) => {
      const t = e.target as HTMLElement;
      if (
        t.closest("[data-editable-text]") ||
        t.closest(".text-edit-toolbar") ||
        t.closest(".te-handle") ||
        t.closest("[data-editable-image]") ||
        t.closest(".image-edit-toolbar") ||
        t.closest(".img-handle") ||
        t.closest(".edit-nav") ||
        t.closest("[data-no-edit]")
      ) return;
      // Outside click: exit editing + deselect
      if (editingEl) void exitEditing();
      unselect();
    };
    document.addEventListener("pointerdown", outside);
    // Outside clicks in the parent shell (when the toolbar is docked
    // out there) should also dismiss the selection.
    try {
      if (window.parent !== window) {
        window.parent.document.addEventListener("pointerdown", outside);
      }
    } catch {}
  }

  subscribeSiteText(async () => {
    textCache = await fetchAllSiteText();
    applyAllOverrides();
    preloadFontsInUse();
  });
}

function getEditableEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-editable-text]"));
}

/**
 * Free-floating "custom" text boxes the user added with the + button.
 * They're persisted as site_text rows whose id is `custom:<path>:<uid>`.
 * On every page load we look up rows for the current path and inject
 * the corresponding floating <div>s so visitors see them.
 */
function renderCustomBoxes() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const prefix = `custom:${path}:`;
  // Deduplicate by base id (strip the @variant suffix). One row per
  // base id is enough to know the box exists.
  const seen = new Set<string>();
  for (const id of textCache.keys()) {
    if (!id.startsWith(prefix)) continue;
    const baseId = id.replace(/@(mobile|desktop)$/, "");
    if (seen.has(baseId)) continue;
    seen.add(baseId);
    // Already rendered?
    if (document.querySelector(`[data-editable-text="${cssEscape(baseId)}"]`)) continue;
    const el = document.createElement("div");
    el.dataset.editableText = baseId;
    el.className = "custom-text-box";
    document.body.appendChild(el);
  }
  // Body needs to be a positioning context for the absolute boxes.
  if (seen.size > 0 && getComputedStyle(document.body).position === "static") {
    document.body.style.position = "relative";
  }
}

function cssEscape(s: string): string {
  // Astro's old TS lib doesn't ship CSS.escape on Document everywhere
  // — small fallback for the few characters we use in custom ids.
  return s.replace(/(["\\])/g, "\\$1");
}

/** Floating "+ text" button shown in edit mode so the user can drop a
 *  new text box anywhere on the page. */
function mountAddButton() {
  const btn = document.createElement("button");
  btn.className = "te-add-fab";
  btn.dataset.noEdit = "";
  btn.type = "button";
  btn.title = "add a new text box";
  btn.innerHTML = "+ text";
  document.body.appendChild(btn);
  btn.addEventListener("click", () => createCustomTextBox());
}

async function createCustomTextBox() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const uid = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`)
    .replace(/-/g, "").slice(0, 10);
  const baseId = `custom:${path}:${uid}`;
  const el = document.createElement("div");
  el.dataset.editableText = baseId;
  el.className = "custom-text-box";
  el.textContent = "new text — tap to edit";
  document.body.appendChild(el);
  if (getComputedStyle(document.body).position === "static") {
    document.body.style.position = "relative";
  }
  // Drop the box's CENTRE at the middle of the current viewport.
  // The custom-text-box CSS applies a -50%/-50% pre-transform so the
  // saved offset corresponds to where the centre lands.
  const vw = window.innerWidth;
  const initX = vw / 2;
  const initY = window.scrollY + 160;
  const xVw = `${((initX / vw) * 100).toFixed(2)}vw`;
  const yVw = `${((initY / vw) * 100).toFixed(2)}vw`;
  const variantId = effectiveVariantId(baseId);
  const row: SiteText = {
    id: variantId,
    value: "new text — tap to edit",
    font_family: null, font_size: null, font_weight: null, font_style: null,
    color: null, letter_spacing: null, line_height: null, text_align: null,
    offset_x: xVw, offset_y: yVw, rotation: 0,
  };
  textCache.set(variantId, row);
  await upsertSiteText(row);
  applyOverride(el);

  // Hook this brand-new element into the same click logic as the
  // auto-tagged ones, then select it so the user can start editing.
  el.classList.add("is-editable");
  el.addEventListener("pointerdown", onPointerDown);
  select(el);
  enterEditing(el);
}

function autoTagPlainText() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const tags = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
    "a", "button", "span", "label",
  ];
  const skipInside =
    "[data-no-edit], .mural-edit-toolbar, .mural-edit-panel, .mural-mini-panel, " +
    ".text-edit-toolbar, .image-edit-toolbar, .edit-nav, .murals-canvas, .mural-tile";
  const seen = new Map<string, number>();

  for (const el of Array.from(document.querySelectorAll<HTMLElement>(tags.join(",")))) {
    if (el.hasAttribute("data-editable-text")) continue;
    if (el.closest(skipInside)) continue;

    const text = (el.textContent || "").trim();
    if (!text) continue;

    if (el.tagName === "SPAN" || el.tagName === "LABEL") {
      if (el.querySelector("[data-editable-text]")) continue;
      const ancestor = el.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, a, button");
      if (ancestor && !ancestor.closest(skipInside)) {
        const ancestorOnlyText = ancestor.querySelectorAll(tags.join(",")).length <= 1;
        if (ancestorOnlyText) continue;
      }
    }

    const parent = el.parentElement;
    let nth = 1;
    if (parent) {
      const sameKindSiblings = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName
      );
      nth = sameKindSiblings.indexOf(el) + 1;
    }
    const base = `auto:${path}:${el.tagName.toLowerCase()}:${nth}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const id = count > 1 ? `${base}#${count}` : base;
    el.setAttribute("data-editable-text", id);
  }
}

function applyAllOverrides() {
  for (const el of getEditableEls()) applyOverride(el);
}

/**
 * Typography + content overrides fall back from the current variant to
 * `@desktop` to legacy non-variant, so visitors see *something* even when
 * only one variant has been edited.
 */
function rowFallback(baseId: string): SiteText | undefined {
  const effective = effectiveVariantId(baseId);
  return (
    textCache.get(effective) ||
    textCache.get(`${baseId}@desktop`) ||
    textCache.get(baseId)
  );
}

/**
 * Positional + size overrides come ONLY from the exact variant — desktop
 * positions must not leak onto a mobile layout (and vice versa), because
 * the natural responsive layout is already different per viewport.
 */
function rowExact(baseId: string): SiteText | undefined {
  return textCache.get(effectiveVariantId(baseId));
}

function applyOverride(el: HTMLElement) {
  const id = el.dataset.editableText!;
  const typo = rowFallback(id);
  const pos = rowExact(id);

  if (!typo && !pos) {
    el.style.transform = "";
    return;
  }
  if (typo) {
    if (typo.value !== null && typo.value !== undefined) el.textContent = typo.value;
    el.style.fontFamily      = typo.font_family     || "";
    el.style.fontWeight      = typo.font_weight     || "";
    el.style.fontStyle       = typo.font_style      || "";
    el.style.color           = typo.color           || "";
    el.style.letterSpacing   = typo.letter_spacing  || "";
    el.style.lineHeight      = typo.line_height     || "";
    el.style.textAlign       = typo.text_align      || "";
  }
  // font_size is positional-ish (affects layout) AND it's also what corner-drag
  // edits. So it comes from the exact variant only — desktop's 3rem won't
  // explode a mobile layout it wasn't tuned for.
  el.style.fontSize = pos?.font_size || "";

  const tx  = pos?.offset_x || "0px";
  const ty  = pos?.offset_y || "0px";
  const rot = pos?.rotation || 0;
  // For free-floating "custom" boxes the saved offset describes where
  // the CENTRE of the box should sit, so the box can grow both ways as
  // the user types. -50%, -50% pulls the box back by half its own
  // size before the user's offset is applied.
  const centerAnchor = el.classList.contains("custom-text-box");
  const baseTransform = centerAnchor ? "translate(-50%, -50%) " : "";
  if (centerAnchor || tx !== "0px" || ty !== "0px" || rot !== 0) {
    el.style.transform = `${baseTransform}translate(${tx}, ${ty}) rotate(${rot}deg)`;
    el.style.transformOrigin = "center center";
  } else {
    el.style.transform = "";
  }
}

function preloadFontsInUse() {
  const families = new Set<string>();
  for (const row of textCache.values()) {
    if (row.font_family) {
      const fam = row.font_family.replace(/^"|"$/g, "").split(",")[0].trim();
      if (fam) families.add(fam);
    }
  }
  if (families.size === 0) return;
  const id = "site-text-google-fonts";
  let link = document.getElementById(id) as HTMLLinkElement | null;
  const href =
    "https://fonts.googleapis.com/css2?" +
    Array.from(families).map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@300;400;500;600;700`).join("&") +
    "&display=swap";
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = href;
}

/* ===================== Edit interactions ===================== */

function patchInternalLinks() {
  const apply = () => {
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const raw = a.getAttribute("href") || "";
      if (!raw.startsWith("/") || raw.startsWith("//")) continue;
      try {
        const u = new URL(raw, location.origin);
        if (u.origin !== location.origin) continue;
        if (!u.searchParams.has("edit")) u.searchParams.set("edit", "1");
        a.setAttribute("href", u.pathname + (u.search || "") + (u.hash || ""));
      } catch {}
    }
  };
  apply();
  const obs = new MutationObserver(() => apply());
  obs.observe(document.body, { subtree: true, childList: true });
}

function bindEditClicks() {
  for (const el of getEditableEls()) {
    el.classList.add("is-editable");
    if (el.tagName === "A" || el.tagName === "BUTTON") {
      el.classList.add("is-interactive-edit");
      // Swallow plain clicks so links/buttons never navigate accidentally in edit mode.
      el.addEventListener("click", (e) => {
        if (editingEl === el) return;
        e.preventDefault();
        e.stopPropagation();
      });
    }
    el.addEventListener("pointerdown", onPointerDown);
  }
}

function onPointerDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  const target = e.target as HTMLElement;

  // Defer interaction inside handles or the toolbar.
  if (target.closest(".te-handle, .text-edit-toolbar")) return;

  // Active text edit on this element → let the caret + selection behave normally.
  if (editingEl === el) return;

  e.preventDefault();
  e.stopPropagation();

  // Drag only works on an already-selected element. A first touch on an
  // unselected box just SELECTS it on release — no accidental movement.
  // Touching a selected box again either enters text editing (tap) or
  // moves it (drag). This matches the "click to enter edit mode, THEN
  // operate" mental model the user asked for.
  const wasSelected = selectedEl === el;

  const startX = e.clientX;
  const startY = e.clientY;
  const initial = rowExact(el.dataset.editableText!) || ({} as SiteText);
  const x0 = parsePx(initial.offset_x);
  const y0 = parsePx(initial.offset_y);
  let moved = false;

  try { el.setPointerCapture(e.pointerId); } catch {}

  const move = (ev: PointerEvent) => {
    if (!wasSelected) return; // unselected boxes never drag
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 5) {
      moved = true;
      if (editingEl && editingEl !== el) void exitEditing();
      el.classList.add("is-alt-dragging");
      startAlignGuides(el);
    }
    if (moved) {
      let useDx = dx;
      let useDy = dy;
      // Save as vw so a position dragged on one phone width stays at
      // the same RELATIVE place on every other phone width.
      patchVariantRow(el, {
        offset_x: pxToVw(x0 + useDx),
        offset_y: pxToVw(y0 + useDy),
      });
      applyOverride(el);
      // Keep the box inside the visible viewport — push back in if any
      // edge would have slipped past, with a generous margin so a 366px
      // editor viewport doesn't leave the element flush against the
      // edge of a 360px-wide real phone. Prevents both "dragged
      // off-screen" and "barely-overflowed-on-live" scenarios.
      const r = el.getBoundingClientRect();
      const margin = 16;
      let adjX = 0, adjY = 0;
      if (r.left < margin)                       adjX = margin - r.left;
      else if (r.right > window.innerWidth - margin)  adjX = window.innerWidth - margin - r.right;
      if (r.top < margin)                        adjY = margin - r.top;
      else if (r.bottom > window.innerHeight - margin) adjY = window.innerHeight - margin - r.bottom;
      if (adjX !== 0 || adjY !== 0) {
        useDx += adjX; useDy += adjY;
        patchVariantRow(el, {
          offset_x: pxToVw(x0 + useDx),
          offset_y: pxToVw(y0 + useDy),
        });
        applyOverride(el);
      }
      // Snap to nearby alignments + show guide lines
      const snap = computeAlignSnap(el.getBoundingClientRect());
      if (snap.dx !== 0 || snap.dy !== 0) {
        patchVariantRow(el, {
          offset_x: pxToVw(x0 + useDx + snap.dx),
          offset_y: pxToVw(y0 + useDy + snap.dy),
        });
        applyOverride(el);
      }
      positionToolbar(el);
    }
  };

  const up = async () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.classList.remove("is-alt-dragging");
    endAlignGuides();

    if (moved) {
      const blockClick = (ev: MouseEvent) => {
        ev.stopPropagation(); ev.preventDefault();
        el.removeEventListener("click", blockClick, true);
      };
      el.addEventListener("click", blockClick, { capture: true });
      setTimeout(() => el.removeEventListener("click", blockClick, true), 80);
      const variantId = effectiveVariantId(el.dataset.editableText!);
      const row = textCache.get(variantId);
      if (row) await upsertSiteText(row);
      return;
    }

    // Tap (no drag occurred). Tap on unselected = select. Tap on selected = edit.
    if (!wasSelected) {
      if (editingEl) await exitEditing();
      select(el);
    } else {
      enterEditing(el);
    }
  };

  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function select(el: HTMLElement) {
  if (selectedEl && selectedEl !== el) unselect();
  selectedEl = el;
  el.classList.add("is-selected");
  attachHandles(el);
  renderToolbar(el);
  positionToolbar(el);
}

function unselect() {
  if (!selectedEl) return;
  // Exit editing first if active
  if (editingEl === selectedEl) {
    selectedEl.removeAttribute("contenteditable");
    selectedEl.classList.remove("is-editing");
    editingEl = null;
  }
  selectedEl.classList.remove("is-selected");
  selectedEl.querySelectorAll(".te-handle").forEach((h) => h.remove());
  if (selectedEl.dataset.tePosOrig === "static") {
    selectedEl.style.position = "";
    delete selectedEl.dataset.tePosOrig;
  }
  if (toolbar) {
    toolbar.style.display = "none";
    // Restore the dock's empty state when we leave docked mode.
    if (toolbar.classList.contains("is-docked")) {
      try { toolbar.parentElement?.classList.remove("is-active"); } catch {}
    }
  }
  selectedEl = null;
}

function enterEditing(el: HTMLElement) {
  if (editingEl === el) return;
  if (selectedEl !== el) select(el);
  editingEl = el;
  el.classList.add("is-editing");
  el.setAttribute("contenteditable", "plaintext-only");
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
  el.addEventListener("blur", onEditingBlur as any, { once: true });
}

async function exitEditing() {
  if (!editingEl) return;
  const el = editingEl;
  el.removeAttribute("contenteditable");
  el.classList.remove("is-editing");
  editingEl = null;
  await persist(el);
}

async function onEditingBlur(e: FocusEvent) {
  const el = e.target as HTMLElement;
  setTimeout(async () => {
    if (
      document.activeElement &&
      (document.activeElement === toolbar || toolbar?.contains(document.activeElement))
    ) {
      // Focus moved into the toolbar — save text but keep editing alive.
      await persist(el);
      if (editingEl === el) el.addEventListener("blur", onEditingBlur as any, { once: true });
      return;
    }
    await persist(el);
    if (editingEl === el) {
      el.removeAttribute("contenteditable");
      el.classList.remove("is-editing");
      editingEl = null;
    }
    // Stay in selected state — the body click handler will deselect when
    // the user actually clicks outside.
  }, 0);
}

function attachHandles(el: HTMLElement) {
  el.querySelectorAll(".te-handle").forEach((h) => h.remove());

  // Need positioning context for absolute handles
  const computed = getComputedStyle(el);
  if (computed.position === "static") {
    el.dataset.tePosOrig = "static";
    el.style.position = "relative";
  }

  const corners: Array<["nw" | "ne" | "se" | "sw", string]> = [
    ["nw", "left:-8px;top:-8px;cursor:nwse-resize"],
    ["ne", "right:-8px;top:-8px;cursor:nesw-resize"],
    ["se", "right:-8px;bottom:-8px;cursor:nwse-resize"],
    ["sw", "left:-8px;bottom:-8px;cursor:nesw-resize"],
  ];
  for (const [dir, style] of corners) {
    const h = document.createElement("div");
    h.className = `te-handle te-handle--${dir}`;
    h.setAttribute("style", style);
    h.dataset.noEdit = "";
    el.appendChild(h);
    bindResize(h, el, dir);
  }
}

function bindResize(handle: HTMLElement, el: HTMLElement, dir: "nw" | "ne" | "se" | "sw") {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (editingEl === el) void exitEditing();

    const startX = e.clientX;
    const startY = e.clientY;
    const r = el.getBoundingClientRect();
    const startW = Math.max(20, r.width);
    const computed = getComputedStyle(el);
    const startSizePx = parseFloat(computed.fontSize) || 16;
    const dirSignX = (dir === "ne" || dir === "se") ? 1 : -1;
    const dirSignY = (dir === "sw" || dir === "se") ? 1 : -1;

    // Freeze the box's position so resizing this single element doesn't
    // push siblings around. The trick: clone the element into a
    // visibility:hidden placeholder, drop it where the original was,
    // then re-anchor the original via position: absolute. The
    // placeholder keeps the original's space in normal flow — so
    // siblings stay put — while the floating original is free to grow
    // / shrink with the user's drag.
    const display = getComputedStyle(el).display;
    const placeholder = document.createElement(el.tagName.toLowerCase());
    placeholder.dataset.resizePlaceholder = "";
    placeholder.style.display = display === "inline" ? "inline-block" : display;
    placeholder.style.width = `${r.width}px`;
    placeholder.style.height = `${r.height}px`;
    placeholder.style.visibility = "hidden";
    placeholder.style.margin = getComputedStyle(el).margin;
    el.parentNode?.insertBefore(placeholder, el);
    const frozen = {
      position: el.style.position,
      left: el.style.left,
      top: el.style.top,
      width: el.style.width,
      margin: el.style.margin,
    };
    el.style.position = "absolute";
    el.style.left = `${r.left + window.scrollX}px`;
    el.style.top = `${r.top + window.scrollY}px`;
    el.style.width = `${r.width}px`;
    el.style.margin = "0";

    try { handle.setPointerCapture(e.pointerId); } catch {}

    const variantId = effectiveVariantId(el.dataset.editableText!);

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * dirSignX;
      const dy = (ev.clientY - startY) * dirSignY;
      // Average of horizontal + vertical drag towards the corner. Smooth and
      // works the same regardless of which corner you grab.
      const delta = (dx + dy) / 2;
      const ratio = (startW + delta) / startW;
      const newSize = Math.max(8, Math.round(startSizePx * ratio * 10) / 10);
      patchVariantRow(el, { font_size: `${newSize}px` });
      // applyOverride sets fontSize on the element; the absolute-positioned
      // box keeps siblings stationary while font reflows inside this box.
      applyOverride(el);
      positionToolbar(el);
      const sizeOut = toolbar?.querySelector<HTMLInputElement>(".te-size-value");
      if (sizeOut) sizeOut.value = String(Math.round(newSize));
    };

    const up = async () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      // Restore inline styles + remove the placeholder so the element
      // re-joins the document flow with its new font-size; the parent
      // reflows naturally now that the user's done.
      el.style.position = frozen.position;
      el.style.left = frozen.left;
      el.style.top = frozen.top;
      el.style.width = frozen.width;
      el.style.margin = frozen.margin;
      placeholder.remove();
      applyOverride(el);
      const row = textCache.get(variantId);
      if (row) await upsertSiteText(row);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

/**
 * Convert a stored offset (e.g. "12px", "3.5vw", "10%") into pixels at
 * the current viewport width. Allows old px-stored data to keep
 * working while new edits save as vw so positions stay proportional
 * across device widths.
 */
function offsetToPx(v: string | null | undefined): number {
  if (!v) return 0;
  const m = String(v).match(/(-?[\d.]+)\s*(vw|px|em|rem|%)?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] || "px";
  if (unit === "px") return n;
  if (unit === "vw" || unit === "%") return (n / 100) * window.innerWidth;
  if (unit === "rem" || unit === "em") return n * 16;
  return n;
}

/** Express a pixel offset as a viewport-width percentage. Saving in vw
 *  makes the stored position scale to any phone size automatically. */
function pxToVw(px: number): string {
  if (!window.innerWidth) return `${px}px`;
  return `${((px / window.innerWidth) * 100).toFixed(2)}vw`;
}

/** Back-compat shim — call sites that historically used parsePx still work. */
function parsePx(v: string | null | undefined): number {
  return offsetToPx(v);
}

async function persist(el: HTMLElement) {
  const baseId = el.dataset.editableText!;
  const variantId = effectiveVariantId(baseId);
  const existing = textCache.get(variantId) || rowFallback(baseId) || ({ id: variantId } as SiteText);
  const row: Partial<SiteText> & { id: string } = {
    ...existing,
    id: variantId,
    value: el.textContent || "",
  };
  await upsertSiteText(row);
  textCache.set(variantId, row as SiteText);
}

function patchVariantRow(el: HTMLElement, patch: Partial<SiteText>): SiteText {
  const baseId = el.dataset.editableText!;
  const variantId = effectiveVariantId(baseId);
  const current = textCache.get(variantId) || rowExact(baseId) || rowFallback(baseId) || ({ id: variantId } as SiteText);
  const next = { ...current, id: variantId, ...patch } as SiteText;
  textCache.set(variantId, next);
  return next;
}

/* ===================== Floating toolbar ===================== */

/**
 * If we're inside a same-origin iframe whose parent has reserved a
 * "[data-toolbar-dock]" container (the /edit/mobile/ shell does), we
 * mount the toolbar OUT THERE — beside the phone preview, not on top
 * of it. Cleaner for the eye, never blocks the page being edited, and
 * survives zooming the editor without going off-screen.
 */
function getDockedHost(): { doc: Document; container: HTMLElement } | null {
  try {
    if (window.parent === window) return null;
    const pdoc = window.parent.document;
    const dock = pdoc.querySelector<HTMLElement>("[data-toolbar-dock]");
    if (!dock) return null;
    return { doc: pdoc, container: dock };
  } catch {
    return null;
  }
}

function mountToolbar() {
  const docked = getDockedHost();
  if (docked) {
    injectStyles(docked.doc);
    toolbar = docked.doc.createElement("div");
    toolbar.className = "text-edit-toolbar is-docked";
    toolbar.dataset.noEdit = "";
    toolbar.style.display = "none";
    docked.container.appendChild(toolbar);
    // Clean up if the iframe navigates away.
    window.addEventListener("pagehide", () => {
      try { toolbar?.remove(); } catch {}
    });
  } else {
    toolbar = document.createElement("div");
    toolbar.className = "text-edit-toolbar";
    toolbar.dataset.noEdit = "";
    toolbar.style.display = "none";
    document.body.appendChild(toolbar);
  }
}

function positionToolbar(el: HTMLElement) {
  if (!toolbar) return;
  toolbar.style.display = "flex";
  // Docked toolbars live in the parent shell — CSS handles positioning;
  // we just mark the dock as active so the empty-state hides.
  if (toolbar.classList.contains("is-docked")) {
    toolbar.style.position = "";
    toolbar.style.left = toolbar.style.right = toolbar.style.top = toolbar.style.bottom = "";
    try {
      const dock = toolbar.parentElement;
      if (dock) dock.classList.add("is-active");
    } catch {}
    return;
  }
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
    toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 560, r.left))}px`;
    toolbar.style.top = `${Math.max(8, r.top - 56)}px`;
    toolbar.style.right = "auto";
    toolbar.style.bottom = "auto";
    toolbar.classList.remove("is-mobile");
  }
}

/**
 * The font-size shown in the toolbar is always the live computed value —
 * i.e. what the user actually sees on screen. Saved overrides could be
 * stale or contain values the browser ignored (e.g. a bare "30" with no
 * unit), so trusting them would lie about the current state. Stepper +/-
 * and corner-drag both add to this baseline and save the result back.
 */
function readFontSizePx(el: HTMLElement, _baseId: string): number {
  return parseFloat(getComputedStyle(el).fontSize) || 16;
}

function renderToolbar(el: HTMLElement) {
  if (!toolbar) return;
  const baseId = el.dataset.editableText!;
  const typo = rowFallback(baseId) || ({ id: baseId } as SiteText);
  const pos = rowExact(baseId) || ({ id: effectiveVariantId(baseId) } as SiteText);
  const variant = currentVariant();
  const isLink = el.tagName === "A";
  const isInteractive = isLink || el.tagName === "BUTTON";
  const currentFontPx = Math.round(readFontSizePx(el, baseId));

  toolbar.innerHTML = `
    <span class="te-variant" title="editing variant for current screen">${variant}</span>
    <button class="te-edit-text" type="button" title="edit text (or tap the text again)">
      ✏ <span class="te-edit-text-label">edit text</span>
    </button>
    ${isLink ? `<button class="te-open-link" type="button" title="open link in new tab">↗ open link</button>` : ""}
    ${isInteractive && !isLink ? `<button class="te-open-link" type="button" title="trigger button">▶ run</button>` : ""}
    <div class="te-size-stepper" title="font size — type a number or use the arrows">
      <button class="te-size-minus" type="button">−</button>
      <input class="te-size-value" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" value="${currentFontPx}" maxlength="5" />
      <span class="te-size-unit">px</span>
      <button class="te-size-plus" type="button">+</button>
    </div>
    <select class="te-font" title="font family">
      <option value="">— inherit —</option>
      ${FONT_CATALOGUE.map(
        (f) =>
          `<option value="${escAttr(f.stack)}" data-family="${escAttr(f.family)}" ${
            typo.font_family === f.stack ? "selected" : ""
          } style="font-family:${escAttr(f.stack)}">${f.label}</option>`
      ).join("")}
    </select>
    <select class="te-weight" title="font weight">
      ${["", "300", "400", "500", "600", "700"]
        .map((w) => `<option value="${w}" ${typo.font_weight === w ? "selected" : ""}>${w || "weight"}</option>`)
        .join("")}
    </select>
    <button class="te-bold ${(typo.font_weight === "700" || typo.font_weight === "600") ? "is-on" : ""}" type="button" title="bold">B</button>
    <button class="te-italic ${typo.font_style === "italic" ? "is-on" : ""}" type="button" title="italic">I</button>
    <input class="te-color" type="color" title="colour" value="${typo.color || rgbToHex(getComputedStyle(el).color) || "#ffffff"}" />
    <label class="te-rotation" title="rotation (deg)">
      <span>rot</span>
      <input type="range" min="-180" max="180" step="1" value="${pos.rotation || 0}" data-field="rotation" />
      <output>${Math.round(pos.rotation || 0)}°</output>
    </label>
    <button class="te-reset" type="button" title="reset to defaults">⟲</button>
    <button class="te-delete" type="button" title="delete this text box">🗑</button>
  `;

  const fontSel = toolbar.querySelector<HTMLSelectElement>(".te-font")!;
  const weightSel = toolbar.querySelector<HTMLSelectElement>(".te-weight")!;
  const boldBtn = toolbar.querySelector<HTMLButtonElement>(".te-bold")!;
  const italicBtn = toolbar.querySelector<HTMLButtonElement>(".te-italic")!;
  const colorIn = toolbar.querySelector<HTMLInputElement>(".te-color")!;
  const resetBtn = toolbar.querySelector<HTMLButtonElement>(".te-reset")!;
  const editTextBtn = toolbar.querySelector<HTMLButtonElement>(".te-edit-text")!;
  const sizeMinus = toolbar.querySelector<HTMLButtonElement>(".te-size-minus")!;
  const sizePlus = toolbar.querySelector<HTMLButtonElement>(".te-size-plus")!;
  const sizeValue = toolbar.querySelector<HTMLInputElement>(".te-size-value")!;

  const variantId = effectiveVariantId(baseId);

  // Typo fields write to the variant row (so a single change creates the row)
  const updateTypo = async (field: keyof SiteText, value: any) => {
    const next = patchVariantRow(el, { [field]: value } as Partial<SiteText>);
    applyOverride(el);
    if (field === "font_family" && value) preloadFontsInUse();
    await upsertSiteText(next);
  };
  const updatePos = async (field: keyof SiteText, value: any) => {
    const next = patchVariantRow(el, { [field]: value } as Partial<SiteText>);
    applyOverride(el);
    await upsertSiteText(next);
  };

  fontSel.addEventListener("change", () => updateTypo("font_family", fontSel.value || null));
  weightSel.addEventListener("change", () => updateTypo("font_weight", weightSel.value || null));
  boldBtn.addEventListener("click", () => {
    const isOn = boldBtn.classList.toggle("is-on");
    updateTypo("font_weight", isOn ? "700" : null);
    // Sync the weight dropdown so it reflects the change
    const sel = toolbar?.querySelector<HTMLSelectElement>(".te-weight");
    if (sel) sel.value = isOn ? "700" : "";
  });
  italicBtn.addEventListener("click", () => {
    const isOn = italicBtn.classList.toggle("is-on");
    updateTypo("font_style", isOn ? "italic" : null);
  });
  colorIn.addEventListener("change", () => updateTypo("color", colorIn.value));

  editTextBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    enterEditing(el);
  });

  const openLinkBtn = toolbar.querySelector<HTMLButtonElement>(".te-open-link");
  if (openLinkBtn && isLink) {
    openLinkBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const href = (el as HTMLAnchorElement).getAttribute("href") || "";
      if (href) {
        // Same tab is what visitors get — keep edit session via ?edit=1 patch
        window.location.href = href;
      }
    });
  } else if (openLinkBtn) {
    // Plain button: simulate a real click via a temporary native click without
    // our intercepting handlers in the way.
    openLinkBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      (el as HTMLButtonElement).form?.requestSubmit?.();
    });
  }

  const applySize = async (nextPx: number) => {
    const clamped = Math.max(8, Math.round(nextPx * 10) / 10);
    patchVariantRow(el, { font_size: `${clamped}px` });
    applyOverride(el);
    sizeValue.value = String(Math.round(clamped));
    const row = textCache.get(variantId);
    if (row) await upsertSiteText(row);
  };
  const applySizeStep = (deltaPx: number) =>
    applySize(readFontSizePx(el, baseId) + deltaPx);

  sizeMinus.addEventListener("click", () => applySizeStep(-1));
  sizePlus.addEventListener("click", () => applySizeStep(+1));
  attachRepeatPress(sizeMinus, () => applySizeStep(-2));
  attachRepeatPress(sizePlus, () => applySizeStep(+2));

  // Typing in the size field: live preview while typing, persist on
  // Enter / blur. Esc cancels and restores the previous value.
  const commitTypedSize = () => {
    const n = parseFloat(sizeValue.value);
    if (Number.isFinite(n) && n > 0) applySize(n);
    else sizeValue.value = String(Math.round(readFontSizePx(el, baseId)));
  };
  sizeValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitTypedSize(); sizeValue.blur(); }
    else if (e.key === "Escape") { sizeValue.value = String(Math.round(readFontSizePx(el, baseId))); sizeValue.blur(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); applySizeStep(+1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); applySizeStep(-1); }
  });
  sizeValue.addEventListener("blur", commitTypedSize);
  // Prevent typing in the size box from triggering the document-level
  // deselect handler (it filters on toolbar already, but pointerdown
  // inside the input shouldn't get stopPropagation messed up).
  sizeValue.addEventListener("pointerdown", (e) => e.stopPropagation());

  // Rotation slider
  const rotIn = toolbar.querySelector<HTMLInputElement>('[data-field="rotation"]');
  if (rotIn) {
    const rotOut = rotIn.parentElement?.querySelector("output");
    rotIn.addEventListener("input", () => {
      const v = parseFloat(rotIn.value);
      patchVariantRow(el, { rotation: v });
      applyOverride(el);
      if (rotOut) rotOut.textContent = `${Math.round(v)}°`;
    });
    rotIn.addEventListener("change", async () => {
      const row = textCache.get(variantId);
      if (row) await upsertSiteText(row);
    });
  }

  resetBtn.addEventListener("click", async () => {
    const blank: SiteText = {
      id: variantId, value: null, font_family: null, font_size: null, font_weight: null,
      font_style: null, color: null, letter_spacing: null, line_height: null, text_align: null,
      offset_x: null, offset_y: null, rotation: 0,
    };
    textCache.set(variantId, blank);
    applyOverride(el);
    await upsertSiteText(blank);
    renderToolbar(el);
  });

  const deleteBtn = toolbar.querySelector<HTMLButtonElement>(".te-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      const isCustom = baseId.startsWith("custom:");
      const what = isCustom
        ? "Delete this text box completely?"
        : "Remove this text element from the page?\n(The original element is part of the page template, so this will only blank its content.)";
      if (!confirm(what)) return;
      // Delete every variant row for this baseId, plus the legacy non-variant row.
      const idsToDrop = [`${baseId}@mobile`, `${baseId}@desktop`, baseId];
      for (const id of idsToDrop) await deleteSiteText(id);
      if (isCustom) {
        // Custom-floating box: also remove from DOM.
        el.remove();
      } else {
        // Template element: blank the content so the page still renders.
        el.textContent = "";
        el.style.cssText = "";
      }
      if (toolbar) toolbar.style.display = "none";
      selectedEl = null;
      editingEl = null;
    });
  }
}

/** Hold the button to repeat the action. Released = stop. */
function attachRepeatPress(btn: HTMLButtonElement, repeatFn: () => void) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let start: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (start) { clearTimeout(start); start = null; }
  };
  btn.addEventListener("pointerdown", () => {
    stop();
    start = setTimeout(() => {
      timer = setInterval(repeatFn, 80);
    }, 350);
  });
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
}

/** Escape a string for safe interpolation into an HTML attribute. The font
 * stacks in FONT_CATALOGUE contain literal `"` characters that would
 * otherwise truncate the attribute and silently empty the option value. */
function escAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function rgbToHex(rgb: string): string | null {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return null;
  return (
    "#" +
    [m[1], m[2], m[3]]
      .map((v) => Number(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

/* ===================== Styles ===================== */
function injectStyles(targetDoc: Document = document) {
  if (targetDoc.getElementById("text-edit-styles")) return;
  const s = targetDoc.createElement("style");
  s.id = "text-edit-styles";
  s.textContent = `
    /* Toolbar mounted into the parent shell's dock: vertical panel
       layout, sits to the right of the phone preview. */
    .text-edit-toolbar.is-docked {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      background: linear-gradient(180deg, rgba(22, 22, 22, 0.95), rgba(16, 16, 16, 0.95));
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 16px;
      font-family: "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      color: #fff;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      overflow: visible;
      max-width: none;
    }
    .text-edit-toolbar.is-docked .te-variant { align-self: flex-start; }
    .text-edit-toolbar.is-docked select,
    .text-edit-toolbar.is-docked input[type="text"] { width: 100%; }
    .text-edit-toolbar.is-docked .te-size-stepper { align-self: stretch; }
    .text-edit-toolbar.is-docked .te-size-stepper button {
      width: 36px; height: 36px; font-size: 18px;
    }
    .text-edit-toolbar.is-docked .te-size-value {
      flex: 1; min-width: 0; width: auto; font-size: 16px;
    }
    .text-edit-toolbar.is-docked .te-rotation { display: flex; align-items: center; gap: 8px; }
    .text-edit-toolbar.is-docked .te-rotation input[type="range"] { flex: 1; }
    .text-edit-toolbar.is-docked .te-edit-text,
    .text-edit-toolbar.is-docked .te-open-link {
      width: 100%; justify-content: center; padding: 10px;
    }
    .text-edit-toolbar.is-docked .te-italic,
    .text-edit-toolbar.is-docked .te-bold,
    .text-edit-toolbar.is-docked .te-reset { padding: 8px 12px; }

    /* Editable elements in edit mode. touch-action: none so a finger drag
       never gets stolen by the browser as a scroll. */
    /* Render line breaks the user types as actual line breaks (the
       white-space pre-line value preserves linebreaks while still
       collapsing other whitespace). */
    [data-editable-text] { white-space: pre-line; }

    /* Free-floating text boxes added with the editor's "+ text" button.
       Transparent by default so the type sits directly on the page —
       the user can change colour/font through the toolbar.
       The saved offset positions the box's CENTRE, not its top-left,
       so the box grows symmetrically as the user types — extending
       both left and right until it hits the viewport edges, at which
       point it wraps to a new line. Page never widens. */
    .custom-text-box {
      position: absolute;
      top: 0;
      left: 0;
      padding: 2px 6px;
      background: transparent;
      color: inherit;
      font-family: inherit;
      font-size: 1.2rem;
      line-height: 1.3;
      max-width: 92vw;
      text-align: center;
      word-wrap: break-word;
      overflow-wrap: break-word;
      transform-origin: center center;
      z-index: 20;
    }

    /* Floating "+ text" button — bottom-right of the editor viewport. */
    .te-add-fab {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 1200;
      background: linear-gradient(135deg, #4cc2ff, #2196ee);
      color: #001020;
      border: 0;
      border-radius: 22px;
      padding: 10px 18px;
      font-family: "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.02em;
      cursor: pointer;
      box-shadow: 0 12px 28px rgba(33, 150, 238, 0.45);
      transition: filter 120ms ease, transform 120ms ease;
    }
    .te-add-fab:hover { filter: brightness(1.07); transform: translateY(-1px); }
    .te-add-fab:active { transform: translateY(0); }
    body.is-text-edit [data-editable-text].is-editable {
      cursor: pointer;
      transition: outline 120ms ease;
      touch-action: none;
    }
    body.is-text-edit [data-editable-text].is-editable:hover {
      outline: 1px dashed rgba(76, 194, 255, 0.55);
      outline-offset: 0;
    }
    body.is-text-edit [data-editable-text].is-interactive-edit:hover {
      outline-color: rgba(120, 220, 120, 0.65);
    }
    /* No "position: relative" override here — it would clobber elements
       whose actual CSS chose "absolute"/"fixed" (e.g. the UPLOAD button),
       moving them back into the document flow. Handles still get a
       positioned ancestor: attachHandles() promotes static → relative
       only for the currently selected element, and restores it on unselect. */
    body.is-text-edit [data-editable-text].is-selected {
      outline: 2px solid #4cc2ff;
      outline-offset: 0;
    }
    body.is-text-edit [data-editable-text].is-editing {
      cursor: text;
      outline: 2px solid #ffcc00;
      outline-offset: 0;
      touch-action: auto;
    }
    body.is-text-edit [data-editable-text].is-alt-dragging {
      outline: 2px dashed #ffcc00;
      cursor: move;
    }

    /* Corner resize handles (mirror of image editor) */
    .te-handle {
      position: absolute;
      width: 16px; height: 16px;
      background: #fff; border: 2px solid #4cc2ff;
      box-sizing: border-box;
      z-index: 50;
      border-radius: 3px;
      touch-action: none;
    }
    @media (hover: hover) {
      .te-handle { width: 12px; height: 12px; }
    }

    .text-edit-toolbar {
      gap: 10px;
      align-items: center;
      background: linear-gradient(180deg, rgba(22, 22, 26, 0.96), rgba(14, 14, 18, 0.96));
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      padding: 8px 12px;
      font-family: "Inter", "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      color: #e8ebf0;
      z-index: 1100;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
      max-width: 100vw;
      /* No overflow clipping: native <select> popups need to be free to
         render outside the toolbar's bounds. With overflow-x: auto on
         the floating bar, dropdown items got clipped and clicks ended
         up landing on the underlying control beside them. */
      overflow: visible;
      flex-wrap: nowrap;
    }
    .text-edit-toolbar .te-variant {
      background: linear-gradient(135deg, #4cc2ff, #6e8bff);
      color: #001020;
      padding: 4px 9px; border-radius: 5px;
      font-weight: 800; text-transform: uppercase;
      font-size: 10px; letter-spacing: 0.05em;
    }
    .text-edit-toolbar .te-edit-text {
      background: linear-gradient(135deg, #ffcc00, #ffae00);
      color: #1a1200; border: 0; border-radius: 7px;
      padding: 7px 12px; cursor: pointer; font: inherit; font-weight: 700;
      white-space: nowrap;
      transition: filter 120ms ease;
    }
    .text-edit-toolbar .te-edit-text:hover { filter: brightness(1.08); }
    .text-edit-toolbar .te-open-link {
      background: linear-gradient(135deg, #4cc2ff, #2196ee);
      color: #001020; border: 0; border-radius: 7px;
      padding: 7px 12px; cursor: pointer; font: inherit; font-weight: 700;
      white-space: nowrap;
      transition: filter 120ms ease;
    }
    .text-edit-toolbar .te-open-link:hover { filter: brightness(1.08); }
    .text-edit-toolbar .te-size-stepper {
      display: inline-flex; align-items: center; gap: 2px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 7px;
      padding: 2px;
    }
    .text-edit-toolbar .te-size-stepper button {
      background: transparent; color: #fff; border: 0;
      width: 26px; height: 26px; cursor: pointer; font: inherit;
      font-size: 16px; border-radius: 5px;
      transition: background 120ms ease;
    }
    .text-edit-toolbar .te-size-stepper button:hover { background: rgba(255, 255, 255, 0.1); }
    .text-edit-toolbar .te-size-value {
      width: 40px; text-align: center; color: #fff;
      background: transparent; border: 0; outline: 0;
      font: inherit; padding: 0;
    }
    .text-edit-toolbar .te-size-value:focus { outline: 1px solid #4cc2ff; outline-offset: 1px; border-radius: 3px; }
    .text-edit-toolbar .te-size-unit { color: rgba(255, 255, 255, 0.45); font-size: 11px; padding-right: 4px; }
    .text-edit-toolbar.is-mobile .te-size-value { width: 56px; font-size: 16px; }
    .text-edit-toolbar.is-mobile .te-size-unit { font-size: 12px; }
    .text-edit-toolbar .te-rotation {
      display: inline-flex; align-items: center; gap: 6px;
      color: rgba(255, 255, 255, 0.45);
    }
    .text-edit-toolbar .te-rotation input[type="range"] { width: 90px; }
    .text-edit-toolbar .te-rotation output { color: #fff; min-width: 34px; font-variant-numeric: tabular-nums; }
    .text-edit-toolbar select {
      background: rgba(255, 255, 255, 0.05); color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 6px 10px; border-radius: 7px; font: inherit;
      transition: border-color 120ms ease;
    }
    .text-edit-toolbar select:hover { border-color: rgba(255, 255, 255, 0.25); }
    /* Native <option> styling is brittle across browsers — explicitly
       give options a dark background and light text so they're readable
       when the dropdown opens, regardless of OS theme. */
    .text-edit-toolbar select option {
      background: #1a1a1f;
      color: #e8ebf0;
      padding: 4px 8px;
    }
    .text-edit-toolbar select option:checked,
    .text-edit-toolbar select option:hover {
      background: #2a2a32;
    }
    .text-edit-toolbar .te-font { min-width: 160px; }
    .text-edit-toolbar .te-weight { min-width: 90px; }
    .text-edit-toolbar .te-bold,
    .text-edit-toolbar .te-italic,
    .text-edit-toolbar .te-reset,
    .text-edit-toolbar .te-delete {
      background: rgba(255, 255, 255, 0.05); color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 7px; cursor: pointer; padding: 6px 11px; font: inherit;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .text-edit-toolbar .te-bold { font-weight: 800; }
    .text-edit-toolbar .te-italic { font-style: italic; }
    .text-edit-toolbar .te-reset { color: rgba(255, 255, 255, 0.6); }
    .text-edit-toolbar .te-delete {
      background: rgba(255, 90, 90, 0.12); color: #ff8080;
      border-color: rgba(255, 90, 90, 0.25);
    }
    .text-edit-toolbar .te-delete:hover {
      background: rgba(255, 90, 90, 0.22); color: #ffb0b0;
    }
    .text-edit-toolbar .te-bold:hover,
    .text-edit-toolbar .te-italic:hover,
    .text-edit-toolbar .te-reset:hover { background: rgba(255, 255, 255, 0.1); }
    .text-edit-toolbar .te-bold.is-on,
    .text-edit-toolbar .te-italic.is-on {
      background: linear-gradient(135deg, #4cc2ff, #2196ee);
      color: #001020; border-color: transparent;
    }
    .text-edit-toolbar input[type="color"] {
      background: transparent; border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 0; width: 36px; height: 30px;
      border-radius: 7px; cursor: pointer;
    }
    .text-edit-toolbar.is-mobile {
      gap: 8px;
      padding: 10px 12px env(safe-area-inset-bottom);
      border-radius: 12px 12px 0 0;
      font-size: 14px;
      border-left: 0; border-right: 0; border-bottom: 0;
    }
    .text-edit-toolbar.is-mobile select,
    .text-edit-toolbar.is-mobile button { font-size: 14px; min-height: 40px; padding: 8px 12px; }
    .text-edit-toolbar.is-mobile .te-size-stepper button { width: 36px; height: 36px; font-size: 20px; }
    .text-edit-toolbar.is-mobile .te-font { min-width: 130px; }
    .text-edit-toolbar.is-mobile .te-weight { min-width: 92px; }
  `;
  document.head.appendChild(s);
}
