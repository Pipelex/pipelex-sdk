import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppPage } from "./AppPage";
import { brandingFromApi } from "@/lib/branding";
import { SITE } from "@/site";
import { BRANDED, UNBRANDED, WIDE_LOGO, branding } from "@/test/fixtures/branding";

// The page's registry is replaced by one stand-in, so the page renders without
// importing a method's form and Server Actions.
vi.mock("@/methods", () => ({
  METHODS: [{ id: "registered", label: "Registered", Component: () => <form aria-label="Form" /> }],
}));

function brandStyle(container: HTMLElement): HTMLStyleElement | null {
  return container.querySelector("style");
}

/**
 * The page's banner landmark. A `<header>` inside `<main>` is no landmark in a
 * browser's accessibility tree, but Testing Library maps every `<header>` to
 * `banner`, so the app's own heading block is told apart by that rule here.
 */
function band(): HTMLElement | null {
  return screen.queryAllByRole("banner").find((header) => header.closest("main") === null) ?? null;
}

describe("AppPage", () => {
  it("renders an unbranded app exactly as before: no band, no colours, no credit", () => {
    const { container } = render(<AppPage branding={brandingFromApi(UNBRANDED)} />);
    expect(screen.getByRole("heading", { level: 1, name: SITE.title })).toBeVisible();
    expect(screen.getByRole("form", { name: "Form" })).toBeInTheDocument();
    expect(band()).toBeNull();
    expect(screen.queryByRole("link", { name: /Made with Pipelex/ })).not.toBeInTheDocument();
    expect(brandStyle(container)).toBeNull();
  });

  it("renders a failed read unbranded", () => {
    const { container } = render(<AppPage branding={brandingFromApi(null)} />);
    expect(band()).toBeNull();
    expect(brandStyle(container)).toBeNull();
  });

  it("wears a branded team's band above the app's own heading", () => {
    render(<AppPage branding={brandingFromApi(BRANDED)} />);
    const banner = band()!;
    expect(banner).not.toBeNull();
    expect(screen.getByRole("img", { name: "Acme Corporation" })).toHaveAttribute(
      "src",
      `/api/branding/logo/${WIDE_LOGO.sha256}`,
    );
    const heading = screen.getByRole("heading", { level: 1, name: SITE.title });
    expect(banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sets the colours at the document's root, light under :root and dark under .dark", () => {
    const { container } = render(<AppPage branding={brandingFromApi(BRANDED)} />);
    const sheet = brandStyle(container)?.textContent ?? "";
    expect(sheet).toMatch(/^:root\{[^}]*--primary:#14213d;/m);
    expect(sheet).toMatch(/^\.dark\{[^}]*--app-header:#14213d;/m);
  });

  it("keeps the template's colours for a team that set logos and no colour", () => {
    const { container } = render(
      <AppPage branding={brandingFromApi(branding({ wide_logo: WIDE_LOGO }))} />,
    );
    expect(band()).not.toBeNull();
    expect(brandStyle(container)).toBeNull();
  });

  it("credits Pipelex at the end of the page, opening pipelex.com in a new tab", () => {
    render(<AppPage branding={brandingFromApi(branding({ wide_logo: WIDE_LOGO }))} />);
    const credit = screen.getByRole("link", { name: "Made with Pipelex (opens in a new tab)" });
    expect(credit).toHaveAttribute("href", "https://pipelex.com");
    expect(credit).toHaveAttribute("target", "_blank");
    expect(credit.getAttribute("rel")?.split(" ")).toContain("noopener");
    // Inside the page, after the methods: meta text, never a fixed bar.
    expect(screen.getByRole("main")).toContainElement(credit);
    expect(credit.closest("footer")).toHaveClass("text-muted-foreground");
  });
});
