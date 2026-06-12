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
 * Walk the document and tag every plain text element (p, h1-h6, li, blockquote)
 * with a stable auto-id so brand-new pages get editing for free. The id is
 * derived from pathname + tag + nth-of-type within its parent, so it stays
 * stable as long as the surrounding structure doesn't change.
 *
 * Elements that already have data-editable-text are left alone — explicit
 * wrappers in the source code always win.
 *
 * Skipped:
 *   - elements inside the editor toolbars (.mural-edit-toolbar, etc.)
 *   - empty elements
 *   - tile labels (they belong to the murals DB, not site_text)
 */
function autoTagPlainText() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const tags = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"];
  const skipInside = ".mural-edit-toolbar, .mural-edit-panel, .mural-mini-panel, .text-edit-toolbar, .murals-canvas, .mural-tile";
  const seen = new Map<string, number>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(tags.join(",")))) {
    if (el.hasAttribute("data-editable-text")) continue;
    if (el.closest(skipInside)) continue;
    const text = (el.textContent || "").trim();
    if (!text) continue;
    // Stable key: page + tag + element-local index
    const parent = el.parentElement;
    let nth = 1;
    if (parent) {
      const sameKindSiblings = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName
      );
      nth = sameKindSiblings.indexOf(el) + 1;
    }
    // De-duplicate: page-level counter for the (tag, nth) combo
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

function applyOverride(el: HTMLElement) {
  const id = el.dataset.editableText!;
  const row = textCache.get(id);
  if (!row) return;
  if (row.value !== null && row.value !== undefined) el.textContent = row.value;
  el.style.fontFamily      = row.font_family     || "";
  el.style.fontSize        = row.font_size       || "";
  el.style.fontWeight      = row.font_weight     || "";
  el.style.fontStyle       = row.font_style      || "";
  el.style.color           = row.color           || "";
  el.style.letterSpacing   = row.letter_spacing  || "";
  el.style.lineHeight      = row.line_height     || "";
  el.style.textAlign       = row.text_align      || "";
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

function bindEditClicks() {
  for (const el of getEditableEls()) {
    el.classList.add("is-editable");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(el);
    });
  }
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
  // Save when focus leaves both element AND toolbar
  setTimeout(async () => {
    if (
      document.activeElement &&
      (document.activeElement === toolbar || toolbar?.contains(document.activeElement))
    ) {
      // Focus went into the toolbar — re-arm
      el.addEventListener("blur", onBlur as any, { once: true });
      el.focus();
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
  const id = el.dataset.editableText!;
  const existing = textCache.get(id) || ({ id } as SiteText);
  const row: Partial<SiteText> & { id: string } = {
    ...existing,
    id,
    value: el.textContent || "",
  };
  await upsertSiteText(row);
  textCache.set(id, row as SiteText);
}

/* ===================== Floating toolbar ===================== */

function mountToolbar() {
  toolbar = document.createElement("div");
  toolbar.className = "text-edit-toolbar";
  toolbar.style.display = "none";
  document.body.appendChild(toolbar);
}

function positionToolbar(el: HTMLElement) {
  if (!toolbar) return;
  const r = el.getBoundingClientRect();
  toolbar.style.display = "flex";
  toolbar.style.position = "fixed";
  toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 460, r.left))}px`;
  toolbar.style.top = `${Math.max(8, r.top - 56)}px`;
}

function renderToolbar(el: HTMLElement) {
  if (!toolbar) return;
  const computed = getComputedStyle(el);
  const id = el.dataset.editableText!;
  const row = textCache.get(id) || ({ id } as SiteText);

  toolbar.innerHTML = `
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
    <button class="te-reset" type="button" title="reset to defaults">⟲</button>
  `;

  const fontSel = toolbar.querySelector<HTMLSelectElement>(".te-font")!;
  const sizeIn = toolbar.querySelector<HTMLInputElement>(".te-size")!;
  const weightSel = toolbar.querySelector<HTMLSelectElement>(".te-weight")!;
  const italicBtn = toolbar.querySelector<HTMLButtonElement>(".te-italic")!;
  const colorIn = toolbar.querySelector<HTMLInputElement>(".te-color")!;
  const resetBtn = toolbar.querySelector<HTMLButtonElement>(".te-reset")!;

  const updateStyle = async (field: keyof SiteText, value: string | null) => {
    const current = textCache.get(id) || ({ id } as SiteText);
    const next: SiteText = { ...current, id, [field]: value } as SiteText;
    textCache.set(id, next);
    applyOverride(el);
    if (field === "font_family" && value) preloadFontsInUse();
    await upsertSiteText({ id, [field]: value });
  };

  fontSel.addEventListener("change", () => updateStyle("font_family", fontSel.value || null));
  sizeIn.addEventListener("change", () => updateStyle("font_size", sizeIn.value || null));
  weightSel.addEventListener("change", () => updateStyle("font_weight", weightSel.value || null));
  italicBtn.addEventListener("click", () => {
    const isOn = italicBtn.classList.toggle("is-on");
    updateStyle("font_style", isOn ? "italic" : null);
  });
  colorIn.addEventListener("change", () => updateStyle("color", colorIn.value));
  resetBtn.addEventListener("click", async () => {
    const blank: SiteText = {
      id, value: null, font_family: null, font_size: null, font_weight: null,
      font_style: null, color: null, letter_spacing: null, line_height: null, text_align: null,
    };
    textCache.set(id, blank);
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
    body.is-text-edit [data-editable-text].is-editable {
      cursor: text;
      transition: outline 120ms ease;
    }
    body.is-text-edit [data-editable-text].is-editable:hover {
      outline: 1px dashed rgba(76, 194, 255, 0.55);
      outline-offset: 4px;
    }
    body.is-text-edit [data-editable-text].is-selected {
      outline: 2px solid #4cc2ff;
      outline-offset: 4px;
    }
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
    }
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
