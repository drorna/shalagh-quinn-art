import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.PUBLIC_SUPABASE_URL as string;
const key = import.meta.env.PUBLIC_SUPABASE_KEY as string;

if (!url || !key) {
  console.warn("Supabase env vars missing. Set PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_KEY in .env");
}

export const supabase = createClient(url, key);

export const STORAGE_BUCKET = "murals";

export type MuralTile = {
  id: string;
  /** Full public URL of the image (Supabase Storage) */
  src: string;
  alt: string;
  /** Grid column the tile starts in (0-indexed). Updated as the user drags. */
  x: number;
  /** Grid row the tile starts in. */
  y: number;
  /** Column span. */
  w: number;
  /** Row span. */
  h: number;
  rotation: number;
  object_position: string;
  /** Optional label shown bottom-right (e.g. "nepal"). */
  label: string | null;
  /** Optional link target (e.g. "/murals/nepal/"). */
  href: string | null;
  /** Insertion order — used as the secondary sort key. */
  order_idx: number;
  created_at?: string;
  updated_at?: string;
};

export async function fetchTiles(): Promise<MuralTile[]> {
  const { data, error } = await supabase
    .from("mural_tiles")
    .select("*")
    .order("y", { ascending: true })
    .order("x", { ascending: true })
    .order("order_idx", { ascending: true });
  if (error) {
    console.error("[supabase] fetchTiles failed", error);
    return [];
  }
  return (data || []) as MuralTile[];
}

export async function upsertTile(tile: MuralTile) {
  const { error } = await supabase
    .from("mural_tiles")
    .upsert({ ...tile, updated_at: new Date().toISOString() });
  if (error) {
    console.error("[supabase] upsertTile failed", error);
    window.dispatchEvent(new CustomEvent("mural:save", { detail: { ok: false } }));
  } else {
    window.dispatchEvent(new CustomEvent("mural:save", { detail: { ok: true } }));
  }
}

export async function deleteTile(id: string) {
  // delete row
  const { error } = await supabase.from("mural_tiles").delete().eq("id", id);
  if (error) console.error("[supabase] deleteTile row failed", error);
}

export async function uploadImageFile(file: File): Promise<{ src: string; path: string } | null> {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, {
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) {
    console.error("[supabase] upload failed", error);
    return null;
  }
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return { src: data.publicUrl, path };
}

export async function deleteImageFile(src: string): Promise<void> {
  // Extract storage path from public URL
  const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
  const idx = src.indexOf(marker);
  if (idx === -1) return;
  const path = src.slice(idx + marker.length);
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([path]);
  if (error) console.error("[supabase] delete file failed", error);
}
