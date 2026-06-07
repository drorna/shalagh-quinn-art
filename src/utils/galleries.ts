import type { ImageMetadata } from "astro";

export type GalleryKey = "murals" | "prints" | "portraits";

export interface GalleryItem {
  src: ImageMetadata;
  alt: string;
  filename: string;
}

const muralImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/murals/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const printImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/prints/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const portraitImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/portraits/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const muralSlideImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/mural-slides/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const printSlideImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/prints-slides/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

// Stable hash so non-numbered files appear in a consistent "random" order
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const NUMBERED_RE = /^(?:slide\s*)?(\d+)(?:[\s_\-.].*)?\.[a-zA-Z]+$/i;

function toGallery(
  imports: Record<string, { default: ImageMetadata }>,
  altPrefix: string
): GalleryItem[] {
  const items = Object.entries(imports).map(([path, mod]) => {
    const filename = (path.split("/").pop() || "image").trim();
    const match = filename.match(NUMBERED_RE);
    const order = match ? parseInt(match[1], 10) : null;
    return {
      src: mod.default,
      alt: `${altPrefix} — ${filename.replace(/\.[^.]+$/, "")}`,
      filename,
      order,
    };
  });

  const numbered = items
    .filter((i) => i.order !== null)
    .sort((a, b) => (a.order as number) - (b.order as number));

  const unnumbered = items
    .filter((i) => i.order === null)
    .sort((a, b) => stableHash(a.filename) - stableHash(b.filename));

  return [...numbered, ...unnumbered].map(({ src, alt, filename }) => ({
    src,
    alt,
    filename,
  }));
}

export const galleries: Record<GalleryKey, GalleryItem[]> = {
  murals: toGallery(muralImports, "Mural by Shalagh Quinn"),
  prints: toGallery(printImports, "Print by Shalagh Quinn"),
  portraits: toGallery(portraitImports, "Portrait by Shalagh Quinn"),
};

export const slideshows: Partial<Record<GalleryKey, GalleryItem[]>> = {
  murals: toGallery(muralSlideImports, "Mural slide"),
  prints: toGallery(printSlideImports, "Print slide"),
};

export interface SectionMeta {
  key: GalleryKey;
  title: string;
  href: string;
}

export const sections: SectionMeta[] = [
  { key: "murals", title: "murals", href: "/murals/" },
  { key: "prints", title: "prints", href: "/prints/" },
  { key: "portraits", title: "portraits", href: "/portraits/" },
];
