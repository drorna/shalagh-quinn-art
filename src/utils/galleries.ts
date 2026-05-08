import type { ImageMetadata } from "astro";

export type GalleryKey = "murals" | "painting" | "portraits" | "photography";

export interface GalleryItem {
  src: ImageMetadata;
  alt: string;
  filename: string;
}

const muralImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/murals/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const paintingImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/painting/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const portraitImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/portraits/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

const photographyImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/photography/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
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

const NUMBERED_RE = /^(\d+)(?:[\s_\-.].*)?\.[a-zA-Z]+$/;

function toGallery(
  imports: Record<string, { default: ImageMetadata }>,
  altPrefix: string
): GalleryItem[] {
  const items = Object.entries(imports).map(([path, mod]) => {
    const filename = path.split("/").pop() || "image";
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
  painting: toGallery(paintingImports, "Painting by Shalagh Quinn"),
  portraits: toGallery(portraitImports, "Portrait by Shalagh Quinn"),
  photography: toGallery(photographyImports, "Photograph by Shalagh Quinn"),
};

export interface SectionMeta {
  key: GalleryKey;
  title: string;
  description: string;
  href: string;
  accentVar: string;
}

export const sections: SectionMeta[] = [
  {
    key: "murals",
    title: "Murals",
    description:
      "Large-scale wall paintings made for homes, businesses and public spaces. Each mural begins with a conversation about place, story and intention.",
    href: "/murals/",
    accentVar: "var(--color-murals)",
  },
  {
    key: "painting",
    title: "Painting",
    description:
      "Studio works on canvas and paper — abstract studies, color experiments and personal narratives developed across series.",
    href: "/painting/",
    accentVar: "var(--color-painting)",
  },
  {
    key: "portraits",
    title: "Portraits",
    description:
      "Painted portraiture from life and from photographs. Honest likenesses that hold the small, telling details of a person.",
    href: "/portraits/",
    accentVar: "var(--color-portraits)",
  },
  {
    key: "photography",
    title: "Portrait Photography",
    description:
      "Quiet, unhurried portrait sessions on film and digital. Made for individuals, families and creative collaborators.",
    href: "/photography/",
    accentVar: "var(--color-photography)",
  },
];
