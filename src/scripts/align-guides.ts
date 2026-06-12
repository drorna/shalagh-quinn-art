/**
 * Alignment guides for the visual editor.
 *
 * While the user drags an editable text or image element, this module
 * watches the dragged element's bounding box and looks for edges /
 * centers that match other editable elements (or the viewport edges
 * and middle). When something lines up within a few pixels, a thin
 * magenta line shows the alignment AND the position snaps so a small
 * imprecision doesn't kill the alignment.
 *
 * Used by text-editor.ts and image-editor.ts in their drag-move
 * handlers: start on first movement, compute on every pointer move,
 * end on pointerup.
 */

const SNAP_PX = 5;
const GUIDE_COLOR = "#ff44aa";

let guideLayer: HTMLElement | null = null;
let activeEl: HTMLElement | null = null;

function ensureLayer(): HTMLElement {
  if (guideLayer && document.body.contains(guideLayer)) return guideLayer;
  guideLayer = document.createElement("div");
  guideLayer.className = "align-guides-layer";
  guideLayer.dataset.noEdit = "";
  guideLayer.setAttribute("aria-hidden", "true");
  guideLayer.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden;";
  document.body.appendChild(guideLayer);
  return guideLayer;
}

export function startAlignGuides(el: HTMLElement): void {
  activeEl = el;
  ensureLayer();
}

export function endAlignGuides(): void {
  activeEl = null;
  if (guideLayer) guideLayer.innerHTML = "";
}

/**
 * Given the dragged element's CURRENT bounding rect, returns the
 * (dx, dy) you should add to its position to snap to nearby alignments,
 * and draws guide lines for whichever alignments fired. Call once per
 * pointermove event with the rect AFTER you've applied the user's raw
 * drag delta — then re-apply the returned snap delta.
 *
 * Other editable elements are queried fresh each call so a sibling drag
 * elsewhere doesn't go stale. The dragged element itself is excluded.
 */
export function computeAlignSnap(rect: DOMRect): { dx: number; dy: number } {
  const layer = ensureLayer();
  layer.innerHTML = "";
  if (!activeEl) return { dx: 0, dy: 0 };

  const candidates: Array<{ rect: DOMRect; isViewport?: boolean }> = [];
  const selector = "[data-editable-text], [data-editable-image]";
  for (const other of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (other === activeEl) continue;
    // Skip descendants of the dragged element (e.g. a span editable
    // nested inside a paragraph editable).
    if (activeEl.contains(other) || other.contains(activeEl)) continue;
    const r = other.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    candidates.push({ rect: r });
  }
  // Add the viewport rect (so you can align to edges + center of screen).
  candidates.push({
    rect: new DOMRect(0, 0, window.innerWidth, window.innerHeight),
    isViewport: true,
  });

  const selfX = [rect.left, (rect.left + rect.right) / 2, rect.right];
  const selfY = [rect.top, (rect.top + rect.bottom) / 2, rect.bottom];

  let bestDx = 0, bestDxAbs = Infinity, bestDxAt = -1, bestDxBounds: [number, number] | null = null;
  let bestDy = 0, bestDyAbs = Infinity, bestDyAt = -1, bestDyBounds: [number, number] | null = null;

  for (const c of candidates) {
    const r = c.rect;
    const otherX = [r.left, (r.left + r.right) / 2, r.right];
    const otherY = [r.top, (r.top + r.bottom) / 2, r.bottom];

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        // X-axis match (vertical guide line)
        const dx = otherX[j] - selfX[i];
        const adx = Math.abs(dx);
        if (adx < SNAP_PX && adx < bestDxAbs) {
          bestDxAbs = adx;
          bestDx = dx;
          bestDxAt = otherX[j];
          bestDxBounds = c.isViewport
            ? [0, window.innerHeight]
            : [Math.min(rect.top + 0, r.top), Math.max(rect.bottom + 0, r.bottom)];
        }
        // Y-axis match (horizontal guide line)
        const dy = otherY[j] - selfY[i];
        const ady = Math.abs(dy);
        if (ady < SNAP_PX && ady < bestDyAbs) {
          bestDyAbs = ady;
          bestDy = dy;
          bestDyAt = otherY[j];
          bestDyBounds = c.isViewport
            ? [0, window.innerWidth]
            : [Math.min(rect.left + 0, r.left), Math.max(rect.right + 0, r.right)];
        }
      }
    }
  }

  if (bestDxBounds) drawGuide("v", bestDxAt + bestDx, bestDxBounds[0], bestDxBounds[1]);
  if (bestDyBounds) drawGuide("h", bestDyAt + bestDy, bestDyBounds[0], bestDyBounds[1]);

  return { dx: bestDx, dy: bestDy };
}

function drawGuide(dir: "v" | "h", at: number, from: number, to: number): void {
  if (!guideLayer) return;
  const line = document.createElement("div");
  if (dir === "v") {
    line.style.cssText =
      `position:absolute;left:${at - 0.5}px;top:${Math.max(0, from - 4)}px;` +
      `width:1px;height:${to - from + 8}px;background:${GUIDE_COLOR};` +
      `box-shadow:0 0 2px ${GUIDE_COLOR};`;
  } else {
    line.style.cssText =
      `position:absolute;top:${at - 0.5}px;left:${Math.max(0, from - 4)}px;` +
      `height:1px;width:${to - from + 8}px;background:${GUIDE_COLOR};` +
      `box-shadow:0 0 2px ${GUIDE_COLOR};`;
  }
  guideLayer.appendChild(line);
}
