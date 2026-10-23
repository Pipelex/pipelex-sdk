import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BrandBand } from "./BrandBand";
import type { BandLogo } from "@/lib/branding";

const WIDE: BandLogo = { src: "/api/branding/logo/wide", width: 400, height: 100 };
const SQUARE: BandLogo = { src: "/api/branding/logo/square", width: 100, height: 100 };

describe("BrandBand", () => {
  it("is the page's banner, with the wide logo named after the organization", () => {
    render(<BrandBand orgName="Acme" logos={[WIDE, SQUARE]} tileInDark={false} />);
    const banner = screen.getByRole("banner");
    const logo = screen.getByRole("img", { name: "Acme" });
    expect(banner).toContainElement(logo);
    expect(logo).toHaveAttribute("src", WIDE.src);
    // The box is sized from the recorded shape, so the band does not shift on load.
    expect(logo).toHaveAttribute("width", "400");
    expect(logo).toHaveAttribute("height", "100");
  });

  it("falls to the square logo, then to the name, as each logo fails to load", () => {
    render(<BrandBand orgName="Acme" logos={[WIDE, SQUARE]} tileInDark={false} />);
    fireEvent.error(screen.getByRole("img", { name: "Acme" }));
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute("src", SQUARE.src);

    fireEvent.error(screen.getByRole("img", { name: "Acme" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent("Acme");
  });

  it("sets the name as a one-line wordmark when there is no logo", () => {
    render(
      <BrandBand orgName="A very long organization name that will not fit" logos={[]} tileInDark />,
    );
    const wordmark = screen.getByText("A very long organization name that will not fit");
    expect(wordmark).toHaveClass("truncate", "text-lg", "font-semibold");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("puts the logo on a white tile in the dark theme only when asked", () => {
    const { rerender } = render(<BrandBand orgName="Acme" logos={[WIDE]} tileInDark />);
    const tile = () => screen.getByRole("img", { name: "Acme" }).parentElement!;
    expect(tile()).toHaveClass("dark:bg-white", "dark:rounded", "dark:p-1.5");
    // Never in light: the tile is a dark-variant class alone.
    expect(tile().className).not.toMatch(/(?:^|\s)bg-white/);

    rerender(<BrandBand orgName="Acme" logos={[WIDE]} tileInDark={false} />);
    expect(tile().className).not.toContain("bg-white");
  });

  it("paints the band with the header tokens", () => {
    render(<BrandBand orgName="Acme" logos={[]} tileInDark={false} />);
    expect(screen.getByRole("banner")).toHaveClass(
      "h-14",
      "bg-app-header",
      "text-app-header-foreground",
    );
  });
});
