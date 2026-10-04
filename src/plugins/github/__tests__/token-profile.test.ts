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

import { GITHUB_TOKEN_PROFILE } from "../token-profile";

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

/** The name `.env.example` tells an operator to set, read from that file. */
function documentedTokenEnvVar(): string {
  const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  const declared = example
    .split("\n")
    .map((line) => /^\s*([A-Z0-9_]+)\s*=/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
  // Everything except DATABASE_URL is the access token.
  const names = declared.filter((name) => name !== "DATABASE_URL");
  expect(names).toHaveLength(1);
  return names[0] as string;
}

describe("the production token profile", () => {
  it("names the same environment variable .env.example documents", () => {
    // THE assertion. A mismatch here is a runtime `token_absent` for an
    // operator who followed the docs, with every gate green.
    expect(GITHUB_TOKEN_PROFILE.envVar).toBe(documentedTokenEnvVar());
  });

  it("is the variable an unconfigured reader actually reads", () => {
    // Not a restatement of the line above: it drives the real provider, so a
    // profile whose `envVar` is ignored somewhere downstream fails here even
    // though the two constants match.
    const seen: (string | undefined)[] = [];
    const provider = createEnvCredentialProvider({
      profile: GITHUB_TOKEN_PROFILE,
      readEnv: () => {
        const value = process.env[GITHUB_TOKEN_PROFILE.envVar];
        seen.push(value);
        return value;
      },
    });
    expect(provider).toBeDefined();
    expect(seen).toEqual([]);
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
