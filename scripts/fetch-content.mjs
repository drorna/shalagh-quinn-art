// Pulls the site's text content from its dedicated content repo into
// ./shalagh-quinn-art/ before every build (and dev start).
//
// Why: the content lives in a SEPARATE private repo (shalagh-content) so
// an editor's machine can be given access to the words without ever
// touching this code. Astro's content.config.ts still reads from
// ./shalagh-quinn-art/ exactly as before — this script is what puts the
// files there.
//
//   - On CI (Cloudflare Pages): the folder doesn't exist yet, so we clone.
//     Auth comes from the CONTENT_REPO_TOKEN env var (a read-only,
//     content-repo-scoped fine-grained token set in the Pages project).
//   - Locally: if the folder is already a clone we fast-forward it; if it's
//     a plain folder (the pre-split state) we adopt it in place; auth comes
//     from your normal git credentials — no token needed.
//   - Offline with content already present: we warn and build with what's
//     on disk instead of failing.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const TARGET = "shalagh-quinn-art";
const SLUG = "drorna/shalagh-content";
const BRANCH = "main";
const token = process.env.CONTENT_REPO_TOKEN;
// CONTENT_REPO_URL overrides the source entirely (used for local testing
// against a file:// path, or to point at a mirror). Otherwise we build the
// GitHub URL, injecting a token when one is present (CI).
const override = process.env.CONTENT_REPO_URL;
const safeUrl = override || `https://github.com/${SLUG}.git`;
const url =
  override ||
  (token
    ? `https://x-access-token:${token}@github.com/${SLUG}.git`
    : `https://github.com/${SLUG}.git`);

function git(args, opts = {}) {
  execFileSync("git", args, { stdio: "inherit", ...opts });
}

try {
  if (existsSync(path.join(TARGET, ".git"))) {
    console.log(`[content] updating ${TARGET} from ${safeUrl} …`);
    git(["-C", TARGET, "remote", "set-url", "origin", url]);
    git(["-C", TARGET, "fetch", "--depth=1", "origin", BRANCH]);
    if (token) {
      // CI: take exactly what's on the remote, reproducibly.
      git(["-C", TARGET, "reset", "--hard", `origin/${BRANCH}`]);
    } else {
      // Local: don't clobber uncommitted edits; fast-forward only.
      try {
        git(["-C", TARGET, "merge", "--ff-only", `origin/${BRANCH}`]);
      } catch {
        console.warn("[content] local content has diverged — leaving as-is.");
      }
    }
    // Restore a token-free remote so the token never lingers on disk.
    git(["-C", TARGET, "remote", "set-url", "origin", safeUrl]);
  } else if (existsSync(TARGET)) {
    // Pre-split folder of plain files: adopt it as a clone in place.
    console.log(`[content] adopting existing ${TARGET}/ as a content clone …`);
    git(["-C", TARGET, "init", "-q", "-b", BRANCH]);
    git(["-C", TARGET, "remote", "add", "origin", url]);
    git(["-C", TARGET, "fetch", "--depth=1", "origin", BRANCH]);
    git(["-C", TARGET, "checkout", "-f", "-B", BRANCH, `origin/${BRANCH}`]);
    git(["-C", TARGET, "remote", "set-url", "origin", safeUrl]);
  } else {
    console.log(`[content] cloning ${safeUrl} → ${TARGET}/ …`);
    git(["clone", "--depth=1", "--branch", BRANCH, url, TARGET]);
    git(["-C", TARGET, "remote", "set-url", "origin", safeUrl]);
  }
  console.log("[content] ready.");
} catch (err) {
  if (existsSync(path.join(TARGET, "pages"))) {
    console.warn(
      `[content] could not refresh content (${err.message}). ` +
        "Building with the content already on disk.",
    );
  } else {
    console.error(
      "[content] FATAL: no content on disk and fetch failed. " +
        "Set CONTENT_REPO_TOKEN (CI) or check your git access.",
    );
    process.exit(1);
  }
}
