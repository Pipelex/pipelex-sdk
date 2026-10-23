"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BandLogo } from "@/lib/branding";

interface BrandBandProps {
  /** The organization's name: the logo's alt text, and the wordmark when no logo loads. */
  orgName: string;
  /** The logos to try, in order: the wide one, then the square one. */
  logos: readonly BandLogo[];
  /** Whether the logo sits on a white tile in the dark theme (no header colour in dark). */
  tileInDark: boolean;
}

/**
 * The organization's band across the top of a branded app: the page's
 * `header` landmark, edge to edge and 56 px tall at every width, painted with
 * the header colour (`--app-header`, the page colour when none is set, so no
 * band shows), with the organization's logo centred on it both ways.
 *
 * The logo falls back in a fixed order: the wide logo, then the square one,
 * then the organization's name as a wordmark, 18 px and semibold on one line
 * cut with an ellipsis. A logo that fails to load moves to the next one, so no
 * broken image is left on the band, and each logo's box is sized from the
 * shape the platform recorded, so the band does not shift when it arrives. A
 * logo is at most 28 px tall below 768 px and 32 px from there, never wider
 * than the band, and always fitted inside its box, never cropped or stretched.
 *
 * In the dark theme with no header colour the band is the dark page, so the
 * logo sits on a small white rounded tile: most logos are drawn for white.
 * With a header colour it sits on that colour in both themes, undecorated.
 *
 * A client component only for the fallback, which listens to each image.
 */
export function BrandBand({ orgName, logos, tileInDark }: BrandBandProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const logo = logos.find((candidate) => !failed.has(candidate.src));
  const image = useRef<HTMLImageElement>(null);

  const fail = useCallback((src: string) => {
    setFailed((previous) => (previous.has(src) ? previous : new Set(previous).add(src)));
  }, []);

  // An image that failed before the page hydrated fired its error before React
  // listened, so a logo already complete is decoded once more: a broken one
  // rejects, and the band moves on. One that is still loading reports through
  // `onError` like any other.
  useEffect(() => {
    const element = image.current;
    if (logo === undefined || element === null || !element.complete) return;
    if (typeof element.decode !== "function") return;
    let current = true;
    element.decode().catch(() => {
      if (current) fail(logo.src);
    });
    return () => {
      current = false;
    };
  }, [logo, fail]);

  return (
    <header className="flex h-14 w-full items-center justify-center bg-app-header px-4 text-app-header-foreground lg:px-6">
      {logo !== undefined ? (
        <span
          className={
            tileInDark
              ? "flex min-w-0 max-w-full dark:rounded dark:bg-white dark:p-1.5"
              : "flex min-w-0 max-w-full"
          }
        >
          {/* A plain <img>, not next/image: the route already serves the logo
              as the organization uploaded it, and re-encoding a brand mark,
              an SVG above all, is not this app's to do. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={logo.src}
            ref={image}
            src={logo.src}
            alt={orgName}
            width={logo.width}
            height={logo.height}
            onError={() => fail(logo.src)}
            className="block h-7 w-auto max-w-full object-contain md:h-8"
          />
        </span>
      ) : (
        <span className="min-w-0 truncate text-lg font-semibold">{orgName}</span>
      )}
    </header>
  );
}
