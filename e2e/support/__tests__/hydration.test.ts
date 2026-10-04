/**
 * Negative controls for the e2e hydration matcher (`../hydration.ts`).
 *
 * Two review findings are pinned here, and BOTH are of the same shape: the
 * matcher made a claim about coverage that the code did not deliver.
 *
 *  - Finding 1: the doc comment claimed development-mode coverage, but
 *    `/hydrat/i` cannot see React's dev text for #425 ("Text content does not
 *    match server-rendered HTML") — no "hydrat" anywhere in it.
 *  - Finding 2: `/(?:error\s*)#?(\d{3})\b/i` accepted ANY `#NNN`, so an unrelated
 *    `POST /api 500 (error #418)` was reported as a hydration failure.
 *
 * HOW TO READ THIS FILE. Every `expect(...).toBe(false)` here is a claim that a
 * real regression would break. To prove these controls are not vacuous, revert
 * the corresponding line in `../hydration.ts` and re-run this file — the named
 * test must FAIL. That revert-then-fail demonstration is the deliverable; a
 * green run of this file on its own proves nothing about the fix.
 */
import { describe, expect, it } from "vitest";

import { collectHydrationErrors, isHydrationError } from "../hydration";

/**
 * Verbatim-ish React 19 production message. React appends the docs link with an
 * `?invariant_id=` query, so the code appears twice — the matcher must key off
 * the `Minified React error` prefix, not off a bare `#NNN`.
 */
const MINIFIED_418 =
  "Minified React error #418; visit https://react.dev/errors/418?invariant_id=418 for more information.";

describe("isHydrationError: accepts the React hydration family", () => {
  it("accepts the development-mode text that does contain 'hydrat'", () => {
    expect(
      isHydrationError(
        "Hydration failed because the server rendered HTML didn't match the client.",
      ),
    ).toBe(true);
    expect(
      isHydrationError(
        "There was an error while hydrating. Because the error happened outside of a Suspense boundary, the entire root will switch to client rendering.",
      ),
    ).toBe(true);
  });

  it("accepts the minified production codes #418-#425", () => {
    for (const code of ["418", "421", "422", "423", "424", "425"]) {
      expect(
        isHydrationError(
          `Minified React error #${code}; visit https://react.dev/errors/${code}?invariant_id=${code} for more information.`,
        ),
        `#${code}`,
      ).toBe(true);
    }
  });

  it("accepts the react.dev/errors/<code> link on its own", () => {
    expect(
      isHydrationError("https://react.dev/errors/418?invariant_id=418"),
    ).toBe(true);
  });
});

/**
 * FINDING 1 — negative control.
 *
 * React's dev-mode text for #425. It is the hydration family's most common
 * message and it contains NO occurrence of "hydrat", so the pre-fix
 * `/hydrat/i`-only matcher returned false here and a real mismatch passed green.
 */
describe("FINDING 1: development-mode text mismatch with no 'hydrat' substring", () => {
  it("rejects nothing: the dev text mismatch IS a hydration error", () => {
    // The two spellings React uses across versions.
    expect(
      isHydrationError(
        "Warning: Text content does not match server-rendered HTML.",
      ),
    ).toBe(true);
    expect(
      isHydrationError(
        "Warning: Text content did not match server-rendered HTML.",
      ),
    ).toBe(true);
  });

  it("the control is non-vacuous: this text genuinely contains no 'hydrat'", () => {
    // If React ever rewords the message to include "hydrat", this test is the
    // thing that should be looked at — the control above would then be passing
    // for the wrong reason.
    expect(
      /hydrat/i.test("Text content does not match server-rendered HTML"),
    ).toBe(false);
  });

  it("still rejects prose that is about text but not a mismatch", () => {
    expect(
      isHydrationError(
        "expected the text content to match, updating the label",
      ),
    ).toBe(false);
    expect(
      isHydrationError("The text content of this page does not exist"),
    ).toBe(false);
  });
});

/**
 * FINDING 2 — negative control.
 *
 * The exact false positive from the review, plus the near neighbours a looser
 * implementation would also swallow. Before the fix the bare-number regex
 * matched every one of these as a hydration failure.
 */
describe("FINDING 2: an unrelated `error #NNN` is not a hydration failure", () => {
  it("is false for the review's counterexample", () => {
    expect(isHydrationError("POST /api 500 (error #418)")).toBe(false);
  });

  it("is true only for the same code behind React's prefix", () => {
    expect(isHydrationError("Minified React error #418")).toBe(true);
  });

  it("rejects other hydration-family codes reached without React's prefix", () => {
    // Every code in HYDRATION_CODES, addressed the wrong way. This is the whole
    // point: the code alone must never be enough, or the guard is a
    // `#NNN`-sniffing machine that any application log can trip.
    for (const code of ["418", "421", "422", "423", "424", "425"]) {
      expect(
        isHydrationError(`GET /api/users failed (error #${code})`),
        code,
      ).toBe(false);
      expect(isHydrationError(`upstream timeout, error #${code}`), code).toBe(
        false,
      );
      expect(isHydrationError(`Error: ECONNRESET (error #${code})`), code).toBe(
        false,
      );
    }
  });

  it("rejects a hydration code used as an HTTP-ish or request id", () => {
    expect(isHydrationError("request failed with status 425")).toBe(false);
    expect(isHydrationError("trace id 418")).toBe(false);
    expect(isHydrationError("line 425 of the bundle")).toBe(false);
  });

  it("accepts the full React message even with the docs link appended", () => {
    expect(isHydrationError(MINIFIED_418)).toBe(true);
  });
});

describe("collectHydrationErrors: filters what it stores", () => {
  /** Minimal stand-in for the Playwright Page surface this helper uses. */
  function fakePage() {
    const listeners: Record<string, Array<(arg: unknown) => void>> = {};
    return {
      on(event: string, handler: (arg: unknown) => void) {
        (listeners[event] ??= []).push(handler);
      },
      emitConsole(type: string, text: string) {
        // Playwright's ConsoleMessage exposes `type()` and `text()` as METHODS,
        // so the fake must too — a plain `{ type, text }` would pass a
        // structurally-typed cast and then fail at runtime, which is exactly the
        // kind of fake that makes a control dishonest.
        const message = { type: () => type, text: () => text };
        for (const handler of listeners["console"] ?? []) {
          handler(message);
        }
      },
      emitPageError(message: string) {
        for (const handler of listeners["pageerror"] ?? []) {
          handler(new Error(message));
        }
      },
    };
  }

  it("records a real minified mismatch and ignores an unrelated error code", () => {
    const page = fakePage();
    const errors = collectHydrationErrors(
      page as unknown as Parameters<typeof collectHydrationErrors>[0],
    );

    page.emitConsole("error", "POST /api 500 (error #418)");
    page.emitConsole("error", "some unrelated console error");
    page.emitConsole("error", MINIFIED_418);

    expect(errors).toEqual([MINIFIED_418]);
  });

  it("records a page error only when it is a hydration failure", () => {
    const page = fakePage();
    const errors = collectHydrationErrors(
      page as unknown as Parameters<typeof collectHydrationErrors>[0],
    );

    page.emitPageError("TypeError: cannot read properties of undefined");
    page.emitPageError("Hydration failed because the server rendered text");

    expect(errors).toEqual([
      "Hydration failed because the server rendered text",
    ]);
  });

  it("ignores non-error console levels entirely", () => {
    // A `warning`-level hydration message is not a failure we want to fail on,
    // and must not land in the collected list.
    for (const type of ["warning", "log", "debug"]) {
      const page = fakePage();
      const errors = collectHydrationErrors(
        page as unknown as Parameters<typeof collectHydrationErrors>[0],
      );

      page.emitConsole(type, MINIFIED_418);

      expect(errors, type).toEqual([]);
    }
  });
});
