import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * Content lives outside src/ on purpose: the `content/` folder at the
 * repo root doubles as an Obsidian vault. Drorna opens that folder in
 * Obsidian, edits the .md files, and the Obsidian Git plugin auto-pushes
 * to GitHub; Cloudflare Pages then redeploys in 1-2 minutes.
 *
 * Each .md file's filename (about, murals, portraits, prints, writing,
 * home) is the slug. Pages import the entry by slug via getEntry().
 *
 * Frontmatter fields are all optional except `title`, so simple pages
 * can declare just a title + body and elaborate pages can layer in the
 * structured slots (stanza, quote, intro, tail, cta).
 */
const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./content/pages" }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    stanza: z.string().optional(),
    quote: z.string().optional(),
    intro: z.array(z.string()).optional(),
    end: z.string().optional(),
    tail: z.string().optional(),
    ctaLabel: z.string().optional(),
    ctaHref: z.string().optional(),
    identityName: z.string().optional(),
    identityPron: z.string().optional(),
    exploreLabel: z.string().optional(),
    uploadLabel: z.string().optional(),
    enterLabel: z.string().optional(),
    contactLabel: z.string().optional(),
    sectionAboutSubtitle: z.string().optional(),
    sectionMuralsSubtitle: z.string().optional(),
    sectionPortraitsSubtitle: z.string().optional(),
    sectionPrintsSubtitle: z.string().optional(),
    handles: z.array(z.string()).optional(),
  }),
});

export const collections = { pages };
