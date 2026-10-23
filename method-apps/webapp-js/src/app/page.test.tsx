import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SITE } from "@/site";

// The page asks for a request before it reads; there is none in a test.
vi.mock("next/server", () => ({ connection: () => Promise.resolve() }));

// The SDK's constructor throws on a misconfigured base URL, such as one with a path.
vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => {
    throw new Error("the base URL must be an origin, without a path");
  },
}));

vi.mock("@/methods", () => ({
  METHODS: [{ id: "registered", label: "Registered", Component: () => <form aria-label="Form" /> }],
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the page", () => {
  it("renders unbranded, never fails, when the client cannot be built", async () => {
    vi.stubEnv("PIPELEX_API_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { default: Home } = await import("./page");

    const { container } = render(await Home());

    expect(screen.getByRole("heading", { level: 1, name: SITE.title })).toBeVisible();
    expect(screen.getByRole("form", { name: "Form" })).toBeInTheDocument();
    expect(container.querySelector("style")).toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
