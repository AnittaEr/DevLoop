/**
 * Tests for the sign-in / sign-up form island (T20) — c1's "goes through the
 * library" half.
 *
 * THE PROPERTY BEING TESTED IS THE SUBMISSION PATH, NOT THE FORM. c1 requires
 * the form to go through `better-auth/client`'s `createAuthClient` and the
 * mounted `/api/auth/*` endpoints, and explicitly forbids re-implementing
 * credential checking, hashing or session cookie writing locally. A test that
 * rendered the form and checked the inputs exist would pass against a hand-rolled
 * `fetch("/api/login")` with a hand-rolled SHA-256 in it — which is precisely
 * the implementation c1 forbids.
 *
 * So `better-auth/client` is MOCKED here and every test asserts which library
 * method was called, with which body, and that nothing else was. The mock is the
 * assertion: if the island ever stopped using `signIn.email` and started posting
 * credentials somewhere of its own, these go red.
 *
 * The complementary structural half — that this file imports no hashing and
 * writes no cookie — is asserted by reading this island's source as text, since
 * "does not contain crypto" is not something a behavioural mock can see.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInEmail = vi.fn();
const signUpEmail = vi.fn();
const signOut = vi.fn();

vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({
    signIn: { email: signInEmail },
    signUp: { email: signUpEmail },
    signOut,
  }),
}));

/** Records what the island tried to navigate to, so no test needs a real browser. */
const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

const { AuthForm } = await import("@/app/auth/auth-form");

/** The email and password used throughout. A throwaway, never a real credential. */
const EMAIL = "local@example.invalid";
const PASSWORD = "not-a-real-password";

describe("AuthForm — sign-in goes through better-auth/client (c1)", () => {
  it("calls signIn.email with exactly the credentials entered", async () => {
    signInEmail.mockResolvedValue({ data: { user: {} }, error: null });
    const user = userEvent.setup();
    render(<AuthForm allowSignUp={false} />);

    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(signInEmail).toHaveBeenCalledWith({
        email: EMAIL,
        password: PASSWORD,
      });
    });
  });

  it("navigates to /evidence on success, by full page load", async () => {
    // A full navigation, so the SERVER re-evaluates the guard. A client-side
    // push would render the destination from the cached bundle instead.
    signInEmail.mockResolvedValue({ data: { user: {} }, error: null });
    const user = userEvent.setup();
    render(<AuthForm allowSignUp={false} />);

    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/evidence");
    });
  });

  it("shows fixed text and never the library's error body when sign-in fails", async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { message: "Invalid email or password for hunter2@example.com" },
    });
    const user = userEvent.setup();
    render(<AuthForm allowSignUp={false} />);

    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-message")).toBeVisible();
    });
    // A library error can echo submitted values back; none of it is rendered.
    expect(screen.getByTestId("auth-message").textContent).not.toContain(
      "hunter2",
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not navigate when the call throws", async () => {
    signInEmail.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(<AuthForm allowSignUp={false} />);

    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-message")).toBeVisible();
    });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("AuthForm — sign-up is gated on the explicit prop (c2)", () => {
  it("renders no sign-up form at all when not allowed", () => {
    render(<AuthForm allowSignUp={false} />);

    expect(screen.queryByRole("button", { name: "Sign up" })).toBeNull();
  });

  it("submits through signUp.email when allowed", async () => {
    signUpEmail.mockResolvedValue({ data: { user: {} }, error: null });
    const user = userEvent.setup();
    render(<AuthForm allowSignUp />);

    await user.type(screen.getByLabelText("Email"), EMAIL);
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.type(screen.getByLabelText("Name"), "Local User");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => {
      expect(signUpEmail).toHaveBeenCalledWith({
        email: EMAIL,
        password: PASSWORD,
        name: "Local User",
      });
    });
    // A credential must not reach the OTHER endpoint by accident.
    expect(signInEmail).not.toHaveBeenCalled();
  });
});

describe("AuthForm — sign-out goes through the library", () => {
  it("calls signOut and returns to the sign-in page", async () => {
    signOut.mockResolvedValue({ data: { success: true }, error: null });
    const user = userEvent.setup();
    render(<AuthForm allowSignUp={false} />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
    });
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });

  it("reports a failed sign-out without navigating away", async () => {
    signOut.mockResolvedValue({ data: null, error: { message: "nope" } });
    const user = userEvent.setup();
    render(<AuthForm allowSignUp={false} />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-message")).toBeVisible();
    });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("AuthForm — c1/c9 structural guarantees", () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );

  const sources = {
    "auth-form.tsx": readFileSync(
      path.join(REPO_ROOT, "src/app/auth/auth-form.tsx"),
      "utf8",
    ),
    "sign-out-button.tsx": readFileSync(
      path.join(REPO_ROOT, "src/app/auth/sign-out-button.tsx"),
      "utf8",
    ),
  };

  it("uses createAuthClient in both islands", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).toContain("createAuthClient");
      expect(source, name).toContain('from "better-auth/client"');
    }
  });

  it("hashes nothing, compares no password and writes no cookie itself", () => {
    // The forbidden local implementations, spelled as the things they would be
    // written with. A behavioural mock cannot see these.
    const forbidden = [
      "createHash",
      "crypto.subtle",
      "bcrypt",
      "scrypt",
      "argon",
      "sha256",
      "sha1",
      "md5",
      "document.cookie",
      "setCookie",
    ];
    for (const [name, source] of Object.entries(sources)) {
      for (const token of forbidden) {
        expect(source, `${name} must not use ${token}`).not.toContain(token);
      }
    }
  });

  it("never stores or renders a session token", () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toContain("localStorage");
      expect(source, name).not.toContain("sessionStorage");
      expect(source, name).not.toContain("console.");
      // `token` appears in prose about NOT touching it, so the check is for the
      // client reading one out of a response.
      expect(source, name).not.toContain("data.token");
      expect(source, name).not.toContain("data.session");
    }
  });
});
