/**
 * The files each validated step reads, on the valid verdict of `POST /v1/validate`:
 * `tree_files_read`, per step, and `tree_file_readers`, per file.
 *
 * Pinned here: a verdict carrying both views reaches the caller typed, each entry a
 * `TreeFileRead` whose `use` is one of the uses this SDK knows; a verdict from a runner
 * predating the views carries neither, and the types say so by making both optional; and a
 * use a later runner adds reads as its raw string rather than being refused. The type-level
 * assertions bite in `npm run typecheck:test`, which `make check` runs.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import type {
  PipelexValidationReport,
  PipelexValidationResult,
  TreeFileRead,
  TreeFileUse,
} from "../src/index.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A valid verdict as a runner predating the two views answers it. */
const VERDICT_BEFORE_THE_VIEWS = {
  is_valid: true,
  bundle_blueprint: { domain: "invoicing" },
  pipe_io_contracts: {},
  liftable_pipes: [],
  graph_spec: null,
  validated_pipes: [
    { pipe_ref: "invoicing.print_invoice", status: "SUCCESS" },
    { pipe_ref: "invoicing.total", status: "SUCCESS" },
    { pipe_ref: "invoicing.main", status: "SUCCESS" },
  ],
  warnings: [],
  pending_signatures: [],
  is_runnable: true,
  message: "MTHDS content validated successfully",
};

/**
 * The same verdict from a runner reporting the views: a `PipeDocGen` step reading its HTML
 * template and the stylesheet it links, a `PipeFunc` step reading its module, and a controller
 * reading nothing, with the per-file view keyed in sorted order.
 */
const VERDICT_WITH_THE_VIEWS = {
  ...VERDICT_BEFORE_THE_VIEWS,
  tree_files_read: {
    "invoicing.print_invoice": [
      { tree_path: "templates/invoice.html", use: "template" },
      { tree_path: "templates/invoice.css", use: "template_asset" },
    ],
    "invoicing.total": [{ tree_path: "funcs/total.py", use: "python_module" }],
    "invoicing.main": [],
  },
  tree_file_readers: {
    "funcs/total.py": ["invoicing.total"],
    "templates/invoice.css": ["invoicing.print_invoice"],
    "templates/invoice.html": ["invoicing.print_invoice"],
  },
};

async function validateAnswering(body: unknown): Promise<PipelexValidationReport> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));
  const verdict: PipelexValidationResult = await makeClient().validate({
    files: { "invoicing.mthds": "domain = 'invoicing'" },
  });
  if (verdict.is_valid === false) throw new Error("expected a valid verdict");
  return verdict;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelexValidationReport — the files each step reads", () => {
  it("types both views as optional maps of the report's own entries", () => {
    expectTypeOf<PipelexValidationReport["tree_files_read"]>().toEqualTypeOf<
      Record<string, TreeFileRead[]> | undefined
    >();
    expectTypeOf<PipelexValidationReport["tree_file_readers"]>().toEqualTypeOf<
      Record<string, string[]> | undefined
    >();
    expectTypeOf<TreeFileUse>().toEqualTypeOf<"template" | "template_asset" | "python_module">();
    // Read open: a use this SDK knows completes, and one it does not still assigns.
    expectTypeOf<TreeFileRead["use"]>().toEqualTypeOf<TreeFileUse | (string & {})>();
    const later: TreeFileRead = { tree_path: "data/rates.csv", use: "data_table" };
    expect(later.use).toBe("data_table");
  });

  it("reads the per-step and per-file views off a valid verdict that carries them", async () => {
    const report = await validateAnswering(VERDICT_WITH_THE_VIEWS);

    expect(report.tree_files_read).toEqual({
      "invoicing.print_invoice": [
        { tree_path: "templates/invoice.html", use: "template" },
        { tree_path: "templates/invoice.css", use: "template_asset" },
      ],
      "invoicing.total": [{ tree_path: "funcs/total.py", use: "python_module" }],
      "invoicing.main": [],
    });
    // Keyed over the validated pipes, a controller reading nothing included.
    expect(Object.keys(report.tree_files_read ?? {}).sort()).toEqual(
      report.validated_pipes.map((entry) => entry.pipe_ref).sort(),
    );
    const template = report.tree_files_read?.["invoicing.print_invoice"]?.[0];
    expect(template?.use).toBe("template");
    expect(report.tree_file_readers).toEqual({
      "funcs/total.py": ["invoicing.total"],
      "templates/invoice.css": ["invoicing.print_invoice"],
      "templates/invoice.html": ["invoicing.print_invoice"],
    });
    expect(Object.keys(report.tree_file_readers ?? {})).toEqual([
      "funcs/total.py",
      "templates/invoice.css",
      "templates/invoice.html",
    ]);
  });

  it("finds neither view on a verdict from a runner that predates them", async () => {
    const report = await validateAnswering(VERDICT_BEFORE_THE_VIEWS);

    expect(report.is_runnable).toBe(true);
    expect(report.tree_files_read).toBeUndefined();
    expect(report.tree_file_readers).toBeUndefined();
    expect("tree_files_read" in report).toBe(false);
  });

  it("relays a use a later runner adds as its raw string", async () => {
    const report = await validateAnswering({
      ...VERDICT_WITH_THE_VIEWS,
      tree_files_read: {
        ...VERDICT_WITH_THE_VIEWS.tree_files_read,
        "invoicing.total": [{ tree_path: "data/rates.csv", use: "data_table" }],
      },
      tree_file_readers: {
        "data/rates.csv": ["invoicing.total"],
        "templates/invoice.css": ["invoicing.print_invoice"],
        "templates/invoice.html": ["invoicing.print_invoice"],
      },
    });

    expect(report.tree_files_read?.["invoicing.total"]).toEqual([
      { tree_path: "data/rates.csv", use: "data_table" },
    ]);
  });
});
