import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunTimelineProps } from "@pipelex/mthds-ui/timeline/react";
import { RunTimelineView } from "./RunTimelineView";
import { claimsMidRun, claimsPending } from "@/test/fixtures/runProgress";

// The real timeline, behind a wrapper that records what it was handed and can
// be told to fail, as a snapshot it cannot draw would make it.
const timeline = vi.hoisted(() => ({
  props: [] as RunTimelineProps[],
  failFor: null as string | null,
}));

vi.mock("@pipelex/mthds-ui/timeline/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pipelex/mthds-ui/timeline/react")>();
  function RunTimeline(props: RunTimelineProps) {
    timeline.props.push(props);
    if (props.snapshot.summary === timeline.failFor) throw new Error("cannot draw this snapshot");
    return <actual.RunTimeline {...props} />;
  }
  return { ...actual, RunTimeline };
});

afterEach(() => {
  timeline.props = [];
  timeline.failFor = null;
});

describe("RunTimelineView", () => {
  it("draws nothing without a snapshot, or with one that has no invocation yet", () => {
    const { container, rerender } = render(<RunTimelineView snapshot={null} live />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RunTimelineView snapshot={claimsPending()} live />);
    expect(container).toBeEmptyDOMElement();
    expect(timeline.props).toEqual([]);
  });

  it("draws the timeline, one row per invocation, once the snapshot has one", async () => {
    render(<RunTimelineView snapshot={claimsMidRun()} live />);
    const region = await screen.findByRole("region", { name: "Run progress" });
    expect(region).toHaveTextContent("Running check_each_claim (step 2 of 4)");
    expect(region).toHaveTextContent("split_claims");
    expect(region).toHaveTextContent("check_each_claim");
  });

  it("hands the timeline the light theme, the gallery's palette and the host's live flag", async () => {
    const { rerender } = render(<RunTimelineView snapshot={claimsMidRun()} live />);
    await screen.findByRole("region", { name: "Run progress" });
    expect(timeline.props.at(-1)).toMatchObject({
      theme: "light",
      live: true,
      paletteColors: expect.objectContaining({
        "--surface-panel": "var(--background)",
        "--border-default": "var(--border)",
        "--text-primary": "var(--foreground)",
        "--text-muted": "var(--muted-foreground)",
      }),
    });
    // The status colours stay the timeline's own.
    expect(Object.keys(timeline.props.at(-1)?.paletteColors ?? {})).not.toContain(
      "--color-success",
    );

    rerender(<RunTimelineView snapshot={claimsMidRun()} live={false} />);
    expect(timeline.props.at(-1)?.live).toBe(false);
  });

  it("takes down only the timeline when it cannot draw a snapshot, and tries the next one", async () => {
    // React reports what a boundary caught; keep it out of the test's output.
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...claimsMidRun(), summary: "a snapshot the timeline cannot draw" };
    timeline.failFor = broken.summary;
    const { rerender } = render(
      <div>
        <p>The status card</p>
        <RunTimelineView snapshot={broken} live />
      </div>,
    );
    await vi.waitFor(() => expect(timeline.props.length).toBeGreaterThan(0));
    expect(screen.getByText("The status card")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Run progress" })).not.toBeInTheDocument();

    rerender(
      <div>
        <p>The status card</p>
        <RunTimelineView snapshot={claimsMidRun(undefined, 8)} live />
      </div>,
    );
    expect(await screen.findByRole("region", { name: "Run progress" })).toBeInTheDocument();
    reported.mockRestore();
  });
});
