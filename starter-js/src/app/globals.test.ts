import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

/**
 * The stylesheet is the one artifact in this repo whose failures are silent.
 * `tsc` never reads a `.css`, ESLint has no CSS processor, and Prettier only
 * reformats — so every hazard `globals.css` documents in prose (the
 * `hsl(hsl(…))` trap, the purged `@source`, a token dropped from the mirror)
 * ships through a green `make all`. Under Tailwind 3 the token mirror at least
 * lived in a typechecked `tailwind.config.ts`; in v4 it is CSS, and nothing
 * checks CSS but this file.
 *
 * These assertions read the emitted **declarations**, never class-name
 * substrings. That distinction is the point: v4 scans the whole repo including
 * Markdown, so this repo's own docs — which quote `field-sizing-content`,
 * `outline-hidden` and friends while explaining them — mint those very classes
 * into the bundle. A check that greps for a class name therefore passes whether
 * or not the kernel's bundle was scanned at all.
 */

const ENTRY = path.resolve(process.cwd(), "src/app/globals.css");
const SOURCE = fs.readFileSync(ENTRY, "utf8");

/** Compile exactly as the app does — same plugin, same entry path, so v4's
 *  automatic source detection resolves from the same directory. */
async function build(css: string): Promise<string> {
  const result = await postcss([tailwind()]).process(css, { from: ENTRY });
  return result.css;
}

/** The stylesheet with its `@source` directives removed — what a consumer who
 *  drops the line, or a future edit that loses it, would actually ship. */
function withoutSource(css: string): string {
  return css
    .split("\n")
    .filter((line) => !line.startsWith("@source"))
    .join("\n");
}

/** Every selector the build emits, so two builds can be compared as sets. */
function selectors(css: string): Set<string> {
  const matches = css.match(/^\s*([.:[][^{\n]*)\{/gm) ?? [];
  return new Set(matches.map((m) => m.trim().replace(/\s*\{$/, "")));
}

describe("globals.css", () => {
  it("maps every shadcn token as a bare var(), never re-wrapped in hsl()", async () => {
    const css = await build(SOURCE);

    // Since @pipelex/mthds-form 0.8.0 each token holds a whole colour, so the
    // v3-era `hsl(var(--border))` wrapper would emit `hsl(hsl(…))` — not a
    // colour. The browser discards the declaration and the element goes
    // transparent, with nothing logged and the build still green.
    expect(css).not.toMatch(/hsl\(\s*var\(--/);
    expect(css).toMatch(/\.border-border\s*\{\s*border-color:\s*var\(--border\)/);
    expect(css).toMatch(/\.bg-card\s*\{\s*background-color:\s*var\(--card\)/);
  });

  it("emits a utility for every semantic token the kernel's controls use", async () => {
    const css = await build(SOURCE);

    // The `@theme inline` block mirrors the kernel's own token contract. A
    // token dropped from it is not an error — it is a class Tailwind simply
    // does not know, so the control renders unstyled in that one respect.
    const required: ReadonlyArray<[string, string]> = [
      ["border-border", "border-color"],
      ["border-input", "border-color"],
      ["border-destructive", "border-color"],
      ["bg-background", "background-color"],
      ["bg-card", "background-color"],
      ["bg-input", "background-color"],
      ["bg-muted", "background-color"],
      ["bg-popover", "background-color"],
      ["bg-primary", "background-color"],
      ["bg-accent", "background-color"],
      ["text-foreground", "color"],
      ["text-muted-foreground", "color"],
      ["text-popover-foreground", "color"],
      ["text-accent-foreground", "color"],
      ["text-destructive", "color"],
      ["text-primary", "color"],
    ];
    const missing = required.filter(
      ([cls, prop]) => !new RegExp(`\\.${cls}\\s*\\{\\s*${prop}:`).test(css),
    );
    expect(missing.map(([cls]) => cls)).toEqual([]);

    // The radius half of the mirror, which the retired config carried under a
    // separate `theme.extend.borderRadius` key.
    expect(css).toMatch(/\.rounded-md\s*\{\s*border-radius:\s*calc\(var\(--radius\)/);
    expect(css).toMatch(/\.rounded-lg\s*\{\s*border-radius:\s*var\(--radius\)/);
  });

  it("scans the form kernel's bundle, which only the @source directive reaches", async () => {
    const [withSource, withoutIt] = await Promise.all([
      build(SOURCE),
      build(withoutSource(SOURCE)),
    ]);

    const before = selectors(withoutIt);
    const gained = [...selectors(withSource)].filter((s) => !before.has(s));

    // Losing `@source` purges the controls' own utilities and nothing else —
    // the form still renders, which is why this fails silently in a browser.
    //
    // The assertion is the SIZE of the gained set, deliberately, and not the
    // presence of any particular class. Naming classes does not work here: v4
    // scans Markdown, so every class name this repo's docs quote while
    // explaining it is minted into both builds — `field-sizing-content` and
    // even the `(--radix-…)` variable form among them, which is why the
    // stylesheet-diff check in `docs/input-form.md` compares sizes rather than
    // grepping for names. Prose can mint a handful of classes; it cannot mint
    // the kernel's whole control set.
    expect(gained.length).toBeGreaterThan(100);
    expect(withSource.length).toBeGreaterThan(withoutIt.length * 1.5);

    // A smoke check that what arrives is in fact the controls' own vocabulary.
    expect(withSource).toMatch(/--radix-select-content-available-height/);
    expect(withSource).toMatch(/field-sizing:\s*content/);
  });

  it("keeps the animation utilities the kernel's popovers depend on", async () => {
    const css = await build(SOURCE);

    // These come from `@import "tw-animate-css"`, which replaced the v3
    // `tailwindcss-animate` plugin. Dropping the import costs the select
    // popover and the tooltip their enter/exit transitions, nothing louder.
    for (const cls of ["animate-in", "animate-out", "fade-in-0", "zoom-in-95"]) {
      expect(css).toContain(cls);
    }
  });
});
