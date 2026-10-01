// @vitest-environment node
//
// Pins `make create`, in two layers, the way `add-method.test.mts` pins
// `add-method`.
//
// The pure helpers are tabled: each turns the method's own report, or the
// shell, into a value the bootstrap or the env file will carry. The
// orchestration runs over a temporary copy of the template with a recorded
// client and a fake command runner, and what it pins is the order: every
// refusal before anything is written, the bootstrap validating its values
// before the method is scaffolded, and the bootstrap skill removed only once
// `make all` is green.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelexApiClient } from "@pipelex/sdk";

import type { AddMethodPlan } from "./add-method.mts";
import {
  appUrl,
  BOOTSTRAP_DIR,
  bootstrapArgs,
  deriveIdentity,
  dropEnvLine,
  ENV_FILE,
  oneLine,
  parseCreateArgs,
  devServerReads,
  planEnvFile,
  renderEnvFile,
  runCreate,
  setEnvLine,
  titleFromName,
  type CreateDeps,
} from "./create.mts";
import { REPO_ROOT } from "./shared.mts";
import RECEIPT_REVIEW_CODEGEN from "./fixtures/recorded/receipt-review.codegen.json" with { type: "json" };
import RECEIPT_REVIEW_VALIDATE from "./fixtures/recorded/receipt-review.validate.json" with { type: "json" };
import TEXT_STATS_CODEGEN from "./fixtures/recorded/text-stats.codegen.json" with { type: "json" };
import TEXT_STATS_VALIDATE from "./fixtures/recorded/text-stats.validate.json" with { type: "json" };

const RECEIPTS_DIR = path.join(
  REPO_ROOT,
  "scripts",
  "lib",
  "fixtures",
  "bundles",
  "receipt-review",
);
const TEXT_STATS_REF = "github.com/Pipelex/methods/text_stats@v0.1.1";
const STORED_ID = "mt_00000000-0000-0000-0000-000000000000";

// ── The command line ────────────────────────────────────────────────────────

describe("parseCreateArgs", () => {
  it("takes the method positionally and every value flag", () => {
    expect(
      parseCreateArgs([
        TEXT_STATS_REF,
        "--name",
        "word-counter",
        "--title",
        "Word Counter",
        "--method-name",
        "counts",
        "--license",
        "proprietary",
        "--dry-run",
      ]),
    ).toEqual({
      method: TEXT_STATS_REF,
      name: "word-counter",
      title: "Word Counter",
      methodName: "counts",
      license: "proprietary",
      dryRun: true,
    });
  });

  it("reads a blank value as not given — `TITLE=` clears, it does not blank the title", () => {
    expect(parseCreateArgs([TEXT_STATS_REF, "--title", "  "])).toEqual({
      method: TEXT_STATS_REF,
      dryRun: false,
    });
  });

  it.each([
    [[], /no method given/],
    [[TEXT_STATS_REF, "--title", "--dry-run"], /missing value for --title/],
    [[TEXT_STATS_REF, "--force"], /unknown argument/],
    [[TEXT_STATS_REF, STORED_ID], /second method/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseCreateArgs(argv)).toThrow(message);
  });
});

// ── The identity ────────────────────────────────────────────────────────────

/** Just the fields `deriveIdentity` reads. */
function planOf(overrides: {
  slug?: string;
  catalog?: { name: string; description: string | null } | null;
  description?: string | null;
  pipeDescriptions?: Record<string, string>;
}): AddMethodPlan {
  return {
    names: { slug: overrides.slug ?? "receipt-review" },
    catalog: overrides.catalog ?? null,
    scaffold: { pipe: { ref: "receipt_review.review_receipts" } },
    fetched: {
      contracts: {
        prose: {
          description: overrides.description ?? null,
          pipeDescriptions: overrides.pipeDescriptions ?? {},
        },
      },
    },
  } as unknown as AddMethodPlan;
}

describe("deriveIdentity", () => {
  const NONE = { method: "x", dryRun: false };

  it("keeps an acronym's capitals in a derived title, where the method spells them", () => {
    // Word-by-word title case made the `cv_screening` domain "Cv Screening".
    expect(
      deriveIdentity(
        planOf({ slug: "cv-screening", description: "Score a batch of CVs against a scorecard." }),
        NONE,
      ).title,
    ).toBe("CV Screening");
  });

  it("leaves a title somebody chose exactly as they wrote it", () => {
    expect(
      deriveIdentity(planOf({ slug: "cv-screening", description: "A batch of CVs." }), {
        ...NONE,
        title: "cv screening",
      }).title,
    ).toBe("cv screening");
  });

  it("names a bundle's app after its slug, and describes it with the domain's description", () => {
    expect(deriveIdentity(planOf({ description: "Read receipts." }), NONE)).toEqual({
      name: "receipt-review",
      title: "Receipt Review",
      description: "Read receipts.",
    });
  });

  it("titles a stored method with its catalog name and describes it with the catalog's", () => {
    const plan = planOf({
      slug: "cv-screening",
      catalog: { name: "CV screening", description: "Screen CVs." },
      description: "The bundle's own words.",
    });
    expect(deriveIdentity(plan, NONE)).toEqual({
      name: "cv-screening",
      title: "CV screening",
      description: "Screen CVs.",
    });
  });

  it("falls back to the chosen pipe's description, then to a sentence naming the method", () => {
    expect(
      deriveIdentity(
        planOf({ pipeDescriptions: { "receipt_review.review_receipts": "Summarize each." } }),
        NONE,
      ).description,
    ).toBe("Summarize each.");
    expect(deriveIdentity(planOf({}), NONE).description).toBe(
      "Runs the Receipt Review method through the Pipelex API.",
    );
  });

  it("reads a blank catalog name or description as not given", () => {
    const plan = planOf({
      catalog: { name: "  ", description: "" },
      description: "Read receipts.",
    });
    expect(deriveIdentity(plan, NONE)).toEqual({
      name: "receipt-review",
      title: "Receipt Review",
      description: "Read receipts.",
    });
    expect(
      deriveIdentity(
        planOf({
          catalog: { name: "", description: " " },
          pipeDescriptions: { "receipt_review.review_receipts": "Summarize each." },
        }),
        NONE,
      ).description,
    ).toBe("Summarize each.");
  });

  it("lets every value be overridden, and titles an overridden name after it", () => {
    expect(
      deriveIdentity(planOf({ description: "Read receipts." }), {
        ...NONE,
        name: "@acme/expense-desk",
        description: "Expenses,\n  checked.",
      }),
    ).toEqual({
      name: "@acme/expense-desk",
      title: "Expense Desk",
      description: "Expenses, checked.",
    });
  });

  it("keeps a description on one line", () => {
    expect(oneLine("  Read\n\treceipts,\r\n  fast. ")).toBe("Read receipts, fast.");
    expect(titleFromName("my_cool.app")).toBe("My Cool App");
  });
});

// ── The env file ────────────────────────────────────────────────────────────

describe("the env file", () => {
  const EXAMPLE = [
    "# Pipelex API endpoint and credentials.",
    "PIPELEX_BASE_URL=https://api.pipelex.com",
    "PIPELEX_API_KEY=",
    "",
    "NEXT_PUBLIC_EXECUTION_MODE=durable",
    "",
  ].join("\n");

  const DEV = "https://api-dev.pipelex.com";

  it("copies the shell's base URL and key over the example's lines, in place", () => {
    expect(renderEnvFile(EXAMPLE, { baseUrl: DEV, key: "sk-1" })).toBe(
      [
        "# Pipelex API endpoint and credentials.",
        "PIPELEX_BASE_URL=https://api-dev.pipelex.com",
        "PIPELEX_API_KEY=sk-1",
        "",
        "NEXT_PUBLIC_EXECUTION_MODE=durable",
        "",
      ].join("\n"),
    );
  });

  it("leaves the key empty when nothing supplied one", () => {
    expect(renderEnvFile(EXAMPLE, { baseUrl: "https://api.pipelex.com" })).toBe(EXAMPLE);
  });

  it("leaves out a key another env file supplies, so this one does not hide it", () => {
    const written = renderEnvFile(EXAMPLE, { baseUrl: DEV, keyFile: ".env" });
    expect(written).toBe(
      [
        "# Pipelex API endpoint and credentials.",
        `PIPELEX_BASE_URL=${DEV}`,
        "# PIPELEX_API_KEY is read from .env; a line here would override it.",
        "",
        "NEXT_PUBLIC_EXECUTION_MODE=durable",
        "",
      ].join("\n"),
    );
    expect(written).not.toMatch(/^\s*(export\s+)?PIPELEX_API_KEY\s*=/m);
    expect(dropEnvLine("A=1\nexport A=2\nB=3\n", "A", "gone")).toBe("# gone\nB=3\n");
  });

  it("does not claim the dev server reads a key only a production build reads", async () => {
    expect(devServerReads(".env")).toBe(true);
    expect(devServerReads(".env.development.local")).toBe(true);
    expect(devServerReads(".env.production")).toBe(false);
    expect(devServerReads(".env.production.local")).toBe(false);

    const written = renderEnvFile(EXAMPLE, { baseUrl: DEV, keyFile: ".env.production.local" });
    expect(written).not.toMatch(/^\s*(export\s+)?PIPELEX_API_KEY\s*=/m);
    expect(written).toContain(
      "# PIPELEX_API_KEY is read from .env.production.local by a production build only — " +
        "put it in .env or .env.development.local before `make dev`.",
    );

    const root = await mkdtemp(path.join(tmpdir(), "create-env-"));
    try {
      const plan = await planEnvFile(root, {}, DEV, { key: ".env.production.local" });
      const notes = plan.notes.join("\n");
      expect(notes).toContain("which only a production build reads");
      expect(notes).not.toContain("which a line here would hide");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes exactly one base URL line, whatever the example held", () => {
    const doubled = `${EXAMPLE}export PIPELEX_BASE_URL=https://elsewhere.example\n`;
    const written = renderEnvFile(doubled, { baseUrl: DEV });
    expect(written.match(/PIPELEX_BASE_URL=/g)).toHaveLength(1);
    expect(written).toContain(`PIPELEX_BASE_URL=${DEV}\n`);

    const none = renderEnvFile("# nothing\n", { baseUrl: DEV });
    expect(none.match(/PIPELEX_BASE_URL=/g)).toHaveLength(1);
    expect(renderEnvFile(null, { baseUrl: DEV })).toContain(`PIPELEX_BASE_URL=${DEV}\n`);
  });

  it("says where each value it writes came from", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "create-env-"));
    try {
      const fromFiles = await planEnvFile(root, {}, DEV, { baseUrl: ".env", key: ".env" });
      expect(fromFiles.action).toBe("write");
      expect(fromFiles.notes.join("\n")).toContain(`PIPELEX_BASE_URL=${DEV} (from .env)`);
      expect(fromFiles.notes.join("\n")).toContain("the key stays in .env");

      const fromShell = await planEnvFile(root, { baseUrl: DEV, key: "sk-1" }, DEV, {});
      expect(fromShell.notes.join("\n")).toContain("(from your shell), and PIPELEX_API_KEY from");
      if (fromShell.action !== "write") throw new Error("expected a write");
      expect(fromShell.content).toContain("PIPELEX_API_KEY=sk-1\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a value an env file cannot hold", () => {
    expect(() => setEnvLine(EXAMPLE, "PIPELEX_API_KEY", "a\nb")).toThrow(/line break/);
  });
});

// ── Where the app listens ───────────────────────────────────────────────────

describe("appUrl", () => {
  it.each([
    [{}, "http://127.0.0.1:4300"],
    [{ APP_HOST: "", APP_PORT: " " }, "http://127.0.0.1:4300"],
    [{ APP_PORT: "4301" }, "http://127.0.0.1:4301"],
    [{ APP_HOST: "localhost" }, "http://localhost:4300"],
    [{ APP_HOST: "0.0.0.0" }, "http://127.0.0.1:4300"],
    [{ APP_HOST: "::" }, "http://127.0.0.1:4300"],
    [{ APP_HOST: "::1" }, "http://[::1]:4300"],
    [{ APP_HOST: "192.168.1.20" }, "http://192.168.1.20:4300"],
  ])("reads %j as %s", (env, url) => {
    expect(appUrl(env)).toBe(url);
  });
});

// ── The bootstrap's command line ────────────────────────────────────────────

describe("bootstrapArgs", () => {
  it("passes the identity, --clean, and only the pass-through flags that were given", () => {
    const argv = bootstrapArgs(
      "/app",
      { name: "receipt-review", title: "Receipt Review", description: "Read receipts." },
      { method: "x", authorName: "Ada", license: "proprietary", dryRun: false },
    );
    expect(argv.slice(1)).toEqual([
      "--root",
      "/app",
      "--name",
      "receipt-review",
      "--title",
      "Receipt Review",
      "--description",
      "Read receipts.",
      "--clean",
      "--author-name",
      "Ada",
      "--license",
      "proprietary",
    ]);
    expect(argv[0]).toBe(path.join("/app", ".claude/skills/bootstrap/scripts/bootstrap.mjs"));
  });
});

// ── The orchestration ───────────────────────────────────────────────────────

describe("runCreate", () => {
  let root: string;
  let output: string[];

  /**
   * What the copy of the template leaves behind. This file runs only in the
   * template — the bootstrap removes it, with the gesture, from every project —
   * so the copy is the template as shipped.
   */
  const NOT_COPIED = new Set([".git", "node_modules", ".next", ".env", ".env.local"]);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "create-"));
    await cp(REPO_ROOT, root, {
      recursive: true,
      filter: (source) => !NOT_COPIED.has(path.relative(REPO_ROOT, source).split(path.sep)[0]!),
    });

    output = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void output.push(String(line)));
    vi.spyOn(console, "error").mockImplementation(
      (line: unknown) => void output.push(String(line)),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function client() {
    return {
      version: vi.fn().mockResolvedValue({ extensions: ["runs", "method_id", "method_ref"] }),
      getMethod: vi
        .fn()
        .mockResolvedValue({ name: "Word statistics", description: "Counts words." }),
      codegen: vi.fn(async (request: { files?: unknown }) =>
        request.files === undefined ? TEXT_STATS_CODEGEN : RECEIPT_REVIEW_CODEGEN,
      ),
      validate: vi.fn().mockResolvedValue(TEXT_STATS_VALIDATE),
      validateFiles: vi.fn().mockResolvedValue(RECEIPT_REVIEW_VALIDATE),
    } as unknown as Pick<
      PipelexApiClient,
      "codegen" | "validate" | "validateFiles" | "version" | "getMethod"
    > & { codegen: ReturnType<typeof vi.fn> };
  }

  interface Call {
    command: string;
    args: readonly string[];
    /** Whether the method's slice was already on disk when the command ran. */
    sliceWritten: boolean;
  }

  /**
   * A command runner that records each call and answers with a status. The
   * bootstrap is not run for real — its own tests do that — so its effect on
   * `package.json` is imitated, which is what `make create` refuses to repeat.
   */
  function deps(
    statuses: { bootstrap?: number; dryRun?: number; npm?: number; make?: number } = {},
    shell: CreateDeps["shell"] = { baseUrl: "https://api-dev.pipelex.com", key: "sk-test" },
  ): CreateDeps & { calls: Call[] } {
    const calls: Call[] = [];
    const apiClient = client();
    return {
      calls,
      repoRoot: root,
      shell,
      // A real run's base URL is the shell's when the shell sets one.
      addMethod: {
        repoRoot: root,
        cwd: root,
        client: apiClient,
        baseUrl: shell.baseUrl ?? "https://api.example",
      },
      npm: { command: "npm", args: [] },
      run: (command, args) => {
        calls.push({
          command,
          args,
          sliceWritten: existsSync(path.join(root, "src/components/ReceiptReviewForm.tsx")),
        });
        const isBootstrap = args[0]?.endsWith("bootstrap.mjs") ?? false;
        if (isBootstrap && args.includes("--dry-run")) return statuses.dryRun ?? 0;
        if (isBootstrap) return statuses.bootstrap ?? 0;
        if (command === "npm") return statuses.npm ?? 0;
        return statuses.make ?? 0;
      },
    };
  }

  const kinds = (calls: Call[]): string[] =>
    calls.map((call) =>
      call.args[0]?.endsWith("bootstrap.mjs")
        ? call.args.includes("--dry-run")
          ? "bootstrap --dry-run"
          : "bootstrap"
        : [call.command, ...call.args].join(" "),
    );

  it("scaffolds, bootstraps, writes the env file, checks, and removes the bootstrap — in that order", async () => {
    const d = deps();
    expect(await runCreate([RECEIPTS_DIR], d)).toBe(0);

    expect(kinds(d.calls)).toEqual([
      "bootstrap --dry-run",
      "bootstrap",
      "npm install --package-lock-only",
      "make all",
    ]);
    // The values are checked before anything is written, and the slice is in
    // place before the project is named after it.
    expect(d.calls[0]!.sliceWritten).toBe(false);
    expect(d.calls[1]!.sliceWritten).toBe(true);
    expect(d.calls[1]!.args).toEqual(
      expect.arrayContaining(["--name", "receipt-review", "--title", "Receipt Review"]),
    );
    expect(d.calls[1]!.args).toContain(
      "Read a batch of receipts and list, for each one, who issued it, when, and the total paid.",
    );

    const env = await readFile(path.join(root, ENV_FILE), "utf-8");
    expect(env).toContain("PIPELEX_BASE_URL=https://api-dev.pipelex.com\n");
    expect(env).toContain("PIPELEX_API_KEY=sk-test\n");
    expect(env.match(/PIPELEX_BASE_URL=/g)).toHaveLength(1);

    expect(existsSync(path.join(root, BOOTSTRAP_DIR))).toBe(false);
    expect(existsSync(path.join(root, "methods/receipt-review/main.mthds"))).toBe(true);
    expect(output.join("\n")).toContain("create: done");
  });

  it("names a stored method's app after its catalog entry", async () => {
    const d = deps();
    expect(await runCreate([STORED_ID], d)).toBe(0);

    const bootstrap = d.calls[1]!.args;
    expect(bootstrap).toEqual(
      expect.arrayContaining([
        "--name",
        "word-statistics",
        "--title",
        "Word statistics",
        "--description",
        "Counts words.",
      ]),
    );
  });

  it("--dry-run checks the values and writes nothing", async () => {
    const d = deps();
    expect(await runCreate([RECEIPTS_DIR, "--dry-run"], d)).toBe(0);

    expect(kinds(d.calls)).toEqual(["bootstrap --dry-run"]);
    expect(existsSync(path.join(root, "methods/receipt-review"))).toBe(false);
    expect(existsSync(path.join(root, ENV_FILE))).toBe(false);
    expect(output.join("\n")).toContain("Nothing was written (--dry-run).");
  });

  it("stops before writing anything when the bootstrap refuses a value", async () => {
    const d = deps({ dryRun: 1 });
    expect(await runCreate([RECEIPTS_DIR, "--name", "Not A Package"], d)).toBe(1);

    expect(kinds(d.calls)).toEqual(["bootstrap --dry-run"]);
    expect(existsSync(path.join(root, "methods/receipt-review"))).toBe(false);
    expect(output.join("\n")).toContain("Nothing was written");
  });

  it("refuses a checkout that is no longer the template, before any fetch", async () => {
    const pkgPath = path.join(root, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as Record<string, unknown>;
    await writeFile(pkgPath, JSON.stringify({ ...pkg, name: "receipt-review" }), "utf-8");
    const d = deps();

    expect(await runCreate([RECEIPTS_DIR], d)).toBe(1);

    expect(d.calls).toEqual([]);
    expect(output.join("\n")).toContain("make add-method");
  });

  it("names --method-name when no directory name can be derived", async () => {
    const d = deps();
    expect(await runCreate([RECEIPTS_DIR, "--method-name", "3d"], d)).toBe(1);
    expect(output.join("\n")).toContain("--method-name");
    expect(d.calls).toEqual([]);
  });

  it("leaves an existing env file alone, and says when it disagrees with the shell", async () => {
    await writeFile(path.join(root, ENV_FILE), "PIPELEX_BASE_URL=https://api.pipelex.com\n");
    expect(await runCreate([RECEIPTS_DIR], deps())).toBe(0);

    expect(await readFile(path.join(root, ENV_FILE), "utf-8")).toBe(
      "PIPELEX_BASE_URL=https://api.pipelex.com\n",
    );
    expect(output.join("\n")).toContain("but .env.local says https://api.pipelex.com");
  });

  it("writes no key the shell did not set, and the base URL the gesture ran against", async () => {
    expect(await runCreate([RECEIPTS_DIR], deps({}, {}))).toBe(0);

    const env = await readFile(path.join(root, ENV_FILE), "utf-8");
    expect(env).toContain("PIPELEX_API_KEY=\n");
    expect(env).toContain("PIPELEX_BASE_URL=https://api.example\n");
  });

  it("does not hide a key and base URL that came from .env", async () => {
    const d = { ...deps({}, {}), envFiles: { baseUrl: ".env", key: ".env" } };
    expect(await runCreate([RECEIPTS_DIR], d)).toBe(0);

    const env = await readFile(path.join(root, ENV_FILE), "utf-8");
    expect(env).not.toMatch(/^\s*(export\s+)?PIPELEX_API_KEY\s*=/m);
    expect(env).toContain("PIPELEX_BASE_URL=https://api.example\n");
    expect(output.join("\n")).toContain("the key stays in .env");
  });

  it("keeps the bootstrap and names what is left when make all is red", async () => {
    const d = deps({ make: 2 });
    expect(await runCreate([RECEIPTS_DIR], d)).toBe(1);

    expect(existsSync(path.join(root, BOOTSTRAP_DIR))).toBe(true);
    const printed = output.join("\n");
    expect(printed).toContain("make all is red");
    expect(printed).toContain(`rm -rf ${BOOTSTRAP_DIR}`);
    expect(printed).not.toContain("npm install --package-lock-only\n  make all");
  });
});
