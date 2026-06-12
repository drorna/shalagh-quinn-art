/**
 * Live text + font editor.
 *
 * View mode  : looks up every <EditableText> on the page in `site_text` and
 *              applies value / font_family / font_size / font_weight / etc.
 * Edit mode  : same, plus
 *              - hover ring on editable elements
 *              - click → contentEditable, blur → save
 *              - small floating toolbar above the selected element with
 *                a font picker, size, weight, italic toggle, colour
 *
 * Edit mode is unlocked by the same SHA-256 token gate used by the murals
 * board, and shares localStorage with it.
 */
import {
  fetchAllSiteText,
  upsertSiteText,
  subscribeSiteText,
  effectiveVariantId,
  currentVariant,
  type SiteText,
} from "../lib/supabase";

const EDIT_TOKEN_HASH = "1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67";
const LOCAL_STORAGE_KEY = "shalagh.murals.editToken";

// Curated Google Font list — covers the site's existing palette and a few
// hand-written options that play with shalagh's brush titles.
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
let toolbar: HTMLElement | null = null;
let textCache: Map<string, SiteText> = new Map();
let moveModeEl: HTMLElement | null = null;

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
  applyAllOverrides();
  preloadFontsInUse();

  if (editMode) {
    document.body.classList.add("is-text-edit");
    mountToolbar();
    bindEditClicks();
    patchInternalLinks();
    document.addEventListener("mousedown", (e) => {
      if (
        toolbar &&
        !(e.target as HTMLElement).closest("[data-editable-text]") &&
        !(e.target as HTMLElement).closest(".text-edit-toolbar")
      ) {
        unselect();
      }
    });
  }

  // Realtime: pick up changes from the other device
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
 * Walk the document and tag every meaningful text-bearing element so it
 * becomes editable. The id is derived from pathname + tag + nth-of-type
 * within its parent so it stays stable as long as the surrounding
 * structure doesn't change.
 *
 * Covered tags: p, h1-h6, li, blockquote, a, button, span, label.
 * For interactive ones (a, button), text-editor's click handler only
 * enters edit mode when Alt is held — a plain click still navigates /
 * fires normally, so nav arrows and "enter >" buttons keep working.
 *
 * Skipped:
 *   - elements that already carry data-editable-text
 *   - any subtree under [data-no-edit] (editor toolbars, the edit-nav,
 *     the murals canvas, tile labels)
 *   - empty elements
 *   - elements that contain other elements which would themselves get
 *     tagged (we tag the deepest text node instead, so nested wrappers
 *     don't double-bind)
 */
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

    // Must have actual text content
    const text = (el.textContent || "").trim();
    if (!text) continue;

    // For span / label, avoid double-tagging when an ancestor is also a
    // candidate. Heading > span text → tag the heading. Use the deepest
    // element that's a *direct* text container.
    if (el.tagName === "SPAN" || el.tagName === "LABEL") {
      // Skip if a tagged candidate is nested inside us
      if (el.querySelector("[data-editable-text]")) continue;
      // Skip if an ancestor in our tag set is itself a leaf text holder
      // (e.g. p > span → tag the p, skip the span)
      const ancestor = el.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, a, button");
      if (ancestor && !ancestor.closest(skipInside)) {
        const ancestorOnlyText = ancestor.querySelectorAll(tags.join(",")).length <= 1;
        if (ancestorOnlyText) continue;
      }
    }

    // Stable key: page + tag + element-local index
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

/** Pick the override for this element honouring viewport variant + fallback. */
function rowFor(baseId: string): SiteText | undefined {
  const effective = effectiveVariantId(baseId);
  return (
    textCache.get(effective) ||
    textCache.get(`${baseId}@desktop`) ||
    textCache.get(baseId) // legacy rows saved before variants
  );
}

function applyOverride(el: HTMLElement) {
  const id = el.dataset.editableText!;
  const row = rowFor(id);
  if (!row) {
    // Reset transforms we may have set previously
    el.style.transform = "";
    return;
  }
  if (row.value !== null && row.value !== undefined) el.textContent = row.value;
  el.style.fontFamily      = row.font_family     || "";
  el.style.fontSize        = row.font_size       || "";
  el.style.fontWeight      = row.font_weight     || "";
  el.style.fontStyle       = row.font_style      || "";
  el.style.color           = row.color           || "";
  el.style.letterSpacing   = row.letter_spacing  || "";
  el.style.lineHeight      = row.line_height     || "";
  el.style.textAlign       = row.text_align      || "";

  const tx = row.offset_x || "0px";
  const ty = row.offset_y || "0px";
  const rot = row.rotation || 0;
  if (tx !== "0px" || ty !== "0px" || rot !== 0) {
    el.style.transform = `translate(${tx}, ${ty}) rotate(${rot}deg)`;
    el.style.transformOrigin = "center center";
  } else {
    el.style.transform = "";
  }
}

function preloadFontsInUse() {
  // Build a Google Fonts URL with every font currently referenced by an
  // overridden element so that custom-picked fonts actually load.
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

/**
 * In edit mode, append ?edit=1 to every in-site link so navigating between
 * pages keeps the editor session alive without the user having to retype
 * the token URL. Also re-runs on history changes for client-routed pages.
 */
function patchInternalLinks() {
  const apply = () => {
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const raw = a.getAttribute("href") || "";
      // Skip external, anchors, mailto:, tel:, javascript:
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
  // Watch for late-injected links (e.g. dynamic content)
  const obs = new MutationObserver(() => apply());
  obs.observe(document.body, { subtree: true, childList: true });
}

/**
 * Per-element pending click timer. If a second click arrives within
 * DOUBLE_CLICK_MS, we treat it as a double-click and navigate / fire
 * normally. Otherwise the first click resolves into "enter edit mode".
 */
const DOUBLE_CLICK_MS = 280;
const pendingClickTimer = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** How many pixels from the element's edge count as "the frame" (drag). */
const FRAME_PX_DESKTOP = 12;
const FRAME_PX_MOBILE = 18;

function isOnFrame(el: HTMLElement, clientX: number, clientY: number): boolean {
  const r = el.getBoundingClientRect();
  const frame = window.matchMedia("(max-width: 767px)").matches ? FRAME_PX_MOBILE : FRAME_PX_DESKTOP;
  // Only count the inside band — outside the box belongs to other things
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
  return (
    clientX - r.left < frame ||
    r.right - clientX < frame ||
    clientY - r.top < frame ||
    r.bottom - clientY < frame
  );
}

function bindEditClicks() {
  for (const el of getEditableEls()) {
    el.classList.add("is-editable");
    const isInteractive = el.tagName === "A" || el.tagName === "BUTTON";
    if (isInteractive) el.classList.add("is-interactive-edit");

    el.addEventListener("pointerdown", (e) => {
      // Alt+drag, move-mode, or "frame click" (within FRAME_PX of edge) = drag.
      if (e.altKey || moveModeEl === el || isOnFrame(el, e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopPropagation();
        beginDragMove(el, e);
      }
    });

    if (isInteractive) {
      // Single click → edit (delayed), double click → navigate.
      // The delay lets a second click cancel the pending edit-select.
      el.addEventListener("click", (e) => {
        if (e.altKey) {
          // Power-user shortcut: jump straight into edit
          e.preventDefault();
          e.stopPropagation();
          select(el);
          return;
        }

        const pending = pendingClickTimer.get(el);
        if (pending) {
          // Second click within window = the user really wants to navigate.
          clearTimeout(pending);
          pendingClickTimer.delete(el);
          // Let the click bubble normally so the browser navigates.
          return;
        }

        // First click — suppress navigation, schedule edit-select.
        e.preventDefault();
        e.stopPropagation();
        const timer = setTimeout(() => {
          pendingClickTimer.delete(el);
          select(el);
        }, DOUBLE_CLICK_MS);
        pendingClickTimer.set(el, timer);
      });

      // dblclick is also dispatched by browsers — make sure it never
      // accidentally triggers a leftover edit.
      el.addEventListener("dblclick", () => {
        const pending = pendingClickTimer.get(el);
        if (pending) {
          clearTimeout(pending);
          pendingClickTimer.delete(el);
        }
      });
    } else {
      // Plain text element: single click enters edit (no nav to worry about)
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        select(el);
      });
    }
  }
}

function setMoveMode(el: HTMLElement | null) {
  if (moveModeEl && moveModeEl !== el) moveModeEl.classList.remove("is-move-mode");
  moveModeEl = el;
  if (el) el.classList.add("is-move-mode");
}

function beginDragMove(el: HTMLElement, e: PointerEvent) {
  // Cancel any active text edit first
  unselect();
  el.classList.add("is-alt-dragging");
  const startX = e.clientX;
  const startY = e.clientY;
  const initial = rowFor(el.dataset.editableText!) || ({} as SiteText);
  const x0 = parsePx(initial.offset_x);
  const y0 = parsePx(initial.offset_y);

  // Capture so we keep getting events even if the cursor leaves the element
  try { el.setPointerCapture(e.pointerId); } catch {}

  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    patchVariantRow(el, {
      offset_x: `${Math.round(x0 + dx)}px`,
      offset_y: `${Math.round(y0 + dy)}px`,
    });
    applyOverride(el);
  };
  const up = async () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.classList.remove("is-alt-dragging");
    const variantId = effectiveVariantId(el.dataset.editableText!);
    const row = textCache.get(variantId);
    if (row) await upsertSiteText(row);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function parsePx(v: string | null | undefined): number {
  if (!v) return 0;
  const m = v.match(/(-?[\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function select(el: HTMLElement) {
  if (selectedEl && selectedEl !== el) unselect();
  selectedEl = el;
  el.classList.add("is-selected");
  el.setAttribute("contenteditable", "plaintext-only");
  el.focus();
  // Place caret at end
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
  positionToolbar(el);
  renderToolbar(el);

  el.addEventListener("blur", onBlur as any, { once: true });
  el.addEventListener("input", onInput as any);
}

function unselect() {
  if (!selectedEl) return;
  selectedEl.classList.remove("is-selected");
  selectedEl.removeAttribute("contenteditable");
  selectedEl.removeEventListener("input", onInput as any);
  if (toolbar) toolbar.style.display = "none";
  selectedEl = null;
}

async function onBlur(e: FocusEvent) {
  const el = e.target as HTMLElement;
  // Defer so we can read where focus went next.
  setTimeout(async () => {
    if (
      document.activeElement &&
      (document.activeElement === toolbar || toolbar?.contains(document.activeElement))
    ) {
      // Focus moved into the toolbar (font picker, size input, colour, …).
      // Save the current text, but DON'T snatch focus back — that was the
      // bug that froze the toolbar. Re-arm blur so saving still fires when
      // the toolbar loses focus later.
      await persist(el);
      el.addEventListener("blur", onBlur as any, { once: true });
      return;
    }
    await persist(el);
    unselect();
  }, 0);
}

function onInput(e: Event) {
  const el = e.target as HTMLElement;
  // Could implement debounced auto-save mid-typing; for now we save on blur.
  void el;
}

async function persist(el: HTMLElement) {
  const baseId = el.dataset.editableText!;
  const variantId = effectiveVariantId(baseId);
  const existing = textCache.get(variantId) || rowFor(baseId) || ({ id: variantId } as SiteText);
  const row: Partial<SiteText> & { id: string } = {
    ...existing,
    id: variantId,
    value: el.textContent || "",
  };
  await upsertSiteText(row);
  textCache.set(variantId, row as SiteText);
}

/** Mutate or insert a row for the current variant of this element. */
function patchVariantRow(el: HTMLElement, patch: Partial<SiteText>): SiteText {
  const baseId = el.dataset.editableText!;
  const variantId = effectiveVariantId(baseId);
  const current = textCache.get(variantId) || rowFor(baseId) || ({ id: variantId } as SiteText);
  const next = { ...current, id: variantId, ...patch } as SiteText;
  textCache.set(variantId, next);
  return next;
}

/* ===================== Floating toolbar ===================== */

function mountToolbar() {
  toolbar = document.createElement("div");
  toolbar.className = "text-edit-toolbar";
  toolbar.dataset.noEdit = "";
  toolbar.style.display = "none";
  document.body.appendChild(toolbar);
}

function positionToolbar(el: HTMLElement) {
  if (!toolbar) return;
  toolbar.style.display = "flex";
  if (window.matchMedia("(max-width: 767px)").matches) {
    // Mobile: pin to bottom, full width, ignore element position.
    toolbar.style.position = "fixed";
    toolbar.style.left = "0";
    toolbar.style.right = "0";
    toolbar.style.bottom = "0";
    toolbar.style.top = "auto";
    toolbar.classList.add("is-mobile");
  } else {
    const r = el.getBoundingClientRect();
    toolbar.style.position = "fixed";
    toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 520, r.left))}px`;
    toolbar.style.top = `${Math.max(8, r.top - 56)}px`;
    toolbar.style.right = "auto";
    toolbar.style.bottom = "auto";
    toolbar.classList.remove("is-mobile");
  }
}

function renderToolbar(el: HTMLElement) {
  if (!toolbar) return;
  const computed = getComputedStyle(el);
  const baseId = el.dataset.editableText!;
  const row = rowFor(baseId) || ({ id: baseId } as SiteText);
  const variant = currentVariant();

  toolbar.innerHTML = `
    <span class="te-variant" title="editing variant for current screen">${variant}</span>
    <select class="te-font" title="font family">
      <option value="">— inherit —</option>
      ${FONT_CATALOGUE.map(
        (f) =>
          `<option value="${f.stack}" data-family="${f.family}" ${
            row.font_family === f.stack ? "selected" : ""
          } style="font-family:${f.stack}">${f.label}</option>`
      ).join("")}
    </select>
    <input class="te-size" type="text" placeholder="size" title="font-size (e.g. 1.4rem, 24px)" value="${row.font_size || ""}" />
    <select class="te-weight" title="font weight">
      ${["", "300", "400", "500", "600", "700"]
        .map((w) => `<option value="${w}" ${row.font_weight === w ? "selected" : ""}>${w || "inherit"}</option>`)
        .join("")}
    </select>
    <button class="te-italic ${row.font_style === "italic" ? "is-on" : ""}" type="button" title="italic">I</button>
    <input class="te-color" type="color" title="colour" value="${row.color || rgbToHex(computed.color) || "#ffffff"}" />
    <label class="te-rotation" title="rotation (deg)">
      rot
      <input type="range" min="-180" max="180" step="1" value="${row.rotation || 0}" data-field="rotation" />
      <output>${Math.round(row.rotation || 0)}°</output>
    </label>
    <button class="te-reset" type="button" title="reset to defaults">⟲</button>
  `;

  const fontSel = toolbar.querySelector<HTMLSelectElement>(".te-font")!;
  const sizeIn = toolbar.querySelector<HTMLInputElement>(".te-size")!;
  const weightSel = toolbar.querySelector<HTMLSelectElement>(".te-weight")!;
  const italicBtn = toolbar.querySelector<HTMLButtonElement>(".te-italic")!;
  const colorIn = toolbar.querySelector<HTMLInputElement>(".te-color")!;
  const resetBtn = toolbar.querySelector<HTMLButtonElement>(".te-reset")!;

  const variantId = effectiveVariantId(baseId);
  const updateStyle = async (field: keyof SiteText, value: any) => {
    const next = patchVariantRow(el, { [field]: value } as Partial<SiteText>);
    applyOverride(el);
    if (field === "font_family" && value) preloadFontsInUse();
    await upsertSiteText(next);
  };

  fontSel.addEventListener("change", () => updateStyle("font_family", fontSel.value || null));
  weightSel.addEventListener("change", () => updateStyle("font_weight", weightSel.value || null));
  italicBtn.addEventListener("click", () => {
    const isOn = italicBtn.classList.toggle("is-on");
    updateStyle("font_style", isOn ? "italic" : null);
  });

  // Live size: update visually on every keystroke; debounce the save
  let sizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  sizeIn.addEventListener("input", () => {
    patchVariantRow(el, { font_size: sizeIn.value || null });
    applyOverride(el);
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(() => {
      const row = textCache.get(variantId);
      if (row) upsertSiteText(row);
    }, 500);
  });
  colorIn.addEventListener("change", () => updateStyle("color", colorIn.value));

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
function injectStyles() {
  if (document.getElementById("text-edit-styles")) return;
  const s = document.createElement("style");
  s.id = "text-edit-styles";
  s.textContent = `
    /* Invisible padding "frame" so the edge area is clickable. Negative
       margin removes the padding from layout — visually nothing moves. */
    body.is-text-edit [data-editable-text].is-editable {
      cursor: text;
      transition: outline 120ms ease;
      padding: 6px;
      margin: -6px;
    }
    body.is-text-edit [data-editable-text].is-editable:hover {
      outline: 1px dashed rgba(76, 194, 255, 0.55);
      outline-offset: 0;
    }
    /* Interactive elements (links, buttons): green ring on hover.
       Single click → edit. Double click → navigate. Alt+click is a
       power-user shortcut straight to edit. */
    body.is-text-edit [data-editable-text].is-interactive-edit:hover {
      outline-color: rgba(120, 220, 120, 0.65);
    }
    body.is-text-edit [data-editable-text].is-interactive-edit { position: relative; }
    body.is-text-edit [data-editable-text].is-selected {
      outline: 2px solid #4cc2ff;
      outline-offset: 0;
    }
    body.is-text-edit [data-editable-text].is-alt-dragging,
    body.is-text-edit [data-editable-text].is-move-mode {
      outline: 2px dashed #ffcc00;
      outline-offset: 0;
      cursor: move;
      touch-action: none;
    }
    .text-edit-toolbar .te-variant {
      background: #4cc2ff; color: #000;
      padding: 3px 7px; border-radius: 3px;
      font-weight: bold; text-transform: uppercase;
      font-size: 10px;
    }
    .text-edit-toolbar .te-rotation {
      display: inline-flex; align-items: center; gap: 4px; color: #aaa;
    }
    .text-edit-toolbar .te-rotation input[type="range"] { width: 90px; }
    .text-edit-toolbar .te-rotation output { color: #fff; min-width: 34px; }
    .text-edit-toolbar {
      gap: 6px;
      align-items: center;
      background: #161616;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 6px 8px;
      font-family: monospace;
      font-size: 12px;
      color: #fff;
      z-index: 1100;
      box-shadow: 0 8px 24px rgba(0,0,0,0.45);
      max-width: 100vw;
      overflow-x: auto;
    }
    .text-edit-toolbar.is-mobile {
      gap: 8px;
      padding: 10px 12px env(safe-area-inset-bottom);
      border-radius: 12px 12px 0 0;
      font-size: 14px;
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      flex-wrap: nowrap;
    }
    .text-edit-toolbar.is-mobile input,
    .text-edit-toolbar.is-mobile select,
    .text-edit-toolbar.is-mobile button { font-size: 14px; padding: 8px 12px; min-height: 38px; }
    .text-edit-toolbar.is-mobile .te-font { min-width: 140px; }
    .text-edit-toolbar.is-mobile .te-size { width: 70px; }
    .text-edit-toolbar.is-mobile .te-weight { min-width: 92px; }
    .text-edit-toolbar select,
    .text-edit-toolbar input[type="text"] {
      background: #222; color: #fff; border: 1px solid #555;
      padding: 4px 6px; border-radius: 3px; font: inherit;
    }
    .text-edit-toolbar .te-font { min-width: 180px; }
    .text-edit-toolbar .te-size { width: 72px; }
    .text-edit-toolbar .te-weight { width: 84px; }
    .text-edit-toolbar .te-italic,
    .text-edit-toolbar .te-reset {
      background: #222; color: #fff; border: 1px solid #555;
      border-radius: 3px; cursor: pointer; padding: 4px 9px; font: inherit;
    }
    .text-edit-toolbar .te-italic.is-on { background: #4cc2ff; color: #000; border-color: #4cc2ff; }
    .text-edit-toolbar input[type="color"] {
      background: transparent; border: 1px solid #555; padding: 0; width: 36px; height: 28px;
      border-radius: 3px; cursor: pointer;
    }
  `;
  document.head.appendChild(s);
}
