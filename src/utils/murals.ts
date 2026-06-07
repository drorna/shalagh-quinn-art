import type { ImageMetadata } from "astro";

export interface MuralImage {
  src: ImageMetadata;
  alt: string;
  filename: string;
}

export interface MuralSubGroup {
  /** Display label, italic, e.g. "Sanu Lake / Begnas Lake Pokhara" */
  label: string;
  /** Filename prefix (after the country slug) that identifies this group. */
  match: string[];
}

export interface MuralCountry {
  slug: string;
  /** Display name, lower-case as in the design (e.g. "nepal", "salt spring island") */
  displayName: string;
  /** Filename of the MAIN cover image (bigger, side that holds the label). */
  coverFilename?: string;
  /** Filename of the SECONDARY image (smaller, opposite side). */
  secondaryFilename?: string;
  /** Optional grouping inside the country page (used by Nepal). */
  subGroups?: MuralSubGroup[];
}

/* Eager-import every mural image, grouped by country folder.
   The keys look like: '/src/assets/images/murals/nepal/nepal-bob-marley-1.jpg' */
const allMuralImports = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/images/murals/**/*.{jpeg,jpg,png,JPG,JPEG,PNG,gif,webp}",
  { eager: true }
);

function imagesForCountry(slug: string): MuralImage[] {
  const prefix = `/src/assets/images/murals/${slug}/`;
  const items: MuralImage[] = [];
  for (const [path, mod] of Object.entries(allMuralImports)) {
    if (!path.startsWith(prefix)) continue;
    const filename = path.slice(prefix.length);
    items.push({
      src: mod.default,
      alt: filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
      filename,
    });
  }
  // Stable sort by filename
  items.sort((a, b) => a.filename.localeCompare(b.filename));
  return items;
}

/* Ordering: first the four countries shown in the PDF opening grid
   (tofino, nepal, sooke, portugal), then the rest alphabetically.
   Cover + secondary picks are hand-chosen — no automation. */
export const countries: MuralCountry[] = [
  {
    slug: "tofino",
    displayName: "tofino",
    coverFilename:     "tofino-2.jpg",   // close-up of the red flower (portrait)
    secondaryFilename: "tofino-3.jpg",   // shalagh painting the wall (landscape)
  },
  {
    slug: "nepal",
    displayName: "nepal",
    coverFilename:     "nepal-lazy-bee-1.jpg",  // solar face (portrait, the PDF's main)
    secondaryFilename: "nepal-bob-marley-1.jpg", // ONE LOVE Rastafari (the PDF's secondary)
    subGroups: [
      { label: "Sanu Lake / Begnas Lake Pokhara", match: ["nepal-sanu", "nepal-sanus"] },
      { label: "Vegan Way / Lakeside Pokhara",     match: ["nepal-vegan"] },
      { label: "Ruby's Cafe / Pokhara",            match: ["nepal-rubys"] },
      { label: "Lazy Bee / Pokhara",               match: ["nepal-lazy"] },
      { label: "Bob Marley / Pokhara",             match: ["nepal-bob"] },
      { label: "Sun Mural / Pokhara",              match: ["nepal-sun"] },
      { label: "Cafe / Pokhara",                   match: ["nepal-cafe"] },
    ],
  },
  {
    slug: "sooke",
    displayName: "sooke",
    coverFilename:     "sooke-1.jpg",   // sunflower shed (portrait)
    secondaryFilename: "sooke-2.jpg",   // flowers and butterflies on siding
  },
  {
    slug: "portugal",
    displayName: "portugal",
    coverFilename:     "portugal-1.jpg", // close colourful houses (portrait)
    secondaryFilename: "portugal-6.jpg", // wide wall view (landscape)
  },
  {
    slug: "calgary",
    displayName: "calgary",
    coverFilename:     "calgary-2-cover.jpg", // hand-marked cover (landscape)
    secondaryFilename: "calgary-3.jpg",       // tulip-like abstract (landscape)
  },
  {
    slug: "india",
    displayName: "india",
    coverFilename: "india-1.jpg",
  },
  {
    slug: "israel",
    displayName: "israel",
    coverFilename:     "israel-2.jpg",  // shalagh + sun wall (portrait)
    secondaryFilename: "israel-1.jpg",  // blue wall with plants (landscape)
  },
  {
    slug: "kelowna",
    displayName: "kelowna",
    coverFilename: "kelowna-1.jpg",
  },
  {
    slug: "nakusp",
    displayName: "nakusp",
    coverFilename:     "nakusp-1.jpg",  // black school bus with flowers
    secondaryFilename: "nakusp-6.jpg",  // colourful container
  },
  {
    slug: "oregon",
    displayName: "oregon",
    coverFilename: "oregon-1.jpg",
  },
  {
    slug: "salt-spring-island",
    displayName: "salt spring island",
    coverFilename:     "salt-spring-island-2.jpg", // figure with moon
    secondaryFilename: "salt-spring-island-4.jpg", // fence view
  },
  {
    slug: "sicamous",
    displayName: "sicamous",
    coverFilename:     "sicamous-8.jpg", // close-up green leaf on blue (portrait)
    secondaryFilename: "sicamous-2.jpg", // flowers + butterfly (landscape)
  },
  {
    slug: "victoria",
    displayName: "victoria",
    coverFilename:     "victoria-2.jpg", // fish/octopus close-up (portrait)
    secondaryFilename: "victoria-1.jpg", // pub interior with mural (landscape)
  },
  {
    slug: "vietnam",
    displayName: "vietnam",
    coverFilename:     "vietnam-e-2.jpg", // Chinese lanterns wall (portrait)
    secondaryFilename: "vietnam-1.jpg",   // green/orange wall (landscape)
  },
];

export interface CountryView {
  country: MuralCountry;
  images: MuralImage[];
  /** Main image for the index grid (bigger, holds the label). */
  cover: MuralImage | null;
  /** Secondary image for the index grid (smaller, opposite side). */
  secondary: MuralImage | null;
  /** Either flat list or grouped (for Nepal). */
  groups: { label?: string; images: MuralImage[] }[];
}

export function getCountryView(slug: string): CountryView | null {
  const country = countries.find((c) => c.slug === slug);
  if (!country) return null;
  const images = imagesForCountry(slug);

  // Cover + secondary are hand-picked by filename in the countries[] table above.
  // Fallback only if the entry doesn't name them: first image as cover, none for secondary.
  let cover: MuralImage | null = null;
  if (country.coverFilename) {
    cover = images.find((i) => i.filename === country.coverFilename) || null;
  }
  if (!cover && images.length > 0) cover = images[0];

  let secondary: MuralImage | null = null;
  if (country.secondaryFilename) {
    secondary = images.find((i) => i.filename === country.secondaryFilename) || null;
  }
  // No automatic fallback for secondary — countries with only one chosen image
  // simply show just the main on the index page.

  let groups: CountryView["groups"];
  if (country.subGroups && country.subGroups.length > 0) {
    const taken = new Set<string>();
    groups = country.subGroups.map((g) => {
      const groupImgs = images.filter((img) => {
        if (taken.has(img.filename)) return false;
        const stem = img.filename.toLowerCase();
        const ok = g.match.some((m) => stem.startsWith(m.toLowerCase()));
        if (ok) taken.add(img.filename);
        return ok;
      });
      return { label: g.label, images: groupImgs };
    });
    const remaining = images.filter((i) => !taken.has(i.filename));
    if (remaining.length > 0) groups.push({ images: remaining });
  } else {
    groups = [{ images }];
  }

  return { country, images, cover, secondary, groups };
}

export function allCountryViews(): CountryView[] {
  return countries
    .map((c) => getCountryView(c.slug))
    .filter((v): v is CountryView => v !== null);
}
