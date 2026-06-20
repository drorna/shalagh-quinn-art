/**
 * Site-wide image lightbox with gallery navigation + zoom + pan.
 *
 * Tap any <img> on the page → opens it fullscreen. If the image is part
 * of a gallery (siblings inside the same .prints-grid / .portraits-grid /
 * .murals-canvas / [data-lightbox-gallery]) you get prev/next arrows,
 * keyboard arrows, and a counter. Wheel scroll + pinch zoom in; drag
 * pans once zoomed. Caption comes from the source img's alt attribute
 * (which is what the mural editor's "caption" field writes to).
 *
 * Skipped:
 *   - Edit mode (any of body.is-text-edit / is-image-edit / is-mural-edit)
 *   - Images inside an <a href="..."> (let the navigation happen)
 *   - Tiny decorative icons (under 80px natural width)
 *   - Editor-internal UI images
 */

interface LightboxState {
  overlay: HTMLDivElement;
  imgEl: HTMLImageElement;
  loadingEl: HTMLDivElement;
  captionEl: HTMLDivElement | null;
  counterEl: HTMLDivElement | null;
  prevBtn: HTMLButtonElement | null;
  nextBtn: HTMLButtonElement | null;
  gallery: HTMLImageElement[];
  index: number;
  zoom: number;
  panX: number;
  panY: number;
  pointers: Map<number, { x: number; y: number }>;
  pinchStart: { dist: number; zoom: number; cx: number; cy: number } | null;
  dragStart: { x: number; y: number; panX: number; panY: number } | null;
}

let state: LightboxState | null = null;
let prevFocus: HTMLElement | null = null;

const GALLERY_SELECTOR =
  ".prints-grid, .portraits-grid, .murals-canvas, [data-lightbox-gallery]";

function getFullSrc(img: HTMLImageElement): string {
  // Pick the largest srcset entry by pixel width.
  const srcset = img.getAttribute("srcset");
  if (srcset) {
    let best = img.currentSrc || img.src;
    let bestW = 0;
    for (const part of srcset.split(",")) {
      const [url, descriptor] = part.trim().split(/\s+/);
      const m = (descriptor || "").match(/(\d+)w/);
      const w = m ? parseInt(m[1], 10) : 0;
      if (url && w > bestW) {
        best = url;
        bestW = w;
      }
    }
    return best;
  }
  return img.currentSrc || img.src;
}

function isEditing(): boolean {
  const b = document.body;
  return (
    b.classList.contains("is-text-edit") ||
    b.classList.contains("is-image-edit") ||
    b.classList.contains("is-mural-edit")
  );
}

function shouldOpen(img: HTMLImageElement): boolean {
  if (isEditing()) return false;
  // Skip if the image is the click target of an actual link.
  if (img.closest("a[href]")) return false;
  // Skip tiny decorative icons / svg-likes.
  if (img.complete && img.naturalWidth && img.naturalWidth < 80) return false;
  // Skip editor / chrome UI.
  if (
    img.closest(
      ".edit-nav, .text-edit-toolbar, .image-edit-toolbar, " +
        ".mural-mini-panel, .mural-edit-toolbar, .lightbox-overlay, " +
        "[data-no-lightbox]",
    )
  ) {
    return false;
  }
  return true;
}

function collectGallery(img: HTMLImageElement): HTMLImageElement[] {
  const container = img.closest(GALLERY_SELECTOR);
  if (!container) return [img];
  const candidates = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
  // Filter out tiny / hidden / linked / editor-chrome — keep the same
  // gating that shouldOpen uses for the click-handler entry point.
  return candidates.filter((c) => {
    if (c.closest("a[href]")) return false;
    if (c.complete && c.naturalWidth && c.naturalWidth < 80) return false;
    if (c.closest(".edit-nav, .text-edit-toolbar, .image-edit-toolbar, .mural-mini-panel, .mural-edit-toolbar, [data-no-lightbox]")) return false;
    return true;
  });
}

function ensureStyles() {
  if (document.getElementById("lightbox-styles")) return;
  const s = document.createElement("style");
  s.id = "lightbox-styles";
  s.textContent = `
    .lightbox-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.94);
      backdrop-filter: blur(6px);
      z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: clamp(8px, 3vw, 32px);
      opacity: 0;
      transition: opacity 200ms ease;
      cursor: zoom-out;
      overflow: hidden;
      touch-action: none;
    }
    .lightbox-overlay.is-open { opacity: 1; }
    .lightbox-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 0 60px rgba(0, 0, 0, 0.65);
      border-radius: 4px;
      transform: scale(0.96);
      transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
      cursor: zoom-in;
      user-select: none;
      -webkit-user-drag: none;
      will-change: transform;
    }
    .lightbox-overlay.is-open .lightbox-img { transform: scale(1); }
    .lightbox-overlay.is-zoomed .lightbox-img { cursor: grab; }
    .lightbox-overlay.is-panning .lightbox-img { cursor: grabbing; transition: none; }
    /* While transitioning between images (image swap) suppress the
       enter animation so the new image just lands at scale(1). */
    .lightbox-overlay.is-swapping .lightbox-img { transition: none; }

    .lightbox-loading {
      position: absolute;
      color: rgba(255, 255, 255, 0.55);
      font-family: monospace;
      font-size: 13px;
      pointer-events: none;
    }
    .lightbox-close,
    .lightbox-nav {
      position: absolute;
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(6px);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background 120ms ease, transform 120ms ease;
      z-index: 2;
      line-height: 1;
    }
    .lightbox-close:hover,
    .lightbox-nav:hover {
      background: rgba(255, 255, 255, 0.18);
      transform: scale(1.05);
    }
    .lightbox-close {
      top: max(16px, env(safe-area-inset-top));
      right: max(16px, env(safe-area-inset-right));
      width: 44px; height: 44px;
      font-size: 22px;
    }
    .lightbox-nav {
      top: 50%;
      transform: translateY(-50%);
      width: 52px; height: 52px;
      font-size: 26px;
      font-weight: 300;
    }
    .lightbox-nav:hover { transform: translateY(-50%) scale(1.05); }
    .lightbox-nav.is-prev { left: max(16px, env(safe-area-inset-left)); }
    .lightbox-nav.is-next { right: max(16px, env(safe-area-inset-right)); }
    .lightbox-nav[aria-disabled="true"] {
      opacity: 0.25;
      pointer-events: none;
    }
    .lightbox-counter {
      position: absolute;
      top: max(16px, env(safe-area-inset-top));
      left: max(16px, env(safe-area-inset-left));
      padding: 6px 12px;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      color: rgba(255, 255, 255, 0.85);
      font-family: Arial, "Helvetica Neue", sans-serif;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      pointer-events: none;
      z-index: 2;
    }

    .lightbox-caption {
      position: absolute;
      left: 50%;
      bottom: max(20px, env(safe-area-inset-bottom));
      transform: translateX(-50%);
      max-width: min(86vw, 720px);
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      color: rgba(255, 255, 255, 0.92);
      font-family: Arial, "Helvetica Neue", sans-serif;
      font-size: clamp(0.85rem, 2.6vw, 0.95rem);
      line-height: 1.35;
      text-align: center;
      pointer-events: none;
      opacity: 0;
      transition: opacity 220ms ease 80ms;
      z-index: 2;
    }
    .lightbox-overlay.is-open .lightbox-caption { opacity: 1; }

    body.lightbox-open { overflow: hidden; }
  `;
  document.head.appendChild(s);
}

function isCaptionRaw(s: string): boolean {
  // Filenames-as-alt-text shouldn't render — let the user fill in a
  // real caption via the editor first.
  return /^\s*(IMG|DSC|cover|salt|sicamous|sooke|tofino|portugal|vietnam|israel|nakusp|calgary|nepal|oregon|victoria|print)[\s_\-]?\d*$/i.test(
    s,
  );
}

function applyTransform() {
  if (!state) return;
  state.imgEl.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}

function clampPan() {
  if (!state) return;
  // Keep the scaled image at least partially overlapping the viewport.
  const r = state.imgEl.getBoundingClientRect();
  const overflowX = Math.max(0, r.width - window.innerWidth);
  const overflowY = Math.max(0, r.height - window.innerHeight);
  // overflow / 2 is the maximum pan in each direction.
  const limX = overflowX / 2 / state.zoom;
  const limY = overflowY / 2 / state.zoom;
  state.panX = Math.max(-limX, Math.min(limX, state.panX));
  state.panY = Math.max(-limY, Math.min(limY, state.panY));
}

function setZoom(nextZoom: number, focalX?: number, focalY?: number) {
  if (!state) return;
  const z = Math.max(1, Math.min(5, nextZoom));
  // Zoom around the focal point (default: image centre).
  if (focalX !== undefined && focalY !== undefined) {
    const r = state.imgEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = focalX - cx;
    const dy = focalY - cy;
    const ratio = z / state.zoom;
    state.panX = (state.panX - dx) * ratio + dx;
    state.panY = (state.panY - dy) * ratio + dy;
  }
  state.zoom = z;
  state.overlay.classList.toggle("is-zoomed", z > 1.01);
  if (z <= 1.01) {
    state.panX = 0;
    state.panY = 0;
  } else {
    clampPan();
  }
  applyTransform();
}

function close() {
  if (!state) return;
  const s = state;
  state = null;
  s.overlay.classList.remove("is-open");
  document.body.classList.remove("lightbox-open");
  const remove = () => s.overlay.remove();
  s.overlay.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 300);
  document.removeEventListener("keydown", onKey);
  if (prevFocus && typeof prevFocus.focus === "function") {
    try { prevFocus.focus({ preventScroll: true }); } catch {}
  }
  prevFocus = null;
}

function showAt(idx: number) {
  if (!state) return;
  const src = state.gallery[idx];
  if (!src) return;
  state.index = idx;

  // Reset zoom + pan whenever we swap images.
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.overlay.classList.remove("is-zoomed");

  state.imgEl.style.transform = "";
  state.loadingEl.style.display = "";

  state.imgEl.alt = src.alt || "";
  state.imgEl.src = getFullSrc(src);

  if (state.captionEl) {
    const t = (src.alt || "").trim();
    if (t && !isCaptionRaw(t)) {
      state.captionEl.textContent = t;
      state.captionEl.style.display = "";
    } else {
      state.captionEl.style.display = "none";
    }
  }

  if (state.counterEl && state.gallery.length > 1) {
    state.counterEl.textContent = `${idx + 1} / ${state.gallery.length}`;
  }

  if (state.prevBtn) {
    state.prevBtn.setAttribute("aria-disabled", idx === 0 ? "true" : "false");
  }
  if (state.nextBtn) {
    state.nextBtn.setAttribute(
      "aria-disabled",
      idx === state.gallery.length - 1 ? "true" : "false",
    );
  }
}

function next() {
  if (!state) return;
  if (state.index < state.gallery.length - 1) showAt(state.index + 1);
}

function prev() {
  if (!state) return;
  if (state.index > 0) showAt(state.index - 1);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
  else if (e.key === "ArrowRight") next();
  else if (e.key === "ArrowLeft") prev();
  else if (e.key === "+" || e.key === "=") setZoom((state?.zoom || 1) * 1.4);
  else if (e.key === "-" || e.key === "_") setZoom((state?.zoom || 1) / 1.4);
  else if (e.key === "0") setZoom(1);
}

function open(img: HTMLImageElement) {
  if (state) close();
  ensureStyles();
  prevFocus = document.activeElement as HTMLElement | null;

  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.dataset.noEdit = "";

  const loadingEl = document.createElement("div");
  loadingEl.className = "lightbox-loading";
  loadingEl.textContent = "loading…";

  const imgEl = document.createElement("img");
  imgEl.className = "lightbox-img";
  imgEl.draggable = false;
  imgEl.addEventListener("load", () => {
    loadingEl.style.display = "none";
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "lightbox-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "close");
  closeBtn.textContent = "×";

  overlay.append(loadingEl, imgEl, closeBtn);

  const captionEl = document.createElement("div");
  captionEl.className = "lightbox-caption";
  overlay.append(captionEl);

  // Build the gallery and add prev/next + counter only if there is more
  // than one image to navigate between.
  const gallery = collectGallery(img);
  const startIdx = Math.max(0, gallery.indexOf(img));

  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  let counterEl: HTMLDivElement | null = null;
  if (gallery.length > 1) {
    prevBtn = document.createElement("button");
    prevBtn.className = "lightbox-nav is-prev";
    prevBtn.type = "button";
    prevBtn.setAttribute("aria-label", "previous");
    prevBtn.textContent = "‹";
    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); prev(); });

    nextBtn = document.createElement("button");
    nextBtn.className = "lightbox-nav is-next";
    nextBtn.type = "button";
    nextBtn.setAttribute("aria-label", "next");
    nextBtn.textContent = "›";
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); next(); });

    counterEl = document.createElement("div");
    counterEl.className = "lightbox-counter";

    overlay.append(prevBtn, nextBtn, counterEl);
  }

  state = {
    overlay,
    imgEl,
    loadingEl,
    captionEl,
    counterEl,
    prevBtn,
    nextBtn,
    gallery,
    index: startIdx,
    zoom: 1,
    panX: 0,
    panY: 0,
    pointers: new Map(),
    pinchStart: null,
    dragStart: null,
  };

  document.body.appendChild(overlay);
  document.body.classList.add("lightbox-open");

  // Click backdrop OR × → close. Clicks on the image / arrows / counter
  // pass through.
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay || ev.target === closeBtn) close();
  });

  // Wheel → zoom centred on cursor.
  overlay.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      if (!state) return;
      const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom(state.zoom * factor, ev.clientX, ev.clientY);
    },
    { passive: false },
  );

  // Double-click image → toggle 1× ↔ 2.2×.
  imgEl.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    if (!state) return;
    setZoom(state.zoom > 1.05 ? 1 : 2.2, ev.clientX, ev.clientY);
  });

  // Pointer-based pan (mouse drag + touch single-finger when zoomed).
  // Two-finger touch = pinch zoom.
  imgEl.addEventListener("pointerdown", (ev) => {
    if (!state) return;
    state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (state.pointers.size === 2) {
      const [a, b] = Array.from(state.pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      state.pinchStart = {
        dist,
        zoom: state.zoom,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      state.dragStart = null;
    } else if (state.pointers.size === 1 && state.zoom > 1.01) {
      state.dragStart = {
        x: ev.clientX, y: ev.clientY,
        panX: state.panX, panY: state.panY,
      };
      state.overlay.classList.add("is-panning");
      try { imgEl.setPointerCapture(ev.pointerId); } catch {}
    }
  });

  imgEl.addEventListener("pointermove", (ev) => {
    if (!state) return;
    if (!state.pointers.has(ev.pointerId)) return;
    state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (state.pinchStart && state.pointers.size === 2) {
      const [a, b] = Array.from(state.pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = dist / state.pinchStart.dist;
      setZoom(state.pinchStart.zoom * ratio, state.pinchStart.cx, state.pinchStart.cy);
    } else if (state.dragStart && state.pointers.size === 1) {
      state.panX = state.dragStart.panX + (ev.clientX - state.dragStart.x);
      state.panY = state.dragStart.panY + (ev.clientY - state.dragStart.y);
      clampPan();
      applyTransform();
    }
  });

  const endPointer = (ev: PointerEvent) => {
    if (!state) return;
    state.pointers.delete(ev.pointerId);
    state.dragStart = null;
    state.pinchStart = null;
    state.overlay.classList.remove("is-panning");
  };
  imgEl.addEventListener("pointerup", endPointer);
  imgEl.addEventListener("pointercancel", endPointer);
  imgEl.addEventListener("pointerleave", endPointer);

  document.addEventListener("keydown", onKey);

  showAt(startIdx);
  requestAnimationFrame(() => overlay.classList.add("is-open"));
}

export function initLightbox(): void {
  if (typeof window === "undefined") return;
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement;
      if (!t || t.tagName !== "IMG") return;
      const img = t as HTMLImageElement;
      if (!shouldOpen(img)) return;
      e.preventDefault();
      e.stopPropagation();
      open(img);
    },
    true,
  );
}
