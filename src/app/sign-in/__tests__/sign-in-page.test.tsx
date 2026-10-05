/**
 * Tests for the sign-in page (T20) — c1, c2 and the c5 configuration case.
 *
 * `requireSession` is mocked, because the property under test is the PAGE's
 * three-way classification of the guard's answers and what it renders in each
 * case. The guard's own behaviour — including that it distinguishes a missing
 * secret from a missing session — is B46's suite's contract
 * (`src/lib/__tests__/session-guard.test.ts`) and re-testing it here would
 * assert nothing about this page. What IS asserted here is that the page never
 * collapses those two answers into one, which is a property of the page.
 *
 * The `DEVLOOP_ALLOW_SIGN_UP` tests are the c2 real gate: sign-up must be
 * unreachable without an explicit, deliberate flag.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session-guard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireSession: vi.fn(),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => redirect(destination),
}));

const { requireSession } = await import("@/lib/session-guard");
const { default: SignInPage } = await import("../page");
const { ALLOW_SIGN_UP_ENV_VAR } = await import("@/app/auth/sign-up-flag");

const mockedRequireSession = vi.mocked(requireSession);

const ORIGINAL_FLAG = process.env[ALLOW_SIGN_UP_ENV_VAR];

const NO_SESSION_REFUSAL = {
  ok: false as const,
  outcome: "session_required" as const,
  status: 401 as const,
  body: {
    ok: false as const,
    outcome: "session_required" as const,
    message: "No valid session. Sign in first.",
    fetched: 0 as const,
    persisted: 0 as const,
  },
};

const UNCONFIGURED_REFUSAL = {
  ok: false as const,
  outcome: "auth_not_configured" as const,
  status: 503 as const,
  body: {
    ok: false as const,
    outcome: "auth_not_configured" as const,
    message: "BETTER_AUTH_SECRET is not set.",
    fetched: 0 as const,
    persisted: 0 as const,
  },
};

const AUTHENTICATED = {
  ok: true as const,
  outcome: "authenticated" as const,
  session: {
    session: {
      id: "session-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      token: "not-a-real-token",
      userId: "user-1",
    },
    user: {
      id: "user-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      emailVerified: false,
      name: "Local User",
      email: "local@example.invalid",
    },
  },
};

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[ALLOW_SIGN_UP_ENV_VAR];
  else process.env[ALLOW_SIGN_UP_ENV_VAR] = ORIGINAL_FLAG;
  vi.clearAllMocks();
});

async function render(): Promise<string> {
  try {
    return await renderToStaticMarkup(await SignInPage());
  } catch (error) {
    if (redirect.mock.calls.length > 0) return "";
    throw error;
  }
}

describe("sign-in page — signed out (c1)", () => {
  it("renders an email and password form", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    const html = await render();

    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
  });

  it("does not redirect a signed-out visitor — this is where it belongs", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    await render();

    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders both credential fields EMPTY, never prefilled", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    const html = await render();

    // Precisely, rather than the `not.toContain("value=")` this started as:
    // MEASURED, React emits `value=""` for a CONTROLLED input, so the original
    // assertion failed on a page that had prefilled nothing. The property worth
    // having is that every value attribute on the document is empty — a
    // server-rendered credential or a remembered email would both break it.
    const values = [...html.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBe("");
    }
  });
});

describe("sign-in page — already signed in (c1)", () => {
  it("redirects a signed-in visitor onward instead of showing the form", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);

    const html = await render();

    expect(redirect).toHaveBeenCalledWith("/evidence");
    expect(html).not.toContain('type="password"');
  });
});

describe("sign-in page — auth not configured (D-285)", () => {
  it("names the configuration fault instead of rendering a form that cannot work", async () => {
    mockedRequireSession.mockResolvedValue(UNCONFIGURED_REFUSAL);

    const html = await render();

    expect(html).toContain("auth is not configured");
    expect(html).toContain("BETTER_AUTH_SECRET");
    // The critical negative: no form at all. A developer with a broken .env who
    // is shown a sign-in form will sit there filling it in forever.
    expect(html).not.toContain('type="password"');
  });

  it("does not redirect on a misconfiguration", async () => {
    mockedRequireSession.mockResolvedValue(UNCONFIGURED_REFUSAL);

    await render();

    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("sign-in page — sign-up flag (c2)", () => {
  it("offers NO sign-up when the flag is unset", async () => {
    delete process.env[ALLOW_SIGN_UP_ENV_VAR];
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    const html = await render();

    expect(html).not.toContain("Sign up");
  });

  it("offers NO sign-up when the flag is set to anything but exactly 1", async () => {
    // The single-account promise (D2) must not rest on "the operator set a
    // truthy value" — it must rest on a value nobody could set by accident. So
    // `true`, `yes` and an empty string all mean OFF.
    for (const value of ["true", "yes", "", "0", "11", " 1"]) {
      process.env[ALLOW_SIGN_UP_ENV_VAR] = value;
      mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

      const html = await render();

      expect(
        html,
        `flag=${JSON.stringify(value)} must NOT enable sign-up`,
      ).not.toContain("Sign up");
    }
  });

  it("offers sign-up when the flag is exactly 1", async () => {
    process.env[ALLOW_SIGN_UP_ENV_VAR] = "1";
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    const html = await render();

    expect(html).toContain("Sign up");
    // The page must also say WHY it is showing this, so a deployed instance is
    // never quietly offering second accounts to whoever finds the flag.
    expect(html).toContain("DEVLOOP_ALLOW_SIGN_UP");
  });
});
