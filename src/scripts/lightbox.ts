/**
 * Site-wide image lightbox.
 *
 * Clicking any <img> on the page opens it at full size in a fullscreen
 * overlay. Picks the highest-resolution variant available (largest
 * entry in the img's srcset, falling back to its src) so the lightbox
 * always shows the highest-quality copy the site has.
 *
 * Skipped:
 *   - Edit mode (any of body.is-text-edit / is-image-edit / is-mural-edit)
 *   - Images inside an <a href="..."> (let the navigation happen)
 *   - Tiny decorative icons (under 80px natural width)
 *   - Editor-internal UI images
 */

let overlay: HTMLDivElement | null = null;
let prevFocus: HTMLElement | null = null;

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

function ensureStyles() {
  if (document.getElementById("lightbox-styles")) return;
  const s = document.createElement("style");
  s.id = "lightbox-styles";
  s.textContent = `
    .lightbox-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.92);
      backdrop-filter: blur(6px);
      z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: clamp(8px, 3vw, 32px);
      opacity: 0;
      transition: opacity 200ms ease;
      cursor: zoom-out;
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
      cursor: default;
    }
    .lightbox-overlay.is-open .lightbox-img { transform: scale(1); }
    .lightbox-loading {
      position: absolute;
      color: rgba(255, 255, 255, 0.55);
      font-family: monospace;
      font-size: 13px;
      pointer-events: none;
    }
    .lightbox-close {
      position: absolute;
      top: max(16px, env(safe-area-inset-top));
      right: max(16px, env(safe-area-inset-right));
      width: 44px; height: 44px;
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(6px);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 50%;
      font-size: 22px; line-height: 1;
      cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background 120ms ease, transform 120ms ease;
      z-index: 1;
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
      z-index: 1;
    }
    .lightbox-overlay.is-open .lightbox-caption { opacity: 1; }
    .lightbox-close:hover {
      background: rgba(255, 255, 255, 0.16);
      transform: scale(1.05);
    }
    /* Make body un-scrollable while lightbox is open. */
    body.lightbox-open { overflow: hidden; }
  `;
  document.head.appendChild(s);
}

function close() {
  if (!overlay) return;
  const o = overlay;
  overlay = null;
  o.classList.remove("is-open");
  document.body.classList.remove("lightbox-open");
  const remove = () => o.remove();
  o.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 300); // safety
  document.removeEventListener("keydown", onKey);
  if (prevFocus && typeof prevFocus.focus === "function") {
    try { prevFocus.focus({ preventScroll: true }); } catch {}
  }
  prevFocus = null;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

function open(img: HTMLImageElement) {
  if (overlay) close();
  ensureStyles();
  prevFocus = document.activeElement as HTMLElement | null;

  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.dataset.noEdit = "";

  const loading = document.createElement("div");
  loading.className = "lightbox-loading";
  loading.textContent = "loading…";

  const full = document.createElement("img");
  full.className = "lightbox-img";
  full.alt = img.alt || "";
  full.src = getFullSrc(img);
  full.addEventListener("load", () => loading.remove(), { once: true });

  const closeBtn = document.createElement("button");
  closeBtn.className = "lightbox-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "close");
  closeBtn.textContent = "×";

  overlay.appendChild(loading);
  overlay.appendChild(full);
  overlay.appendChild(closeBtn);

  // Caption strip below the image — content comes from the original
  // <img alt>. For mural tiles this is the editor-set "caption" field
  // (where painted, when). If alt is empty / a default filename we
  // suppress the strip so untouched photos don't render a placeholder.
  const captionText = (img.alt || "").trim();
  if (captionText && !/^\s*(IMG|DSC|cover|salt|sicamous|sooke|tofino|portugal|vietnam|israel|nakusp|calgary|nepal|oregon|victoria)[\s_\-]?\d*$/i.test(captionText)) {
    const caption = document.createElement("div");
    caption.className = "lightbox-caption";
    caption.textContent = captionText;
    overlay.appendChild(caption);
  }
  document.body.appendChild(overlay);
  document.body.classList.add("lightbox-open");

  // Click backdrop OR × → close. Clicks on the image itself don't close.
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay || ev.target === closeBtn) close();
  });
  document.addEventListener("keydown", onKey);

  requestAnimationFrame(() => overlay && overlay.classList.add("is-open"));
}

export function initLightbox(): void {
  if (typeof window === "undefined") return;
  // Capture phase so we can intercept before tile/link handlers.
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
