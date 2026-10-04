import type { Page } from "@playwright/test";

/**
 * Detects React hydration failures from a console message or page error.
 *
 * The harness runs against a PRODUCTION build (`bun run start`), where React's
 * error messages are minified to numbered codes — the literal word
 * "hydration" never reaches the console. A `/hydrat/i` filter therefore
 * matches nothing in the mode we actually run, and a page can be
 * mis-hydrating while the suite reports green.
 *
 * So we match both forms:
 *
 *  - Development builds, where React emits the full text
 *    ("Hydration failed because the server rendered ...", "Text content does
 *    not match server-rendered HTML").
 *  - Production builds, where the same failures are minified to
 *    "Minified React error #418" / "#423" / "#425". The code list below is
 *    the hydration family from React's own scripts/error-codes/codes.json.
 *
 * If a future React renumbers these, the negative control in the T7 handoff
 * (inject a server/client mismatch, confirm the spec goes red) is the thing
 * that will catch it — not this file's comments.
 */
const HYDRATION_CODES = new Set([
  "418", // Hydration failed because the server rendered %s didn't match
  "421", // Suspense boundary updated before it finished hydrating
  "422", // Recovered from a hydration error by client rendering the boundary
  "423", // Recovered from a hydration error by client rendering the root
  "424", // Root received an early update before anything could hydrate
  "425", // Text content does not match server-rendered HTML
]);

export function isHydrationError(text: string): boolean {
  if (/hydrat/i.test(text)) return true;
  // "Minified React error #418" — also matches the react.dev/errors/418 link.
  const match = /(?:error\s*)#?(\d{3})\b/i.exec(text);
  return match !== null && HYDRATION_CODES.has(match[1]!);
}

/**
 * Records every console error and page error that looks like a hydration
 * failure. Attach the listeners BEFORE the first navigation — a mismatch is
 * reported during hydration of the initial document, so a listener added
 * afterwards misses it entirely.
 */
export function collectHydrationErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && isHydrationError(message.text())) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (isHydrationError(error.message)) {
      errors.push(error.message);
    }
  });
  return errors;
}
