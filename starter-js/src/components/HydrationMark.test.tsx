import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { HYDRATED_ATTRIBUTE, HydrationMark } from "./HydrationMark";

afterEach(() => document.documentElement.removeAttribute(HYDRATED_ATTRIBUTE));

describe("HydrationMark", () => {
  it("marks the document once it has mounted, and renders nothing", () => {
    expect(document.documentElement.hasAttribute(HYDRATED_ATTRIBUTE)).toBe(false);
    const { container } = render(<HydrationMark />);
    expect(document.documentElement.hasAttribute(HYDRATED_ATTRIBUTE)).toBe(true);
    expect(container).toBeEmptyDOMElement();
  });
});
