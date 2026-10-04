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
 *  - Development builds, where React emits the full text. Most of it contains
 *    the substring "hydrat" ("Hydration failed because the server rendered
 *    ...", "Recovered from a hydration error ..."), but the text-content
 *    mismatch (#425) does NOT — it reads "Text content does not match
 *    server-rendered HTML" — so it needs its own pattern,
 *    {@link DEV_TEXT_MISMATCH}. Without that pattern the dev-mode path
 *    silently missed the single most common mismatch.
 *  - Production builds, where the same failures are minified to
 *    "Minified React error #418" / "#423" / "#425". The code list below is
 *    the hydration family from React's own scripts/error-codes/codes.json.
 *
 * A bare `#NNN` is NOT accepted: the numbered form is honoured only behind
 * React's own {@link MINIFIED_REACT_ERROR} prefix or the accompanying
 * react.dev/errors/<code> link. Accepting any `error #NNN` made an unrelated
 * `POST /api 500 (error #418)` fail the suite.
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

/**
 * React's production-build prefix: "Minified React error #418; visit
 * https://react.dev/errors/418?invariant_id=418 for more information."
 */
const MINIFIED_REACT_ERROR = /minified react error #?(\d{3})\b/i;

/**
 * The documentation link React appends to the same message. Accepted as an
 * equivalent, because it carries the same code and is just as unambiguous.
 */
const REACT_ERROR_LINK = /react\.dev\/errors\/(\d{3})\b/i;

/**
 * React's development-build text for #425 — "Text content does not match
 * server-rendered HTML." The one hydration-family message with no "hydrat" in
 * it, so `/hydrat/i` alone cannot see it.
 */
const DEV_TEXT_MISMATCH = /text content (?:does not|did not) match/i;

export function isHydrationError(text: string): boolean {
  if (/hydrat/i.test(text)) return true;
  if (DEV_TEXT_MISMATCH.test(text)) return true;
  const match = MINIFIED_REACT_ERROR.exec(text) ?? REACT_ERROR_LINK.exec(text);
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
