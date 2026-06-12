/**
 * "Rescue drifted elements" panel.
 *
 * A modal that lists every editable text/image row whose saved offset
 * pushes it more than 40px from its natural position. Each row has a
 * one-click reset that nulls out offset_x / offset_y / rotation, so a
 * box that got dragged off-screen and can no longer be selected in the
 * editor can still be rescued.
 *
 * Exposed via `openRescuePanel(targetDoc?)`. Used from both edit-nav
 * (desktop editor) and the /edit/mobile/ shell so the user can call it
 * from wherever they happen to be editing.
 */
import { supabase, type SiteText, type SiteImage } from "../lib/supabase";

type Row = {
  kind: "text" | "image";
  id: string;
  value: string;
  offsetX: string | null;
  offsetY: string | null;
  rotation: number;
  updatedAt: string | null;
};

function parsePx(v: string | null | undefined): number {
  if (!v) return 0;
  const m = String(v).match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}

async function loadDrifted(threshold = 40): Promise<Row[]> {
  const out: Row[] = [];
  const { data: tData } = await supabase
    .from("site_text")
    .select("id, value, offset_x, offset_y, rotation, updated_at")
    .order("updated_at", { ascending: false });
  for (const r of (tData || []) as SiteText[]) {
    const mag = Math.hypot(parsePx(r.offset_x), parsePx(r.offset_y));
    if (mag > threshold || Math.abs(r.rotation || 0) > 5) {
      out.push({
        kind: "text",
        id: r.id,
        value: (r.value || "").slice(0, 40),
        offsetX: r.offset_x,
        offsetY: r.offset_y,
        rotation: r.rotation || 0,
        updatedAt: (r as any).updated_at || null,
      });
    }
  }
  const { data: iData } = await supabase
    .from("site_image")
    .select("id, offset_x, offset_y, rotation, src, updated_at")
    .order("updated_at", { ascending: false });
  for (const r of (iData || []) as SiteImage[]) {
    const mag = Math.hypot(parsePx(r.offset_x), parsePx(r.offset_y));
    if (mag > threshold || Math.abs(r.rotation || 0) > 5) {
      out.push({
        kind: "image",
        id: r.id,
        value: "(image)",
        offsetX: r.offset_x,
        offsetY: r.offset_y,
        rotation: r.rotation || 0,
        updatedAt: (r as any).updated_at || null,
      });
    }
  }
  // Sort by magnitude descending so the worst offenders are at top.
  out.sort((a, b) => {
    const am = Math.hypot(parsePx(a.offsetX), parsePx(a.offsetY));
    const bm = Math.hypot(parsePx(b.offsetX), parsePx(b.offsetY));
    return bm - am;
  });
  return out;
}

async function resetOne(row: Row): Promise<boolean> {
  const table = row.kind === "text" ? "site_text" : "site_image";
  const { error } = await supabase
    .from(table)
    .update({ offset_x: null, offset_y: null, rotation: 0, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  return !error;
}

function styles(targetDoc: Document) {
  if (targetDoc.getElementById("rescue-panel-styles")) return;
  const s = targetDoc.createElement("style");
  s.id = "rescue-panel-styles";
  s.textContent = `
    .rescue-backdrop {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(4px);
      z-index: 5000;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .rescue-panel {
      width: min(720px, 100%);
      max-height: 90vh;
      background: #1a1c20;
      color: #e8ebf0;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
      display: flex; flex-direction: column;
      font-family: "Inter", "SF Pro Text", system-ui, sans-serif;
    }
    .rescue-head {
      display: flex; align-items: center; gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .rescue-head h3 {
      margin: 0; font-size: 16px; font-weight: 700; color: #fff;
      flex: 1;
    }
    .rescue-head .rescue-count {
      background: rgba(255, 204, 0, 0.15);
      color: #ffcc00; font-size: 12px; font-weight: 700;
      padding: 3px 10px; border-radius: 999px;
    }
    .rescue-head .rescue-close {
      background: transparent; color: #aaa; border: 0;
      font-size: 22px; cursor: pointer; line-height: 1;
      width: 32px; height: 32px; border-radius: 6px;
    }
    .rescue-head .rescue-close:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

    .rescue-body { overflow-y: auto; flex: 1; }
    .rescue-empty {
      padding: 60px 20px; text-align: center; color: rgba(255, 255, 255, 0.55);
    }
    .rescue-row {
      display: grid;
      grid-template-columns: auto 1fr auto auto;
      align-items: center; gap: 14px;
      padding: 12px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .rescue-row:last-child { border-bottom: 0; }
    .rescue-kind {
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.05em;
      padding: 3px 8px; border-radius: 4px;
      background: rgba(255, 255, 255, 0.06); color: #aaa;
    }
    .rescue-kind.is-text { background: rgba(76, 194, 255, 0.2); color: #4cc2ff; }
    .rescue-kind.is-image { background: rgba(255, 204, 0, 0.2); color: #ffcc00; }
    .rescue-info { min-width: 0; }
    .rescue-info-id {
      font-family: "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .rescue-info-value {
      font-size: 13px; color: #fff;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .rescue-offset {
      font-family: "SF Mono", Menlo, monospace;
      font-size: 12px; color: #ffaa66;
      white-space: nowrap;
    }
    .rescue-reset {
      background: linear-gradient(135deg, #ffcc00, #ffae00);
      color: #1a1200; font-weight: 700;
      border: 0; border-radius: 6px;
      padding: 7px 14px; cursor: pointer; font: inherit;
    }
    .rescue-reset:hover { filter: brightness(1.06); }
    .rescue-reset:disabled { opacity: 0.4; cursor: default; filter: none; }

    .rescue-foot {
      padding: 12px 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex; gap: 10px; justify-content: flex-end;
    }
    .rescue-foot button {
      background: rgba(255, 255, 255, 0.06);
      color: #e8ebf0;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 8px 14px; cursor: pointer; font: inherit;
    }
    .rescue-foot button.rescue-reset-all {
      background: linear-gradient(135deg, #ff5a5a, #cc3333);
      color: #fff; border: 0; font-weight: 700;
    }
    .rescue-foot button:hover { filter: brightness(1.1); }
  `;
  targetDoc.head.appendChild(s);
}

export function openRescuePanel(targetDoc: Document = document): void {
  styles(targetDoc);

  const backdrop = targetDoc.createElement("div");
  backdrop.className = "rescue-backdrop";
  backdrop.dataset.noEdit = "";

  backdrop.innerHTML = `
    <div class="rescue-panel" role="dialog" aria-label="rescue drifted elements">
      <div class="rescue-head">
        <h3>🚨 rescue drifted elements</h3>
        <span class="rescue-count" data-count></span>
        <button class="rescue-close" type="button" title="close">×</button>
      </div>
      <div class="rescue-body" data-body>
        <div class="rescue-empty">loading…</div>
      </div>
      <div class="rescue-foot">
        <button type="button" data-refresh>refresh</button>
        <button type="button" class="rescue-reset-all" data-reset-all>reset all</button>
      </div>
    </div>
  `;

  targetDoc.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector(".rescue-close")!.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  let currentRows: Row[] = [];
  const renderRow = (row: Row): string => {
    const off = `${row.offsetX || "0"}, ${row.offsetY || "0"}` + (row.rotation ? `, ${row.rotation}°` : "");
    return `
      <div class="rescue-row" data-row-id="${row.id}">
        <span class="rescue-kind is-${row.kind}">${row.kind}</span>
        <div class="rescue-info">
          <div class="rescue-info-value">${row.value ? escapeHtml(row.value) : "(empty)"}</div>
          <div class="rescue-info-id">${escapeHtml(row.id)}</div>
        </div>
        <span class="rescue-offset">${escapeHtml(off)}</span>
        <button class="rescue-reset" type="button" data-reset-id="${row.id}" data-kind="${row.kind}">↺ reset</button>
      </div>
    `;
  };

  const renderList = () => {
    const body = backdrop.querySelector("[data-body]") as HTMLElement;
    const count = backdrop.querySelector("[data-count]") as HTMLElement;
    count.textContent = `${currentRows.length} drifted`;
    if (currentRows.length === 0) {
      body.innerHTML = `<div class="rescue-empty">✓ all clear. nothing has wandered.</div>`;
      return;
    }
    body.innerHTML = currentRows.map(renderRow).join("");
    body.querySelectorAll<HTMLButtonElement>("[data-reset-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.resetId!;
        const kind = btn.dataset.kind! as "text" | "image";
        btn.disabled = true; btn.textContent = "…";
        const row = currentRows.find((r) => r.id === id && r.kind === kind);
        if (row) {
          const ok = await resetOne(row);
          if (ok) {
            currentRows = currentRows.filter((r) => !(r.id === id && r.kind === kind));
            renderList();
          } else {
            btn.disabled = false; btn.textContent = "↺ reset";
            alert("Reset failed — check console.");
          }
        }
      });
    });
  };

  const reload = async () => {
    const body = backdrop.querySelector("[data-body]") as HTMLElement;
    body.innerHTML = `<div class="rescue-empty">loading…</div>`;
    currentRows = await loadDrifted();
    renderList();
  };

  backdrop.querySelector("[data-refresh]")!.addEventListener("click", reload);
  backdrop.querySelector("[data-reset-all]")!.addEventListener("click", async () => {
    if (!confirm(`Reset ALL ${currentRows.length} drifted elements?\nThis nulls offset_x/y and rotation on every row in the list.`)) return;
    const body = backdrop.querySelector("[data-body]") as HTMLElement;
    body.innerHTML = `<div class="rescue-empty">resetting…</div>`;
    for (const r of currentRows) await resetOne(r);
    await reload();
  });

  reload();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
