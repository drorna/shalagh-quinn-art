# Editing content from Obsidian

This folder *is* an Obsidian vault. Every `.md` file under `pages/` maps to one page on shalagh.com — edits you make here flow to the live site automatically.

## One-time setup

1. **Open this folder as an Obsidian vault.** In Obsidian → *Open another vault* → *Open folder as vault* → pick `C:\Users\nadel\projects\art-website\shalagh-quinn-art`.
2. **Install the Obsidian Git plugin.** Settings → Community plugins → Browse → search "Obsidian Git" → Install + Enable.
3. **Configure auto-push.** Open the Obsidian Git settings:
   - *Vault backup interval (minutes)*: 5 (or whatever cadence feels right)
   - *Auto push after commit*: ON
   - *Auto pull on startup*: ON
4. Make sure your terminal at `C:\Users\nadel\projects\art-website` can already `git push` to GitHub without prompting (the plugin uses the same credentials).

## How it flows

```
Obsidian edits → save .md  →  Obsidian Git auto-commits + pushes
                           →  GitHub receives the commit
                           →  Cloudflare Pages rebuilds (≈1–2 min)
                           →  shalagh.com shows the new content
```

You'll see the update on the live site **within ~2 minutes** of saving in Obsidian, end to end.

## What's editable

| File | Page | What it controls |
|---|---|---|
| `pages/home.md` | / | Identity name, pronunciation, section subtitles, handles list |
| `pages/about.md` | /about/ | Subtitle, the "when I was 23" stanza, the italic quote, every body paragraph, the closing "follow the jounrey..." link |
| `pages/murals.md` | /murals/ | The "the jounrey" subtitle + intro paragraphs + closing line |
| `pages/portraits.md` | /portraits/ | Subtitle under the title |
| `pages/prints.md` | /prints/ | Subtitle under the title |
| `pages/writing.md` | /writing/ | The whole page — title, subtitle, body paragraphs |

## Markdown shape

Every `.md` file has YAML **frontmatter** at the top (structured fields) and a **body** below (free-form prose split into paragraphs by blank lines):

```yaml
---
title: about
subtitle: a trust in process
stanza: |
  when I was 23
  I had a vision
quote: |
  enjoy the process of learning about
  yourself in everything you do
tail: follow the jounrey...
ctaLabel: mural
ctaHref: /murals/
---

paragraph one. write naturally — line wraps inside the same paragraph
are fine, the site will reflow them.

paragraph two starts after a blank line.

paragraph three, and so on.
```

The pipe `|` after `stanza:` and `quote:` means "preserve this exact block of text including line breaks." Use it whenever you want a multi-line value.

## Watch out — the in-browser editor wins

The site also has a live in-browser editor (visit `https://shalagh.com/?edit=...`). Any edit you make there saves a per-element override in Supabase that **takes priority over the markdown default**.

If you change a paragraph in Obsidian and it doesn't show up on the live site, that paragraph probably has a leftover Supabase override from a previous browser edit. To clear it: open the browser editor, click the paragraph, hit the trash icon (or the reset button on the toolbar) — that wipes the override, and the next page load shows your Obsidian text again.

Going forward, decide per page: **either** Obsidian, **or** the browser editor — mixing them on the same paragraph causes confusion.
