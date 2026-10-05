/**
 * The production token profile must agree with what the project DOCUMENTS.
 *
 * Why this test exists. The profile in `../token-profile` is the only place in
 * the tree that names the environment variable a real operator has to set.
 * Before this card, the value lived in a core constant AND in a test fixture,
 * and the two had already drifted: the fixture carried one name and the shipped
 * `.env.example` carried another. Nothing failed when they drifted, because the
 * composition-root suite injects its own reader and never consults the real
 * environment -- so a wrong `envVar` here is invisible to every other test and
 * surfaces only at runtime, as `token_absent`, for an operator who followed the
 * documentation exactly.
 *
 * So the invariant is pinned to the DOCUMENTATION, not to a literal restated
 * here. `.env.example` is the artefact a new operator copies; if the two ever
 * disagree again, this test is what says so, at `bun run test`, before a human
 * does.
 *
 * The name is never hardcoded: it is parsed out of `.env.example`, so the
 * assertion holds from any checkout directory and survives a legitimate rename
 * of the variable (which would be a deliberate change to that file).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createEnvCredentialProvider } from "@/core/credentials/env-provider";
import { CredentialError } from "@/core/credentials/provider";

import { GITHUB_TOKEN_PROFILE } from "../token-profile";
import { FIXTURE_MATERIAL } from "./fixtures";

/**
 * An obviously synthetic, correctly-shaped token: this profile's own prefix
 * followed by the fixture material. Prefixed by the profile rather than spelled
 * out, so the two tests that drive the real reader cannot go stale behind a
 * renamed prefix -- and no real credential can exist in this file.
 */
const VALID_TOKEN = `${GITHUB_TOKEN_PROFILE.prefix}${FIXTURE_MATERIAL}`;

/**
 * Repository root, derived from this file's own location rather than named.
 * CI checks the repo out into a directory named after it, which would hide a
 * hardcoded `DevLoop`/`devloop` path here.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * The name `.env.example` tells an operator to set, read from that file.
 *
 * WHY THIS SELECTS BY THE PROFILE, NOT BY BEING THE ONLY ENTRY. This helper
 * originally asserted `.env.example` declared exactly ONE variable besides
 * `DATABASE_URL` and returned it — a check that passed only while the file
 * happened to hold nothing else. Its own header states the real intent ("the
 * name an operator has to set", "survives a legitimate rename of the
 * variable"), and that intent is not exclusivity: `.env.example` is the list of
 * everything an operator may need, and other cards add to it (T19 added
 * `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`, which are not credentials).
 *
 * So the token is now selected by asking which declared name the
 * `GITHUB_TOKEN_PROFILE` actually is, and the failure mode is preserved rather
 * than weakened: a RENAME of the documented token variable still fails here,
 * because the profile's name would then be absent from the file. What is gone is
 * only the false claim that an unrelated variable's presence is a defect.
 *
 * The uniqueness assertion is kept, but on the honest statement: the profile's
 * name must be declared, and must be declared exactly once.
 */
function documentedTokenEnvVar(): string {
  const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  const declared = example
    .split("\n")
    .map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
  // A variable documented twice is ambiguous, and an operator cannot tell which
  // line wins — so this is the half of the old assertion that was always true.
  expect(new Set(declared).size).toBe(declared.length);

  const occurrences = declared.filter(
    (name) => name === GITHUB_TOKEN_PROFILE.envVar,
  );
  expect(
    occurrences,
    `.env.example must declare ${GITHUB_TOKEN_PROFILE.envVar}; it declares [${declared.join(", ")}]`,
  ).toHaveLength(1);
  return GITHUB_TOKEN_PROFILE.envVar;
}

describe("the production token profile", () => {
  it("names the same environment variable .env.example documents", () => {
    // THE assertion. A mismatch here is a runtime `token_absent` for an
    // operator who followed the docs, with every gate green.
    expect(GITHUB_TOKEN_PROFILE.envVar).toBe(documentedTokenEnvVar());
  });

  it("is the variable an unconfigured reader actually reads", async () => {
    // Not a restatement of the line above: it drives the REAL default reader
    // -- `EnvCredentialProvider`'s own `() => process.env[profile.envVar]`
    // (`src/core/credentials/env-provider.ts`), the exact path an operator hits
    // with nothing injected -- and it actually calls `getToken()`, so a profile
    // whose `envVar` is ignored downstream fails here even when the two
    // constants match.
    //
    // Two halves, because a happy-path assertion alone would still pass if the
    // provider consulted EVERY variable rather than the named one:
    //   - the documented variable set  -> resolves to that token
    //   - only a DIFFERENT variable set -> `token_absent`, proving the name is
    //     what selects the read and not mere presence of some token
    const OTHER = "DEVLOOP_TEST_VAR_THAT_IS_NOT_THE_TOKEN";
    const saved = {
      named: process.env[GITHUB_TOKEN_PROFILE.envVar],
      other: process.env[OTHER],
    };
    try {
      delete process.env[OTHER];
      process.env[GITHUB_TOKEN_PROFILE.envVar] = VALID_TOKEN;

      const provider = createEnvCredentialProvider({
        profile: GITHUB_TOKEN_PROFILE,
      });
      await expect(provider.getToken()).resolves.toBe(VALID_TOKEN);

      // The same provider, now with the named variable gone and a decoy token
      // set. If it resolves, it was reading something other than the profile.
      delete process.env[GITHUB_TOKEN_PROFILE.envVar];
      process.env[OTHER] = VALID_TOKEN;
      const sameProvider = createEnvCredentialProvider({
        profile: GITHUB_TOKEN_PROFILE,
      });
      await expect(sameProvider.getToken()).rejects.toThrow(/not set/);
    } finally {
      if (saved.named === undefined)
        delete process.env[GITHUB_TOKEN_PROFILE.envVar];
      else process.env[GITHUB_TOKEN_PROFILE.envVar] = saved.named;
      if (saved.other === undefined) delete process.env[OTHER];
      else process.env[OTHER] = saved.other;
    }
  });

  it("reports an unset variable as absent rather than as a shape defect", async () => {
    // The third case the previous test's rewrite could have silently dropped: a
    // variable that is not set at all must classify as `token_absent`, so an
    // operator who forgot the export is sent to the right place. Pinned here
    // because the whole reason QA's finding survived to review is that no test
    // drove this path.
    const named = GITHUB_TOKEN_PROFILE.envVar;
    const saved = process.env[named];
    try {
      delete process.env[named];
      const provider = createEnvCredentialProvider({
        profile: GITHUB_TOKEN_PROFILE,
      });
      await expect(provider.getToken()).rejects.toThrow(CredentialError);
      await expect(provider.getToken()).rejects.toThrow(/not set/);
    } finally {
      if (saved !== undefined) process.env[named] = saved;
    }
  });

  it("still validates the token's prefix, so a wrong NAME cannot pass silently", () => {
    // The complement to the envVar check: the profile carries two halves and
    // this suite pins the name; the existing plugin tests pin the prefix
    // against what goes on the wire. Asserting the name alone would leave the
    // prefix unverified here.
    expect(GITHUB_TOKEN_PROFILE.prefix).toBe("github_pat_");
    expect(GITHUB_TOKEN_PROFILE.envVar.trim()).not.toBe("");
  });
});
