import { describe, it, expect } from "vitest";
import type { PipeInputFormDescriptor } from "@pipelex/sdk";
import {
  MAX_FILE_BYTES,
  checkFileInputs,
  checkUploadRequest,
  fileInputErrorToPipelineError,
  fileTooLargeError,
} from "./fileInputs";

const STORED = "pipelex-storage://org_1/assets/cv.pdf";
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQK";

describe("checkUploadRequest", () => {
  const opts = { allowedMimes: ["application/pdf"], maxBytes: MAX_FILE_BYTES };
  const request = { filename: "cv.pdf", content_type: "application/pdf", size: 1024 };

  it("accepts a file of a type the method takes, under the cap", () => {
    expect(checkUploadRequest(request, opts)).toBeNull();
    expect(checkUploadRequest({ ...request, size: MAX_FILE_BYTES }, opts)).toBeNull();
  });

  it("refuses a type the method does not take, naming it and what is expected", () => {
    const refused = checkUploadRequest({ ...request, content_type: "image/png" }, opts);
    expect(refused?.kind).toBe("unsupported_file_type");
    expect(refused?.message).toContain('"image/png"');
    expect(refused?.message).toContain("application/pdf");
  });

  it("refuses a file the browser could not type", () => {
    // A browser reports `file.type === ""` for a type it does not know.
    const refused = checkUploadRequest({ ...request, content_type: "" }, opts);
    expect(refused?.kind).toBe("unsupported_file_type");
    expect(refused?.message).toContain("an unknown type");
  });

  it("refuses a file over the cap with the shared wording", () => {
    const size = MAX_FILE_BYTES + 1;
    expect(checkUploadRequest({ ...request, size }, opts)).toEqual(
      fileTooLargeError(size, MAX_FILE_BYTES),
    );
  });

  it.each([
    ["no request at all", undefined],
    ["a nameless file", { ...request, filename: "" }],
    ["an empty file", { ...request, size: 0 }],
    ["a size that is not a whole number", { ...request, size: 1.5 }],
    ["a size that is not a number", { ...request, size: "1024" }],
  ])("refuses %s — a Server Action reads untrusted JSON", (_label, bad) => {
    expect(checkUploadRequest(bad, opts)?.kind).toBe("invalid_file");
  });
});

describe("checkFileInputs", () => {
  // Descriptor nodes in the wire shape `POST /v1/validate` returns — the same
  // artifact `INPUT_FORM` in a generated `contracts.ts` carries. The gate is
  // typed on the standard's closed shapes, so the fixtures cast to it.
  const DOCUMENT = { kind: "document", concept_ref: "native.Document", required: true } as const;
  const top = (name: string, node: Record<string, unknown>): Record<string, unknown> => ({
    ...node,
    name,
    required: true,
    presence: "plain",
    gating: true,
  });
  const descriptor = (...fields: unknown[]): PipeInputFormDescriptor =>
    ({ fields }) as PipeInputFormDescriptor;

  /** One top-level `document` input named `document` — the PDF example's shape. */
  const SINGLE = descriptor(top("document", DOCUMENT));
  const enveloped = (url: string, filename?: string) => ({
    document: { concept: "native.Document", content: { url, ...(filename && { filename }) } },
  });

  it("accepts the references a file input may legitimately carry", () => {
    expect(checkFileInputs(SINGLE, enveloped(STORED))).toBeNull();
    expect(checkFileInputs(SINGLE, enveloped("https://example.com/a.pdf"))).toBeNull();
  });

  it("refuses a file sent inline — a run carries references, never bytes", () => {
    // The browser uploads a dropped file with a grant before any run, so a
    // `data:` URL reaching a run action was not sent by this app's page.
    const error = checkFileInputs(SINGLE, enveloped(PDF_DATA_URL, "cv.pdf"));
    expect(error?.title).toBe("Unsupported file reference");
    expect(error?.details).toBe("unsupported_scheme: document");
  });

  it("reads the compact form the SDK also accepts", () => {
    // `prepareInputs` resolves a bare source string at a file position exactly
    // as it resolves `{url}`. Skipping it would leave the verdict resting on
    // ajv refusing a string where `native.Document` declares an object — the
    // schema in front of the gate, not the gate.
    const compact = (content: string) => ({
      document: { concept: "native.Document", content },
    });
    expect(checkFileInputs(SINGLE, compact(STORED))).toBeNull();
    expect(checkFileInputs(SINGLE, compact("/etc/passwd"))?.details).toBe(
      "unsupported_scheme: document",
    );
  });

  it("reads a bare value as readily as the kernel's envelope", () => {
    // The SDK reads a top-level input either way — the explicit `{concept,
    // content}` envelope or the compact value — and so must this, or a caller
    // that skips the envelope skips the gate.
    expect(checkFileInputs(SINGLE, { document: { url: "/etc/passwd" } })?.details).toBe(
      "unsupported_scheme: document",
    );
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a relative path", "../../.env.local"],
    ["a bare filename", "package.json"],
    ["a file:// URL", "file:///etc/hosts"],
    ["a cleartext http URL", "http://169.254.169.254/latest/meta-data/"],
  ])("refuses %s", (_label, url) => {
    // Anything outside the accepted set reaches `prepareInputs` as a *local
    // filesystem path*, which it reads and uploads. Refusing by default is the
    // whole design; see the ALLOWED_FILE_SCHEMES docstring.
    const error = checkFileInputs(SINGLE, enveloped(url));
    expect(error?.kind).toBe("bad_request");
    expect(error?.title).toBe("Unsupported file reference");
  });

  it("gates a file input whatever the bundle calls it", () => {
    // The rename case the old `inputs.document` lookup failed open on. Codegen
    // carries a rename into the form, the readiness rules, the wire envelope —
    // and the descriptor this gate walks, so the gate moves with it.
    const RENAMED = descriptor(top("attachment", DOCUMENT));
    const renamed = { attachment: { concept: "native.Document", content: { url: "/etc/passwd" } } };
    expect(checkFileInputs(RENAMED, renamed)?.details).toBe("unsupported_scheme: attachment");
  });

  it("ignores inputs the descriptor declares as something else, and checks every file", () => {
    const MIXED = descriptor(
      top("text", { kind: "prose", concept_ref: "native.Text" }),
      top("first", DOCUMENT),
      top("second", DOCUMENT),
    );
    const mixed = {
      text: { concept: "native.Text", content: { text: "not a file" } },
      first: { concept: "native.Document", content: { url: "https://example.com/a.pdf" } },
      second: { concept: "native.Document", content: { url: "/etc/passwd" } },
    };
    expect(checkFileInputs(MIXED, mixed)?.details).toBe("unsupported_scheme: second");
  });

  // `prepareInputs` walks the method's wire descriptor, so it resolves a file
  // inside a list or nested in a structured concept. This gate walks the same
  // descriptor, so it reaches exactly those positions — the earlier shape of it
  // read one level down and refused anything deeper, which is how a
  // `cvs: list[Document]` input was refused at run time.
  describe("a file position below the top level", () => {
    /** `cvs: Document[]` beside a single `job_offer_pdf` — the CV-screening shape. */
    const CVS = descriptor(
      {
        ...top("cvs", { kind: "list", concept_ref: "native.Document", item: DOCUMENT }),
        gating: false,
      },
      top("job_offer_pdf", DOCUMENT),
    );
    const cvs = (...urls: string[]) => ({
      cvs: {
        concept: "native.Document",
        content: urls.map((url, index) => ({ url, filename: `cv-${index}.pdf` })),
      },
      job_offer_pdf: { concept: "native.Document", content: { url: STORED } },
    });

    it("accepts every file in a list", () => {
      expect(checkFileInputs(CVS, cvs(STORED, "https://example.com/b.pdf"))).toBeNull();
    });

    it("refuses one bad reference in a list, naming its position", () => {
      const error = checkFileInputs(CVS, cvs(STORED, "/etc/passwd"));
      expect(error?.title).toBe("Unsupported file reference");
      expect(error?.details).toBe("unsupported_scheme: cvs.1");
    });

    it("accepts an empty list — a variable list needs no items", () => {
      expect(checkFileInputs(CVS, cvs())).toBeNull();
    });

    it("reaches a file nested in a structured concept", () => {
      const PACKET = descriptor(
        top("packet", {
          kind: "object",
          concept_ref: "d.Packet",
          fields: [
            { kind: "text", name: "note", required: true },
            { ...DOCUMENT, name: "attachment" },
          ],
        }),
      );
      const nested = {
        packet: {
          concept: "d.Packet",
          content: { note: "hi", attachment: { url: "/etc/passwd", filename: "x.pdf" } },
        },
      };
      expect(checkFileInputs(PACKET, nested)?.details).toBe(
        "unsupported_scheme: packet.attachment",
      );
    });

    it("leaves an empty optional file position alone", () => {
      // `null` is how an optional nested file is left unset, and nothing reads
      // a file for it. Only what is present is verified.
      const PACKET = descriptor(
        top("packet", {
          kind: "object",
          concept_ref: "d.Packet",
          fields: [{ ...DOCUMENT, name: "scan", required: false }],
        }),
      );
      const empty = { packet: { concept: "d.Packet", content: { scan: null } } };
      expect(checkFileInputs(PACKET, empty)).toBeNull();
    });
  });

  // The descriptor is the classifier, never the value's shape — which cuts both
  // ways. A `url` the descriptor does not declare as a file is not one, and a
  // value the SDK will not read cannot be made to look like one.
  describe("what the descriptor does not declare", () => {
    it("does not mistake a text field named `url` for a file", () => {
      // The false positive a value walk cannot avoid: a structured concept with
      // a `url` field of its own. `prepareInputs` copies it through untouched,
      // so there is nothing to verify and refusing it would refuse the method.
      const LINK = descriptor(
        top("link", {
          kind: "object",
          concept_ref: "d.Link",
          fields: [{ kind: "text", name: "url", required: true }],
        }),
      );
      const link = { link: { concept: "d.Link", content: { url: "/not/a/file" } } };
      expect(checkFileInputs(LINK, link)).toBeNull();
    });

    it("lets a plural text input through — an array is not by itself a file", () => {
      const PAGES = descriptor({
        ...top("pages", {
          kind: "list",
          concept_ref: "native.Text",
          item: { kind: "prose", concept_ref: "native.Text", required: true },
        }),
        gating: false,
      });
      const pages = { pages: { concept: "native.Text", content: [{ text: "first" }] } };
      expect(checkFileInputs(PAGES, pages)).toBeNull();
    });

    it("does not walk a value whose shape disagrees with its node", () => {
      // A self-referential payload under a `prose` node is never descended (the
      // walk follows the descriptor, which is finite), and an array where the
      // descriptor declares an object is left to the shape gate.
      const loop: Record<string, unknown> = { note: "hi" };
      loop.self = loop;
      const PROSE = descriptor(top("text", { kind: "prose", concept_ref: "native.Text" }));
      expect(
        checkFileInputs(PROSE, { text: { concept: "native.Text", content: loop } }),
      ).toBeNull();
    });

    it("refuses a present file position that holds neither a string nor {url}", () => {
      // Bytes or a shapeless object at a file position would either be uploaded
      // unchecked (the SDK uploads bytes as-is) or fail in the SDK with a typed
      // error; either way the verdict is this gate's, not the schema's in front.
      const blob = { document: { concept: "native.Document", content: new Uint8Array(4) } };
      expect(checkFileInputs(SINGLE, blob)?.details).toBe("unsupported_scheme: document");
      const shapeless = {
        document: { concept: "native.Document", content: { filename: "x.pdf" } },
      };
      expect(checkFileInputs(SINGLE, shapeless)?.details).toBe("unsupported_scheme: document");
    });

    it("passes an input the descriptor does not name through untouched", () => {
      // The shape gate in front drops undeclared inputs before this runs, and
      // the SDK copies one through without reading it; neither is a file.
      const stray = { stray: { concept: "native.Document", content: { url: "/etc/passwd" } } };
      expect(checkFileInputs(SINGLE, stray)).toBeNull();
    });
  });
});

describe("fileInputErrorToPipelineError", () => {
  it("maps file_too_large to a rendered PipelineError", () => {
    const result = fileInputErrorToPipelineError(
      { kind: "file_too_large", message: "File is 60 MB; the limit is 50 MB." },
      "big.pdf",
    );
    expect(result.kind).toBe("file_too_large");
    expect(result.title).toBe("File too large");
    expect(result.details).toContain("big.pdf");
  });

  it("maps unsupported_file_type and tolerates a missing filename", () => {
    const result = fileInputErrorToPipelineError(
      { kind: "unsupported_file_type", message: "Expected a PDF." },
      "",
    );
    expect(result.kind).toBe("unsupported_file_type");
    expect(result.title).toBe("Unsupported file type");
    expect(result.details).toContain("(no filename)");
  });

  it("titles an empty or nameless file as one that can't be uploaded, not as a wrong type", () => {
    const result = fileInputErrorToPipelineError(
      { kind: "invalid_file", message: "The file is empty." },
      "blank.pdf",
    );
    expect(result.kind).toBe("invalid_file");
    expect(result.title).toBe("File can't be uploaded");
    expect(result.message).toBe("The file is empty.");
  });
});
