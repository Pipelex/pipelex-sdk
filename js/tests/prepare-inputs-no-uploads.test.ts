/**
 * `prepareInputs` with `allowUploads: false`: a value at a file input that would need an upload —
 * a local path, a `data:` URL, bytes — is refused with an `UploadNotAllowedError` naming the input
 * and where inside it the value sits, before anything is read, decoded or uploaded, while `http(s)`
 * URLs and `pipelex-storage://` references pass through (`docs/input-preparation.md`, "Preparing
 * without uploads").
 *
 * `readFile` is wrapped in a spy here, so a case can show that no file was read at all rather than
 * only that nothing was uploaded. It lives in its own file so that the spy touches no other suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  InputForm,
  InputFormField,
  InputFormItem,
  InputFormTopLevelField,
} from "mthds/protocol";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

const { prepareInputs } = await import("../src/prepare-inputs.js");
const { InputPreparationError, InvalidInputValueError, UploadNotAllowedError } =
  await import("../src/errors.js");
const { errorVerdictOf } = await import("../src/errors.js");
type PrepareCapableClient = import("../src/prepare-inputs.js").PrepareCapableClient;
type PipeIORequest = import("../src/models.js").PipeIORequest;

// ── Descriptor fixtures ──────────────────────────────────────────────

const document = (): InputFormItem => ({ kind: "document", required: true });
const image = (): InputFormItem => ({ kind: "image", required: true });
const text = (): InputFormItem => ({ kind: "text", required: true });
const object = (fields: InputFormField[]): InputFormItem => ({
  kind: "object",
  required: true,
  fields,
});
const list = (item: InputFormItem): InputFormItem => ({ kind: "list", required: true, item });

function named(name: string, node: InputFormItem): InputFormField {
  return { ...node, name } as InputFormField;
}

function topLevel(name: string, node: InputFormItem): InputFormTopLevelField {
  return { ...node, name, presence: "plain", gating: true } as InputFormTopLevelField;
}

// ── The fake client ──────────────────────────────────────────────────

interface FakeClient extends PrepareCapableClient {
  pipeIoCalls: PipeIORequest[];
  uploadCalls: number;
}

/** A client whose `pipeIo` answers one pipe's descriptor and whose `upload` counts its calls. */
function makeClient(fields: InputFormTopLevelField[]): FakeClient {
  const inputForm: InputForm = { "demo.main": { fields } };
  const client: FakeClient = {
    pipeIoCalls: [],
    uploadCalls: 0,
    async pipeIo(request) {
      client.pipeIoCalls.push(request);
      return {
        is_valid: true,
        pipe_ref: "demo.main",
        pipe_io_contracts: {},
        input_form: inputForm,
        output_form: {},
        default_pipe_ref: "demo.main",
        pending_signatures: [],
        is_runnable: true,
      };
    },
    async upload(input) {
      client.uploadCalls += 1;
      return {
        uri: `pipelex-storage://user/assets/${client.uploadCalls}.bin`,
        filename: input.filename,
      };
    },
  };
  return client;
}

const FILES = [{ content: 'domain = "demo"' }];
const readFileSpy = vi.mocked(fsPromises.readFile);

/** Run a preparation that must fail, and hand back what it threw. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable("the preparation should have been refused"),
    (error: unknown) => error,
  );
}

const tempDirs: string[] = [];

beforeEach(() => {
  readFileSpy.mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A real file on disk, so a case shows the refusal does not depend on the path being unreadable. */
async function realFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "plx-no-uploads-"));
  tempDirs.push(dir);
  const path = join(dir, "shot.png");
  await writeFile(path, new Uint8Array([1, 2, 3, 4]));
  return path;
}

describe("prepareInputs with allowUploads: false refuses every value that would need an upload", () => {
  it("refuses a local path that exists, without reading it", async () => {
    const client = makeClient([topLevel("photo", image())]);
    const path = await realFile();

    const error = await refusal(
      prepareInputs(client, { files: FILES, inputs: { photo: path }, allowUploads: false }),
    );

    expect(error).toBeInstanceOf(UploadNotAllowedError);
    expect(error).toMatchObject({
      inputName: "photo",
      inputPath: "photo",
      valueKind: "local_path",
    });
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(client.uploadCalls).toBe(0);
  });

  it("refuses a local path inside canonical {url} content, without reading it", async () => {
    const client = makeClient([topLevel("report", document())]);

    const error = await refusal(
      prepareInputs(client, {
        files: FILES,
        inputs: { report: { url: "/etc/passwd", filename: "report.pdf" } },
        allowUploads: false,
      }),
    );

    expect(error).toMatchObject({ inputPath: "report", valueKind: "local_path" });
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("refuses a data: URL without decoding it, so a malformed one is refused the same way", async () => {
    const client = makeClient([topLevel("photo", image())]);

    for (const dataUrl of [
      "data:image/png;base64,AQIDBA==",
      "data:image/png;base64,%%%",
      "data:",
    ]) {
      const error = await refusal(
        prepareInputs(client, { files: FILES, inputs: { photo: dataUrl }, allowUploads: false }),
      );

      expect(error, dataUrl).toBeInstanceOf(UploadNotAllowedError);
      expect(error, dataUrl).toMatchObject({ valueKind: "data_url" });
    }
    expect(client.uploadCalls).toBe(0);
  });

  it("refuses every byte form without reading the bytes", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const blobRead = vi.spyOn(blob, "arrayBuffer");
    const sources = [new Uint8Array([1]), new Uint8Array([2]).buffer, blob];

    for (const source of sources) {
      const client = makeClient([topLevel("photo", image())]);
      const error = await refusal(
        prepareInputs(client, { files: FILES, inputs: { photo: source }, allowUploads: false }),
      );

      expect(error).toMatchObject({ valueKind: "bytes" });
      expect(client.uploadCalls).toBe(0);
    }
    expect(blobRead).not.toHaveBeenCalled();
  });

  it("names where the value sits inside a structured input and a list", async () => {
    const client = makeClient([
      topLevel("dossier", object([named("title", text()), named("attachments", list(document()))])),
    ]);

    const error = await refusal(
      prepareInputs(client, {
        files: FILES,
        inputs: {
          dossier: {
            title: "Q3",
            attachments: ["https://example.com/a.pdf", "notes/b.pdf"],
          },
        },
        allowUploads: false,
      }),
    );

    expect(error).toMatchObject({
      inputName: "dossier",
      inputPath: "dossier.attachments[1]",
      valueKind: "local_path",
    });
    expect((error as Error).message).toContain('"dossier.attachments[1]"');
  });

  it("names an explicit envelope's input by its name alone, since its content is the value", async () => {
    const client = makeClient([topLevel("photo", image())]);

    const error = await refusal(
      prepareInputs(client, {
        files: FILES,
        inputs: { photo: { concept: "native.Image", content: "shot.png" } },
        allowUploads: false,
      }),
    );

    expect(error).toMatchObject({ inputName: "photo", inputPath: "photo" });
  });

  it("keeps the value out of the message, and carries the input verdict", async () => {
    const client = makeClient([topLevel("photo", image())]);

    const error = await refusal(
      prepareInputs(client, {
        files: FILES,
        inputs: { photo: "/home/someone/secret-plans.png" },
        allowUploads: false,
      }),
    );

    expect(error).toBeInstanceOf(InputPreparationError);
    expect((error as Error).message).not.toContain("secret-plans");
    expect((error as Error).name).toBe("UploadNotAllowedError");
    expect(errorVerdictOf(error)).toEqual({ errorDomain: "input", retryable: false });
  });
});

describe("prepareInputs with allowUploads: false passes references through", () => {
  it("rewrites http(s) URLs and storage references as the default mode does, uploading nothing", async () => {
    const client = makeClient([
      topLevel("photo", image()),
      topLevel("exhibits", list(document())),
      topLevel("question", text()),
    ]);

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: {
        photo: { concept: "native.Image", content: "https://example.com/p.png" },
        exhibits: ["pipelex-storage://user/assets/a.pdf", { url: "HTTP://example.com/b.pdf" }],
        question: "notes/summary.txt",
      },
      allowUploads: false,
    });

    expect(prepared).toEqual({
      inputs: {
        photo: { concept: "native.Image", content: { url: "https://example.com/p.png" } },
        exhibits: [
          { url: "pipelex-storage://user/assets/a.pdf" },
          { url: "HTTP://example.com/b.pdf" },
        ],
        question: "notes/summary.txt",
      },
      uploads: [],
    });
    expect(client.uploadCalls).toBe(0);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("still refuses a value no file input takes as an InvalidInputValueError", async () => {
    const client = makeClient([topLevel("photo", image())]);

    const error = await refusal(
      prepareInputs(client, { files: FILES, inputs: { photo: 42 }, allowUploads: false }),
    );

    expect(error).toBeInstanceOf(InvalidInputValueError);
    expect(error).not.toBeInstanceOf(UploadNotAllowedError);
  });

  it("names the input of a value no file input takes, and offers only the two forms that pass", async () => {
    const client = makeClient([
      topLevel("dossier", object([named("attachments", list(document()))])),
    ]);

    const error = await refusal(
      prepareInputs(client, {
        files: FILES,
        inputs: { dossier: { attachments: ["https://example.com/a.pdf", 42] } },
        allowUploads: false,
      }),
    );

    expect(error).toBeInstanceOf(InvalidInputValueError);
    expect(error).toMatchObject({ inputName: "dossier", inputPath: "dossier.attachments[1]" });
    const message = (error as Error).message;
    expect(message).toBe(
      'Input "dossier.attachments[1]" holds a number, which no file input takes, and this ' +
        "preparation uploads nothing: pass an http(s) URL or a pipelex-storage:// reference instead.",
    );
    expect(message).not.toMatch(/local path|bytes|data:/);
    expect(client.uploadCalls).toBe(0);
  });
});

describe("the allowUploads option itself", () => {
  it("uploads as before when it is true", async () => {
    const client = makeClient([topLevel("photo", image())]);
    const path = await realFile();

    const prepared = await prepareInputs(client, {
      files: FILES,
      inputs: { photo: path },
      allowUploads: true,
    });

    expect(prepared.inputs).toEqual({ photo: { url: "pipelex-storage://user/assets/1.bin" } });
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a value that is not a boolean before any request", async () => {
    for (const value of ["false", 0, null]) {
      const client = makeClient([topLevel("photo", image())]);
      const request = {
        files: FILES,
        inputs: { photo: "shot.png" },
        allowUploads: value,
      } as unknown as Parameters<typeof prepareInputs>[1];

      const error = await refusal(prepareInputs(client, request));

      expect(error, String(value)).toBeInstanceOf(InputPreparationError);
      expect((error as Error).message, String(value)).toContain("`allowUploads` must be a boolean");
      expect(client.pipeIoCalls, String(value)).toEqual([]);
    }
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("is not sent to the server", async () => {
    const client = makeClient([topLevel("photo", image())]);

    await prepareInputs(client, {
      method_id: "mt_abc",
      inputs: { photo: "https://example.com/p.png" },
      allowUploads: false,
    });

    expect(client.pipeIoCalls).toEqual([{ method_id: "mt_abc" }]);
  });
});
