/**
 * What an upload is recorded as on `POST /v1/upload`: an upload carrying its `kind` and
 * `method_id` through `upload`, `uploadFile` and `prepareInputs`, and the upload route's
 * refusals of a test file, each read as the typed error it is while the refusals that only
 * share its status keep their old reading. The fetch boundary is mocked, so the client's real
 * request pipeline and problem parsing run.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import {
  InputPreparationError,
  TestFileRefusedError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "../src/errors.js";
import type { UploadInput, UploadKind } from "../src/index.js";

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

/** A platform refusal as the platform serializes one: RFC 9457 with its code and verdict. */
function problem(
  status: number,
  code: string,
  errorDomain: "input" | "config" | "runtime",
  detail: string,
): Response {
  return new Response(
    JSON.stringify({
      type: `https://pipelex.com/errors/${code}`,
      title: code,
      status,
      detail,
      code,
      error_domain: errorDomain,
      retryable: false,
      instance: "/v1/upload",
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

/** The JSON body of the spy's only call. */
function sentBody(spy: ReturnType<typeof vi.spyOn>): unknown {
  const [, init] = spy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an upload's kind and method", () => {
  it("upload sends kind and method_id in the body as given", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { uri: "pipelex-storage://org_1/assets/a.pdf", filename: "a.pdf" }),
      );

    await client.upload({
      filename: "a.pdf",
      data: "Zm9v",
      content_type: "application/pdf",
      kind: "test",
      method_id: "mt_abc",
    });

    expect(sentBody(spy)).toEqual({
      filename: "a.pdf",
      data: "Zm9v",
      content_type: "application/pdf",
      kind: "test",
      method_id: "mt_abc",
    });
    expectTypeOf<UploadInput["kind"]>().toEqualTypeOf<UploadKind | undefined>();
    expectTypeOf<UploadKind>().toEqualTypeOf<"uploaded" | "test">();
  });

  it("uploadFile sends a test file's kind and method with its bytes", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { uri: "pipelex-storage://org_1/assets/b.png", filename: "case.png" }),
      );

    const record = await client.uploadFile(new Uint8Array([1, 2, 3]), {
      filename: "case.png",
      kind: "test",
      method_id: "mt_abc",
    });

    expect(sentBody(spy)).toEqual({
      filename: "case.png",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      content_type: "image/png",
      kind: "test",
      method_id: "mt_abc",
    });
    expect(record.uri).toBe("pipelex-storage://org_1/assets/b.png");
  });

  it("uploadFile sends neither member when neither is given", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { uri: "pipelex-storage://org_1/assets/c.bin", filename: "c.bin" }),
      );

    await client.uploadFile(new Uint8Array([1]), { filename: "c.bin" });

    expect(Object.keys(sentBody(spy) as object).sort()).toEqual([
      "content_type",
      "data",
      "filename",
    ]);
  });

  it("prepareInputs sends its upload's kind and method with every file it uploads", async () => {
    const client = makeClient();
    let uploads = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/v1/pipe-io")) {
        return jsonResponse(200, {
          is_valid: true,
          pipe_ref: "demo.main",
          pipe_io_contracts: {},
          input_form: {
            "demo.main": {
              fields: [
                { name: "photo", kind: "image", required: true, presence: "plain", gating: true },
                { name: "scan", kind: "document", required: true, presence: "plain", gating: true },
              ],
            },
          },
          output_form: {},
          default_pipe_ref: "demo.main",
          pending_signatures: [],
          is_runnable: true,
        });
      }
      uploads += 1;
      return jsonResponse(200, { uri: `pipelex-storage://org_1/assets/${uploads}`, filename: "f" });
    });

    const prepared = await client.prepareInputs({
      method_id: "mt_abc",
      inputs: { photo: new Uint8Array([1]), scan: new Uint8Array([2]) },
      upload: { kind: "test", method_id: "mt_abc" },
    });

    const uploadBodies = spy.mock.calls
      .filter((call) => String(call[0]).endsWith("/v1/upload"))
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
    expect(uploadBodies).toHaveLength(2);
    for (const body of uploadBodies) {
      expect(body["kind"]).toBe("test");
      expect(body["method_id"]).toBe("mt_abc");
    }
    // The request's own `method_id` still selects the method on the pipe I/O call.
    const pipeIo = spy.mock.calls.find((call) => String(call[0]).endsWith("/v1/pipe-io"));
    expect(JSON.parse(String((pipeIo![1] as RequestInit).body))).toMatchObject({
      method_id: "mt_abc",
    });
    expect(prepared.uploads).toHaveLength(2);
  });

  it("prepareInputs refuses a test upload naming no method before any request", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const error = await client
      .prepareInputs({
        method_id: "mt_abc",
        inputs: { photo: new Uint8Array([1]) },
        upload: { kind: "test" },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InputPreparationError);
    expect((error as Error).message).toContain("`upload.method_id`");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the upload route's refusals of a test file", () => {
  /** What `uploadFile` throws when the upload route answers `response` to a test file. */
  async function refusedTestFile(response: Response, methodId = "mt_abc"): Promise<unknown> {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    return makeClient()
      .uploadFile(new Uint8Array([1]), { filename: "case.pdf", kind: "test", method_id: methodId })
      .then(
        () => expect.fail("expected the upload to throw"),
        (thrown: unknown) => thrown,
      );
  }

  it("reads a 403 role_not_permitted as the caller's role, not its credential", async () => {
    const error = await refusedTestFile(
      problem(
        403,
        "role_not_permitted",
        "config",
        "Your role in this organization is runner: it runs the organization's published versions and changes no method.",
      ),
    );

    expect(error).toBeInstanceOf(TestFileRefusedError);
    expect(error).not.toBeInstanceOf(UploadAuthenticationError);
    const refused = error as TestFileRefusedError;
    expect(refused.code).toBe("role_not_permitted");
    expect(refused.status).toBe(403);
    expect(refused.filename).toBe("case.pdf");
    expect(refused.methodId).toBe("mt_abc");
    expect(refused.message).toContain("runner");
    // The server's verdict: an admin changes the role; sending again changes nothing.
    expect(refused.errorDomain).toBe("config");
    expect(refused.retryable).toBe(false);
  });

  it("reads a 404 not_found the platform answers as input as the unknown method", async () => {
    const error = await refusedTestFile(
      problem(404, "not_found", "input", "Item not found."),
      "mt_gone",
    );

    expect(error).toBeInstanceOf(TestFileRefusedError);
    expect(error).not.toBeInstanceOf(UnsupportedUploadCapabilityError);
    const refused = error as TestFileRefusedError;
    expect(refused.code).toBe("method_not_found");
    expect(refused.methodId).toBe("mt_gone");
    expect(refused.message).toContain('"mt_gone"');
    expect(refused.errorDomain).toBe("input");
  });

  it("reads a 409 method_being_deleted as the method being erased", async () => {
    const error = await refusedTestFile(
      problem(409, "method_being_deleted", "input", "Method 'mt_abc' is being deleted."),
    );

    expect(error).toBeInstanceOf(TestFileRefusedError);
    expect((error as TestFileRefusedError).code).toBe("method_being_deleted");
    expect((error as TestFileRefusedError).errorDomain).toBe("input");
  });

  it("keeps a 404 the platform answers as config, a deployment without the route, unsupported", async () => {
    const error = await refusedTestFile(problem(404, "not_found", "config", "Not Found"));

    expect(error).toBeInstanceOf(UnsupportedUploadCapabilityError);
  });

  it("keeps a bare runner's 404, which carries no code, unsupported", async () => {
    const error = await refusedTestFile(jsonResponse(404, { detail: "Not Found" }));

    expect(error).toBeInstanceOf(UnsupportedUploadCapabilityError);
  });

  it("keeps any other 403 a refused credential", async () => {
    const error = await refusedTestFile(problem(403, "forbidden", "config", "Forbidden."));

    expect(error).toBeInstanceOf(UploadAuthenticationError);
  });

  it("keeps any other 409 a transport failure carrying the server's verdict", async () => {
    const error = await refusedTestFile(problem(409, "conflict", "input", "Key reused."));

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).errorDomain).toBe("input");
  });

  it("reads a 404 not_found as unsupported when the upload named no method", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problem(404, "not_found", "input", "Item not found."),
    );

    const error = await makeClient()
      .uploadFile(new Uint8Array([1]), { filename: "a.pdf" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedUploadCapabilityError);
  });
});
