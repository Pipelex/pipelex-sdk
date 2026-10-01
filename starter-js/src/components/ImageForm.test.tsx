import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ImageForm } from "./ImageForm";
import {
  pollGenerateImageRun,
  runGenerateImageBlocking,
  startGenerateImageRun,
} from "@/actions/runGenerateImagePipeline";

vi.mock("@/actions/runGenerateImagePipeline", () => ({
  runGenerateImageBlocking: vi.fn(),
  startGenerateImageRun: vi.fn(),
  pollGenerateImageRun: vi.fn(),
}));

const blocking = vi.mocked(runGenerateImageBlocking);
const start = vi.mocked(startGenerateImageRun);
const poll = vi.mocked(pollGenerateImageRun);

beforeEach(() => {
  vi.useFakeTimers();
  blocking.mockReset();
  start.mockReset();
  poll.mockReset();
});
afterEach(() => vi.useRealTimers());

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function submitForm() {
  const form = screen.getByRole("button", { name: /generate image/i }).closest("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

const IMAGE = {
  url: "https://cdn.example/x.png",
  mime_type: "image/png",
};
const USAGE = {
  calls: [
    {
      modelName: "gpt-image-1-mini",
      modelType: "img_gen",
      pipeCode: "generate_image",
      tokensByCategory: null,
      costUsd: 0.02,
    },
  ],
  totalCostUsd: 0.02,
  hasCost: true,
  state: "records" as const,
  assemblyError: null,
};

describe("ImageForm", () => {
  it("durable mode (default): renders the generated image", async () => {
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll.mockResolvedValueOnce({ ok: true, state: "completed", output: IMAGE, usage: USAGE });

    render(<ImageForm />);
    submitForm();

    await flush();
    // The kernel's image arm paints the file with no storage resolver
    // configured, which is why this template renders a hosted image without
    // wiring `<ResultEnvProvider>`. This payload carries only `url`, so it is
    // the fallback arm; the preference itself is the next test.
    expect(screen.getByRole("img")).toHaveAttribute("src", IMAGE.url);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The action receives the schema-shaped dict, keyed by the contract's own
    // input name. Two slips this catches and nothing else does: sending the
    // raw run-values instead of `toData()`, and seeding under a key the
    // contract does not declare (which ships an empty box and a dead Run
    // button — every other test here submits the form element directly, so a
    // disabled button never fails them).
    expect(start).toHaveBeenCalledWith({
      image_prompt: { text: expect.stringContaining("friendly robot") },
    });
  });

  it("paints the signed public_url, not the storage reference beside it", async () => {
    // The one kernel behaviour this template's docs promise outright — "every
    // file these examples produce paints unaided". It is true only because the
    // file arm prefers `public_url`, and a hosted run returns a `pipelex-storage://`
    // URI as `url`, which resolves nowhere in a browser. Without this case a
    // dependency bump could reverse the preference and every image would go
    // blank with `make all` still green.
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll.mockResolvedValueOnce({
      ok: true,
      state: "completed",
      output: {
        url: "pipelex-storage://org/assets/abc.bin",
        public_url: "https://cdn.example/pub.png",
        mime_type: "image/png",
      },
      usage: USAGE,
    });

    render(<ImageForm />);
    submitForm();

    await flush();
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://cdn.example/pub.png");
  });

  it("seeds the prompt under the contract's declared input name", () => {
    render(<ImageForm />);
    const box = screen.getByRole("textbox", { name: /image prompt/i });
    expect((box as HTMLTextAreaElement | HTMLInputElement).value).toContain("friendly robot");
    expect(screen.getByRole("button", { name: /generate image/i })).toBeEnabled();
  });

  it("blocking mode demonstrates the ~30s cap (execute_timeout error)", async () => {
    blocking.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "execute_timeout",
        title: "Pipeline exceeded the ~30s blocking limit",
        message: "The blocking request ran for ~30s before the hosted gateway cut it off.",
        hint: { summary: "Switch this example to Durable mode." },
        details: "PipelineExecuteTimeoutError",
      },
    });

    render(<ImageForm />);
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    submitForm();

    await flush();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/exceeded the ~30s/i)).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it("surfaces a transport_error when the awaited blocking action rejects", async () => {
    blocking.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<ImageForm />);
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    submitForm();

    await flush();
    expect(screen.getByText(/Could not reach the server/i)).toBeInTheDocument();
    expect(screen.getByText(/Failed to fetch/i)).toBeInTheDocument();
  });
});
