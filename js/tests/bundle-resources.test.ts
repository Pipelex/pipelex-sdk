/**
 * The files a bundle's steps read — the request's `resources` — on every route that loads a
 * bundle sent as content: `validate`, `validateFiles`, `execute`, `start` and its blocking
 * fallback, `pipeIo` (and through it `prepareInputs`), `resolve` and `codegen`.
 *
 * Pinned here: the caller's bytes reach the wire as standard padded base64 under the key the
 * caller gave, whatever byte form they came in; nothing is sent when there is nothing to send;
 * the SDK refuses before any request what the runner refuses for certain (a key that cannot
 * name a file inside the bundle, two keys for one file, a value that is not bytes, the run
 * routes' and validate's pairings); the runner's own refusals surface as `ApiResponseError`
 * with their `errorType`; and a template check's warning reaches the caller with its locators.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  InputPreparationError,
  RequestArgumentError,
} from "../src/errors.js";
import type { BundleResources } from "../src/index.js";

const BASE_URL = "http://localhost:8081";

const TEMPLATE_PATH = "templates/invoice.docx";
/** Not UTF-8, so a text round trip would corrupt it: the bytes must travel as base64. */
const TEMPLATE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]);
const TEMPLATE_B64 = Buffer.from(TEMPLATE_BYTES).toString("base64");

/** A bundle whose one step fills a Word template, as the runner's own route tests write it. */
const INVOICE_MTHDS = `domain = "invoicing"
main_pipe = "print_invoice"

[concept.InvoiceFile]
description = "The invoice as a file"
refines     = "Document"

[pipe.print_invoice]
type          = "PipeDocGen"
description   = "Print the invoice in Word"
inputs        = { invoice = "Text" }
output        = "InvoiceFile"
format        = "docx"
template_file = "${TEMPLATE_PATH}"
`;

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The problem document the runner renders for a refusal of the request's `resources`. */
function problemResponse(status: number, errorType: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.pipelex.com/latest/errors/${errorType}/`,
      title: errorType,
      status,
      detail,
      error_type: errorType,
      error_domain: "input",
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

function bodyOf(fetchSpy: ReturnType<typeof vi.spyOn>, call = 0): Record<string, unknown> {
  const init = fetchSpy.mock.calls[call]![1] as { body?: string };
  return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
}

function startAck(): Response {
  return jsonResponse(202, { pipeline_run_id: "run-t", state: "STARTED", created_at: "t0" });
}

function completedRun(): Response {
  return jsonResponse(200, {
    pipeline_run_id: "run-t",
    pipe_output: { pipeline_run_id: "run-t", working_memory: { root: {}, aliases: {} } },
  });
}

/** A completed blocking run that delivers its main stuff, as `startAndWaitForResult` reads it. */
function completedRunWithResult(): Response {
  return jsonResponse(200, {
    pipeline_run_id: "run-t",
    created_at: "t0",
    state: "COMPLETED",
    main_stuff_name: "invoice_file",
    pipe_output: {
      pipeline_run_id: "run-t",
      working_memory: {
        root: { invoice_file: { concept: "native.Text", content: { text: "printed" } } },
        aliases: { main_stuff: "invoice_file" },
      },
    },
  });
}

const VALID_VERDICT = {
  is_valid: true,
  bundle_blueprint: {},
  pipe_io_contracts: {},
  liftable_pipes: [],
  graph_spec: null,
  validated_pipes: [],
  warnings: [],
  pending_signatures: [],
  is_runnable: true,
  message: "MTHDS content validated successfully",
};

const PIPE_IO_INVALID = {
  is_valid: false,
  validation_errors: [{ category: "pipe_factory", message: "not supplied" }],
  message: "MTHDS library could not be resolved",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the bytes reach the wire as base64 under the caller's key", () => {
  it("encodes a Uint8Array, a Buffer, an ArrayBuffer and a Blob alike", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startAck());
    await client.start({
      mthds_contents: [INVOICE_MTHDS],
      resources: {
        "a.docx": TEMPLATE_BYTES,
        "b.docx": Buffer.from(TEMPLATE_BYTES),
        "c.docx": TEMPLATE_BYTES.slice().buffer,
        "d.docx": new Blob([TEMPLATE_BYTES]),
      },
    });
    expect(bodyOf(fetchSpy).resources).toEqual({
      "a.docx": TEMPLATE_B64,
      "b.docx": TEMPLATE_B64,
      "c.docx": TEMPLATE_B64,
      "d.docx": TEMPLATE_B64,
    });
  });

  it("encodes a view's own bytes, not the buffer behind it", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startAck());
    // The template sits in the middle of a larger buffer, as a file read into a pool does.
    const padded = new Uint8Array([0x41, 0x42, ...TEMPLATE_BYTES, 0x43]);
    const view = new Uint8Array(padded.buffer, 2, TEMPLATE_BYTES.length);
    expect(view.byteOffset).toBe(2);
    await client.start({
      mthds_contents: [INVOICE_MTHDS],
      resources: { "a.docx": view, "b.docx": Buffer.from(padded).subarray(2, -1) },
    });
    expect(bodyOf(fetchSpy).resources).toEqual({ "a.docx": TEMPLATE_B64, "b.docx": TEMPLATE_B64 });
  });

  it("sends the key as given, the runner collapsing `./` itself", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startAck());
    await client.start({
      mthds_contents: [INVOICE_MTHDS],
      resources: { [`./${TEMPLATE_PATH}`]: TEMPLATE_BYTES },
    });
    expect(bodyOf(fetchSpy).resources).toEqual({ [`./${TEMPLATE_PATH}`]: TEMPLATE_B64 });
  });

  it("sends them beside mthds_contents on execute and start", async () => {
    const client = makeClient();
    const onExecute = vi.spyOn(globalThis, "fetch").mockResolvedValue(completedRun());
    await client.execute({
      mthds_contents: [INVOICE_MTHDS],
      inputs: { invoice: "INV-1" },
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
    });
    expect(bodyOf(onExecute)).toEqual({
      mthds_contents: [INVOICE_MTHDS],
      inputs: { invoice: "INV-1" },
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });

    vi.restoreAllMocks();
    const onStart = vi.spyOn(globalThis, "fetch").mockResolvedValue(startAck());
    await client.start({
      mthds_contents: [INVOICE_MTHDS],
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
    });
    expect(bodyOf(onStart)).toEqual({
      mthds_contents: [INVOICE_MTHDS],
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });
  });

  it("sends them beside a method bundle, and beside a hosted method_id alone", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(startAck()));
    await client.start({
      files: { "invoice.mthds": INVOICE_MTHDS },
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
    });
    expect(bodyOf(fetchSpy).resources).toEqual({ [TEMPLATE_PATH]: TEMPLATE_B64 });

    // The platform resolves the id into the bundle the runner reads the files with.
    await client.start({ method_id: "mt_1", resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES } });
    expect(bodyOf(fetchSpy, 1)).toEqual({
      method_id: "mt_1",
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });
  });

  it("keeps them on startAndWaitForResult's blocking fallback", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { implementation: "pipelex-api" }))
      .mockResolvedValue(completedRun());
    await client
      .startAndWaitForResult({
        mthds_contents: [INVOICE_MTHDS],
        resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
      })
      .catch(() => undefined);
    expect(String(fetchSpy.mock.calls[1]![0])).toBe(`${BASE_URL}/v1/execute`);
    expect(bodyOf(fetchSpy, 1).resources).toEqual({ [TEMPLATE_PATH]: TEMPLATE_B64 });
  });

  it("keeps them when a runner that looked hosted has no start route and the call falls back", async () => {
    const client = makeClient();
    // The version handshake names no implementation, so the runner looks hosted; its `start`
    // answers the missing-route 404 (`RunLifecycleUnavailableError`, no run created), and the
    // call falls back to the blocking `execute`, which must carry the same files.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { protocol_version: "1" }))
      .mockResolvedValueOnce(jsonResponse(404, { detail: "Not Found" }))
      .mockResolvedValueOnce(completedRunWithResult());
    const result = await client.startAndWaitForResult({
      mthds_contents: [INVOICE_MTHDS],
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
    });
    expect(result.pipeline_run_id).toBe("run-t");
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      `${BASE_URL}/v1/version`,
      `${BASE_URL}/v1/start`,
      `${BASE_URL}/v1/execute`,
    ]);
    expect(bodyOf(fetchSpy, 1).resources).toEqual({ [TEMPLATE_PATH]: TEMPLATE_B64 });
    expect(bodyOf(fetchSpy, 2).resources).toEqual({ [TEMPLATE_PATH]: TEMPLATE_B64 });
  });

  it("sends them beside inline contents on validate and validateFiles", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, VALID_VERDICT));
    await client.validate([INVOICE_MTHDS], true, ["invoice.mthds"], undefined, undefined, {
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
    });
    expect(bodyOf(fetchSpy)).toEqual({
      allow_signatures: true,
      mthds_contents: [INVOICE_MTHDS],
      mthds_sources: ["invoice.mthds"],
      render: ["markdown"],
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });

    fetchSpy.mockResolvedValue(jsonResponse(200, VALID_VERDICT));
    await client.validateFiles([{ content: INVOICE_MTHDS, uri: "invoice.mthds" }], {
      resources: { [TEMPLATE_PATH]: new Blob([TEMPLATE_BYTES]) },
    });
    expect(bodyOf(fetchSpy, 1).resources).toEqual({ [TEMPLATE_PATH]: TEMPLATE_B64 });
  });

  it("sends them beside a hosted method_id on validate", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, VALID_VERDICT));
    await client.validate({ method_id: "mt_1" }, false, undefined, undefined, undefined, {
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
    });
    expect(bodyOf(fetchSpy)).toMatchObject({
      method_id: "mt_1",
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });
  });

  it("encodes them on the crate routes, posting the rest of the request as given", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, PIPE_IO_INVALID)));
    const files = [{ content: INVOICE_MTHDS, source: "invoice.mthds" }];
    const resources = { [TEMPLATE_PATH]: TEMPLATE_BYTES };

    await client.pipeIo({ files, resources, pipe_ref: "invoicing.print_invoice" });
    await client.resolve({ files, resources });
    await client.codegen({ files, resources, kind: "types", target: "ts-zod" });

    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      `${BASE_URL}/v1/pipe-io`,
      `${BASE_URL}/v1/resolve`,
      `${BASE_URL}/v1/codegen`,
    ]);
    expect(bodyOf(fetchSpy, 0)).toEqual({
      files,
      pipe_ref: "invoicing.print_invoice",
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });
    expect(bodyOf(fetchSpy, 1)).toEqual({ files, resources: { [TEMPLATE_PATH]: TEMPLATE_B64 } });
    expect(bodyOf(fetchSpy, 2)).toEqual({
      files,
      kind: "types",
      target: "ts-zod",
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });
  });

  it("keeps a key such as __proto__ an own member of the wire map", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startAck());
    const resources = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
    resources["__proto__"] = TEMPLATE_BYTES;
    await client.start({
      mthds_contents: [INVOICE_MTHDS],
      resources: resources as BundleResources,
    });
    const init = fetchSpy.mock.calls[0]![1] as { body: string };
    expect(init.body).toContain(`"resources":{"__proto__":"${TEMPLATE_B64}"}`);
  });
});

describe("nothing is sent when there is nothing to send", () => {
  it("leaves an absent, null or empty map off every route", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) =>
        Promise.resolve(
          String(input).endsWith("/start")
            ? startAck()
            : String(input).endsWith("/validate")
              ? jsonResponse(200, VALID_VERDICT)
              : jsonResponse(200, PIPE_IO_INVALID),
        ),
      );
    await client.start({ mthds_contents: [INVOICE_MTHDS], resources: {} });
    await client.start({ pipe_code: "p", resources: null });
    await client.validate([INVOICE_MTHDS], false, undefined, undefined, undefined, {
      resources: {},
    });
    await client.pipeIo({ files: [{ content: INVOICE_MTHDS }], resources: null });
    await client.pipeIo({ files: [{ content: INVOICE_MTHDS }] });
    for (let call = 0; call < fetchSpy.mock.calls.length; call++) {
      expect(bodyOf(fetchSpy, call)).not.toHaveProperty("resources");
    }
  });
});

describe("what the runner refuses for certain is refused before any request", () => {
  it.each([
    ["", /it is empty/],
    ["   ", /it is empty/],
    // Python's whitespace, which the runner's `not path.strip()` reads, is not JavaScript's.
    ["\x1c\x1d\x1e\x1f", /it is empty/],
    ["\x85", /it is empty/],
    ["\u3000\t", /it is empty/],
    ["/etc/invoice.docx", /it is absolute/],
    ["../invoice.docx", /'\.\.' segment/],
    ["templates/../../invoice.docx", /'\.\.' segment/],
    ["templates\\invoice.docx", /backslash/],
    ["C:invoice.docx", /colon/],
    ["templates/inv\0oice.docx", /NUL/],
    ["./", /names no file/],
  ])("refuses the key %j", async (key, reason) => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const error = await client
      .start({ mthds_contents: [INVOICE_MTHDS], resources: { [key]: TEMPLATE_BYTES } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestArgumentError);
    expect((error as RequestArgumentError).message).toMatch(reason);
    expect((error as RequestArgumentError).errorDomain).toBe("input");
    expect((error as RequestArgumentError).retryable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a key of nothing but a byte-order mark, which the runner's rule accepts", async () => {
    // JavaScript's `trim()` strips U+FEFF; Python's `strip()` does not, so the runner reads
    // this key as a file name, and the SDK must not refuse what the runner takes.
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(startAck());
    await client.start({
      mthds_contents: [INVOICE_MTHDS],
      resources: { "\ufeff": TEMPLATE_BYTES },
    });
    expect(bodyOf(fetchSpy).resources).toEqual({ "\ufeff": TEMPLATE_B64 });
  });

  it("refuses two keys naming one file once `.` segments and repeated slashes collapse", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      client.validate([INVOICE_MTHDS], false, undefined, undefined, undefined, {
        resources: {
          [TEMPLATE_PATH]: TEMPLATE_BYTES,
          "./templates//invoice.docx": TEMPLATE_BYTES,
        },
      }),
    ).rejects.toThrow(/name the same file "templates\/invoice\.docx"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a value that is not bytes, a string included, on the crate routes too", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      client.pipeIo({
        files: [{ content: INVOICE_MTHDS }],
        resources: { [TEMPLATE_PATH]: TEMPLATE_B64 } as unknown as BundleResources,
      }),
    ).rejects.toThrow(/must be the file's bytes.*neither as a path nor as base64/);
    await expect(
      client.start({
        mthds_contents: [INVOICE_MTHDS],
        resources: [TEMPLATE_BYTES] as unknown as BundleResources,
      }),
    ).rejects.toBeInstanceOf(RequestArgumentError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a Map or a class instance, rather than send no file", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const asMap = new Map([[TEMPLATE_PATH, TEMPLATE_BYTES]]) as unknown as BundleResources;
    class Templates {
      [TEMPLATE_PATH] = TEMPLATE_BYTES;
    }
    const asInstance = new Templates() as unknown as BundleResources;

    await expect(
      client.start({ mthds_contents: [INVOICE_MTHDS], resources: asMap }),
    ).rejects.toThrow(/must be a plain object.*got a Map; pass Object\.fromEntries\(map\)/);
    await expect(
      client.execute({ mthds_contents: [INVOICE_MTHDS], resources: asInstance }),
    ).rejects.toThrow(/got an instance of Templates/);
    await expect(
      client.validate([INVOICE_MTHDS], false, undefined, undefined, undefined, {
        resources: asMap,
      }),
    ).rejects.toBeInstanceOf(RequestArgumentError);
    await expect(
      client.validate(
        { method_ref: "github.com/acme/methods" },
        false,
        undefined,
        undefined,
        undefined,
        {
          resources: asMap,
        },
      ),
    ).rejects.toBeInstanceOf(RequestArgumentError);
    await expect(
      client.pipeIo({ files: [{ content: INVOICE_MTHDS }], resources: asMap }),
    ).rejects.toBeInstanceOf(RequestArgumentError);
    await expect(
      client.prepareInputs({ files: [{ content: INVOICE_MTHDS }], resources: asMap, inputs: {} }),
    ).rejects.toBeInstanceOf(RequestArgumentError);
    await expect(
      client.prepareInputs({
        method_ref: "github.com/acme/methods",
        resources: asMap,
        inputs: {},
      } as never),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses them beside a method_ref on the run routes and on validate", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const resources = { [TEMPLATE_PATH]: TEMPLATE_BYTES };
    const address = "github.com/acme/methods/invoicing@v1.0.0";
    await expect(client.start({ method_ref: address, resources })).rejects.toThrow(
      /a method_ref's files are the package's own/,
    );
    await expect(client.execute({ method_ref: address, resources })).rejects.toBeInstanceOf(
      RequestArgumentError,
    );
    await expect(
      client.validate({ method_ref: address }, false, undefined, undefined, undefined, {
        resources,
      }),
    ).rejects.toThrow(/a method_ref's files are the package's own/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses them on a run with no bundle for them to accompany", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      client.start({
        pipe_code: "invoicing.print_invoice",
        resources: { "a.docx": TEMPLATE_BYTES },
      }),
    ).rejects.toThrow(/accompany the bundle whose steps read them/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses them smuggled through `extra` — one argument, one path", async () => {
    const client = makeClient();
    await expect(
      client.start({
        mthds_contents: [INVOICE_MTHDS],
        extra: { resources: { [TEMPLATE_PATH]: TEMPLATE_B64 } },
      }),
    ).rejects.toThrow(/reserved request args \[resources\]/);
  });
});

describe("prepareInputs sends them with inline files", () => {
  it("passes them to the pipe I/O request that reads the signature", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        pipe_ref: "invoicing.print_invoice",
        pipe_io_contracts: {},
        input_form: {
          "invoicing.print_invoice": {
            fields: [
              { name: "invoice", kind: "text", required: true, presence: "plain", gating: true },
            ],
          },
        },
        output_form: {},
        default_pipe_ref: "invoicing.print_invoice",
        pending_signatures: [],
        is_runnable: true,
      }),
    );
    const prepared = await client.prepareInputs({
      files: [{ content: INVOICE_MTHDS, source: "invoice.mthds" }],
      resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
      inputs: { invoice: "INV-1" },
    });
    expect(prepared.inputs).toEqual({ invoice: "INV-1" });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(`${BASE_URL}/v1/pipe-io`);
    expect(bodyOf(fetchSpy)).toEqual({
      files: [{ content: INVOICE_MTHDS, source: "invoice.mthds" }],
      resources: { [TEMPLATE_PATH]: TEMPLATE_B64 },
    });
  });

  it("refuses them beside a method_ref or a method_id, before any request", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const resources = { [TEMPLATE_PATH]: TEMPLATE_BYTES };
    await expect(
      client.prepareInputs({
        method_ref: "github.com/acme/methods/invoicing",
        resources,
        inputs: {},
      } as never),
    ).rejects.toThrow(/a published method's files are its own/);
    await expect(
      client.prepareInputs({ method_id: "mt_1", resources, inputs: {} } as never),
    ).rejects.toBeInstanceOf(InputPreparationError);
    await expect(
      client.prepareInputs({ method_id: "mt_1", resources: "t.docx", inputs: {} } as never),
    ).rejects.toBeInstanceOf(InputPreparationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a value beside inline files that is not a map of paths to bytes", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      client.prepareInputs({
        files: [{ content: INVOICE_MTHDS }],
        resources: "templates/invoice.docx",
        inputs: {},
      } as never),
    ).rejects.toThrow(/resources must be a plain object mapping each file's path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the closure that fails to load without them as the method's failure", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        validation_errors: [
          {
            category: "pipe_factory",
            error_type: "pipe_factory_error",
            message:
              "PipeDocGen 'print_invoice': its template file 'templates/invoice.docx' was not supplied with its bundle.",
            pipe_code: "print_invoice",
            domain_code: "invoicing",
          },
        ],
        message: "MTHDS library could not be resolved",
      }),
    );
    await expect(
      client.prepareInputs({ files: [{ content: INVOICE_MTHDS }], inputs: { invoice: "INV-1" } }),
    ).rejects.toThrow(/not supplied with its bundle/);
  });
});

describe("the runner's refusals reach the caller typed", () => {
  it.each([
    [
      422,
      "InvalidResourcePath",
      "Two files submitted with the bundle name the same file 'a.docx'.",
    ],
    [422, "BundleResourceNotNamedError", "No step of the bundle names the file 'typo.docx'."],
    [422, "MethodTreeTooLarge", "The method tree exceeds the deployment's total size limit."],
    [413, "PayloadTooLarge", "resources exceeds the 32-file limit (got 33)"],
    [413, "BundleResourcesTooLargeError", "The .html template files exceed 512 KiB."],
    [400, "InvalidBase64", "The file 'a.docx' in resources is not valid base64"],
  ])("a %i %s is an input ApiResponseError", async (status, errorType, detail) => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(status, errorType, detail));
    const error = await client
      .validate([INVOICE_MTHDS], false, undefined, undefined, undefined, {
        resources: { [TEMPLATE_PATH]: TEMPLATE_BYTES },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiResponseError);
    const refusal = error as ApiResponseError;
    expect(refusal.status).toBe(status);
    expect(refusal.errorType).toBe(errorType);
    expect(refusal.errorDomain).toBe("input");
    expect(refusal.retryable).toBe(false);
    expect(refusal.serverMessage).toBe(detail);
  });
});

describe("a template check's warning reaches the caller with its locators", () => {
  it("reads the step, the file and the place in it off the valid arm's warnings", async () => {
    const client = makeClient();
    const warning = {
      category: "dry_run",
      error_type: "template_check_warning",
      message:
        "PipeDocGen 'print_invoice', template file 'templates/invoice.xlsx': the defined name 'due_date' matches no input (Sheet1!B4)",
      pipe_code: "print_invoice",
      concept_code: null,
      domain_code: "invoicing",
      source: null,
      field_path: null,
      field_name: null,
      variable_names: null,
      missing_concept_code: null,
      missing_pipe_code: null,
      declared_concepts: null,
      line: null,
      column: null,
      model_reference: null,
      model_type: null,
      suggestions: null,
      template_file: "templates/invoice.xlsx",
      template_location: "Sheet1!B4",
      suggested_fix: null,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...VALID_VERDICT, warnings: [warning] }),
    );
    const report = await client.validate([INVOICE_MTHDS], false, undefined, undefined, undefined, {
      resources: { "templates/invoice.xlsx": TEMPLATE_BYTES },
    });
    if (report.is_valid !== true) throw new Error("expected the valid arm");
    const [item] = report.warnings;
    expect(item?.error_type).toBe("template_check_warning");
    expect(item?.category).toBe("dry_run");
    expect(item?.pipe_code).toBe("print_invoice");
    expect(item?.domain_code).toBe("invoicing");
    expect(item?.template_file).toBe("templates/invoice.xlsx");
    expect(item?.template_location).toBe("Sheet1!B4");
  });

  it("reads a host library step's withheld file and an unlocated finding as null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        ...VALID_VERDICT,
        warnings: [
          {
            category: "dry_run",
            error_type: "template_check_warning",
            message:
              "PipeDocGen 'print', template file '<host library file>': a field prints its markup",
            pipe_code: "print",
            domain_code: "host",
            template_file: null,
            template_location: null,
          },
        ],
      }),
    );
    const report = await client.validate([INVOICE_MTHDS]);
    if (report.is_valid !== true) throw new Error("expected the valid arm");
    expect(report.warnings[0]?.template_file).toBeNull();
    expect(report.warnings[0]?.template_location).toBeNull();
  });
});

describe("a request carrying them gets a budget their upload fits in", () => {
  /** A fetch that never resolves; it only rejects when its abort signal fires. */
  function hangingFetch(): typeof fetch {
    return ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      })) as typeof fetch;
  }

  /** Observe settlement without awaiting, to assert "still pending". */
  function track<T>(promise: Promise<T>): { settled: boolean; error: unknown } {
    const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
    promise.then(
      () => {
        state.settled = true;
      },
      (error: unknown) => {
        state.settled = true;
        state.error = error;
      },
    );
    return state;
  }

  const files = [{ content: INVOICE_MTHDS, source: "invoice.mthds" }];
  const resources = { [TEMPLATE_PATH]: TEMPLATE_BYTES };
  const MINUTE = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises the crate routes and prepareInputs to the execute ceiling, as start is", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
    const client = makeClient();

    const bare = track(client.pipeIo({ files }));
    const carrying = [
      track(client.pipeIo({ files, resources })),
      track(client.resolve({ files, resources })),
      track(client.codegen({ files, resources, kind: "types", target: "ts-zod" })),
      track(client.prepareInputs({ files, resources, inputs: { invoice: "INV-1" } })),
    ];

    // The static default cuts the bare request; the method_ref budget would cut the rest at 3 min.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(bare.settled).toBe(true);
    expect(bare.error).toBeInstanceOf(ApiUnreachableError);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(carrying.map((call) => call.settled)).toEqual([false, false, false, false]);

    await vi.advanceTimersByTimeAsync(16 * MINUTE);
    for (const call of carrying) {
      expect(call.settled).toBe(true);
      expect(call.error).toBeInstanceOf(ApiUnreachableError);
      expect((call.error as ApiUnreachableError).code).toBe("ABORT_TIMEOUT");
    }
  });

  it("leaves validate and validateFiles on the execute ceiling they default to", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch());
    const client = makeClient();

    const viaValidate = track(
      client.validate([INVOICE_MTHDS], false, undefined, undefined, undefined, { resources }),
    );
    const viaFiles = track(client.validateFiles([{ content: INVOICE_MTHDS }], { resources }));

    await vi.advanceTimersByTimeAsync(19 * MINUTE);
    expect([viaValidate.settled, viaFiles.settled]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(viaValidate.error).toBeInstanceOf(ApiUnreachableError);
    expect(viaFiles.error).toBeInstanceOf(ApiUnreachableError);
  });
});
