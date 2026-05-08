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

function toGallery(
  imports: Record<string, { default: ImageMetadata }>,
  altPrefix: string
): GalleryItem[] {
  return Object.entries(imports)
    .map(([path, mod]) => {
      const filename = path.split("/").pop() || "image";
      return {
        src: mod.default,
        alt: `${altPrefix} — ${filename.replace(/\.[^.]+$/, "")}`,
        filename,
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
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
