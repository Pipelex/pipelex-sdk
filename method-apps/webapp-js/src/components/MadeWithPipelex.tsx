/** Where the credit leads. */
export const PIPELEX_URL = "https://pipelex.com";

/**
 * The discreet credit a branded app carries at the end of its page, since the
 * organization's logo takes its top: meta text, never a fixed bar. It opens
 * pipelex.com in a new tab, because the app owns its window and a same-tab
 * link clicked mid-run would leave it, and its accessible name says so.
 */
export function MadeWithPipelex() {
  return (
    <footer className="mt-12 text-[13px] text-muted-foreground">
      <a
        href={PIPELEX_URL}
        target="_blank"
        rel="noopener"
        className="underline-offset-4 hover:text-foreground hover:underline"
      >
        Made with Pipelex<span className="sr-only"> (opens in a new tab)</span>
      </a>
    </footer>
  );
}
