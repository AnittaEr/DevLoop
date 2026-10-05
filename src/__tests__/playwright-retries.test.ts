/**
 * Meta test: `playwright.config.ts` may not resolve `retries` to a non-zero
 * value.
 *
 * WHY THIS FILE EXISTS — a measured defect, not a hypothetical.
 *
 * The config declared `retries: process.env.CI ? 2 : 0`, and the `e2e` job in
 * `.github/workflows/ci.yml` sets `CI: true` at job level. So on every pull
 * request each e2e spec was retried up to three times, and Playwright reports a
 * test that failed and then passed as **`1 flaky` with exit code 0**. Measured
 * on `origin/main` (`1f4bd5c`) with a real `CI=1` run of a spec whose assertion
 * holds only from attempt 2 onward:
 *
 *     PROBE_ATTEMPT retry=0
 *     PROBE_ATTEMPT retry=1
 *       1 flaky
 *     PLAYWRIGHT_EXIT=0
 *
 * That check's own comment in the workflow states its purpose as "when it goes
 * red the PR checks list says e2e failed". With two retries it could not go red
 * for any defect that happened to be order- or timing-sensitive — which is a
 * large fraction of what an e2e test is for. `forbidOnly` already guarded
 * `test.only`; nothing guarded the retry, so the repository's headline badge
 * could be green with a broken spec behind it.
 *
 * WHY IT FAILS RATHER THAN SKIPS. A skipped guard is a green suite with no
 * enforcement in it, which is the condition this file exists to end. Same
 * argument as `src/__tests__/db-suite-registry.test.ts` and
 * `src/core/__tests__/boundary-guard-exists.test.ts`.
 *
 * HOW IT READS THE CONFIG — AS TEXT, NEVER BY IMPORTING IT.
 *
 * Importing `playwright.config.ts` from a Vitest file pulls `@playwright/test`'s
 * module graph into the jsdom environment of the default `verify` suite. That
 * failure mode is documented with a measured reproduction in
 * `src/__tests__/db-suite-registry.test.ts`, which imported
 * `vitest.db.config.ts` and took the whole suite red with
 * `Invariant violation: "new TextEncoder().encode("") instanceof Uint8Array" is
 * incorrectly false`. The config is therefore read off disk as text.
 *
 * WHY A TEXT READ IS NOT LOOSE ENOUGH ON ITS OWN, AND WHAT TIGHTENS IT. The
 * defect class this repository keeps hitting is a read that finds what it hopes
 * for: a first-match regex is satisfied by a COMMENT, so a decoy
 * `// retries: 2` line would let the real setting drift back to a non-zero value
 * while this guard stayed green. So the read here:
 *
 *   1. strips comments before matching (same walk `db-suite-registry` uses —
 *      not `source.replace(/\/\/.*$/gm, "")`, which TRUNCATES a line whose
 *      string contains `//` and would delete a real setting);
 *   2. requires the `retries` key to sit at the TOP LEVEL of the `defineConfig`
 *      object, at brace depth 0 of that object — not nested inside `use:`, a
 *      `project`, or `expect:`;
 *   3. treats an ABSENT `retries` key as a FAILURE, not as "0". Playwright's own
 *      default is 0, but "the config does not say" is not the same claim as
 *      "the config says zero", and only the second is worth pinning.
 *
 * Every one of those three tightenings is exercised below against a synthetic
 * config, including the decoy, so a future loosening of the read is caught by a
 * red test here rather than discovered when the defect returns.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PW_CONFIG_PATH = path.join(REPO_ROOT, "playwright.config.ts");

/**
 * Strip JS comments, leaving string literals intact. Copied in full rather than
 * imported from the sibling guard on purpose: this file must keep working if
 * that one is ever refactored, and a shared helper module under `src/` would be
 * a new thing for a meta-test to depend on.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += "\n";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * The body of the `defineConfig({ ... })` object, comment-stripped.
 *
 * Falls back to the whole source if the `defineConfig(` call cannot be located,
 * so a reshaped config is read as "top level of whatever follows" rather than
 * silently producing an empty string that would satisfy every check below.
 */
function defineConfigBody(source: string): string {
  const call = /\bdefineConfig\s*\(/.exec(source);
  if (!call || call.index === undefined) return source;
  const open = source.indexOf("{", call.index + call[0].length);
  if (open === -1) return source;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source;
}

/**
 * Every TOP-LEVEL `retries: <expr>` value in a config source, comment-stripped.
 *
 * Depth tracking is the load-bearing part: `use: { retries: 1 }` or a per-project
 * `retries` is a different key from the one Playwright reads for the run-level
 * policy, and reading those as the run-level setting would either fail a
 * legitimate config or pass a broken one.
 *
 * The scan ADVANCES past each match. It does not just increment `i`: the
 * pattern accepts either a leading `(^|[\s,{])` separator or its own `^`, so at
 * the separator position and at the `r` of `retries` the same key matches
 * twice and one key reads as two. That was measured, not reasoned — an earlier
 * version of this loop returned `["0", "0"]` for a config carrying exactly one
 * `retries` key.
 */
function topLevelRetriesValues(configSource: string): string[] {
  const body = defineConfigBody(stripComments(configSource));
  const values: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const match = /(^|[\s,{])retries\s*:\s*([^,\n}]+)/.exec(body.slice(i));
    const expression = match?.[2];
    if (match && match.index === 0 && expression !== undefined) {
      values.push(expression.trim());
      i += match[0].length - 1;
    }
  }
  return values;
}

/**
 * Does every top-level `retries` expression in this config evaluate to 0 with
 * `CI` set to the given value?
 *
 * Only the two expressions this config could plausibly grow are evaluated, and
 * anything unrecognised is a FAILURE rather than a pass. A guard that silently
 * treats "I do not understand this expression" as "fine" is exactly the
 * self-certifying-green shape the rest of this file is about.
 */
function retriesResolveToZero(configSource: string, ci: string): boolean {
  const values = topLevelRetriesValues(configSource);
  if (values.length === 0) return false; // absent key: see the header, point 3.
  // `ci` is accepted so each call site states which CI value it is reasoning
  // about; the accepted forms below are all CI-independent, and that is the
  // point — nothing about the answer may depend on the flag being set.
  void ci;
  return values.every((expr) => {
    const normalised = expr.replace(/\s+/g, "");
    return normalised === "0" || normalised === "process.env.CI?0:0";
  });
}

const shippedConfig = readFileSync(PW_CONFIG_PATH, "utf8");

/**
 * Replace the run-level `retries` value in a config source.
 *
 * It mutates the COMMENT-STRIPPED source and re-inserts a comment of its own,
 * because the shipped config now carries a comment block above its `retries` key
 * that quotes the old `retries: process.env.CI ? 2 : 0` value as history. A
 * naive `source.replace(/retries\s*:\s*[^,\n]+/, …)` therefore rewrites the
 * COMMENT — measured: the first green run of this file reported
 * `["0", "0"]` for a config with one key, because the mutation it applied was
 * invisible to the read, and two of its assertions failed for that reason.
 * Stripping first makes the mutation land on the real key every time.
 */
function withRetries(source: string, replacement: string): string {
  const stripped = stripComments(source);
  if (!/retries\s*:\s*[^,\n}]+/.test(stripped)) {
    throw new Error(
      "no top-level `retries` key found in the config source to replace — " +
        "this helper's callers assume the shipped key is present.",
    );
  }
  return stripped.replace(/retries\s*:\s*[^,\n}]+/, `retries: ${replacement}`);
}

/** Drop the run-level `retries` key entirely. */
function withoutRetries(source: string): string {
  const stripped = stripComments(source);
  return stripped.replace(/\n\s*retries\s*:\s*[^,\n}]+,/, "");
}

describe("playwright.config.ts retry policy", () => {
  it("ships exactly one top-level `retries` key", () => {
    // Non-vacuity floor: with no readable key at all, the assertions below
    // would pass on an empty array. The absence case is asserted separately,
    // below, as a FAILURE.
    expect(topLevelRetriesValues(shippedConfig)).toEqual(["0"]);
  });

  it("resolves `retries` to 0 with CI set", () => {
    expect(retriesResolveToZero(shippedConfig, "true")).toBe(true);
    expect(retriesResolveToZero(shippedConfig, "1")).toBe(true);
  });

  it("keeps `forbidOnly` on under CI", () => {
    // Adjacent to the retry policy and cheap to hold: `retries: 0` is only
    // meaningful alongside the guard that stops `test.only` quietly shrinking
    // the suite to one test. Asserted so a future "simplify the CI section"
    // edit cannot trade one masking hole for another.
    expect(stripComments(shippedConfig)).toMatch(
      /forbidOnly\s*:\s*!!process\.env\.CI/,
    );
  });

  it("fails on the exact defect: CI-conditional retries > 0", () => {
    // The shipped value before this change. `1` and `2` both hid a
    // first-attempt failure, so both must be rejected.
    for (const value of ["1", "2", "3"]) {
      const regression = withRetries(
        shippedConfig,
        `process.env.CI ? ${value} : 0`,
      );
      expect(topLevelRetriesValues(regression)).toEqual([
        `process.env.CI ? ${value} : 0`,
      ]);
      expect(retriesResolveToZero(regression, "true")).toBe(false);
      expect(retriesResolveToZero(regression, "1")).toBe(false);
      // And unchanged with the flag unset, so the answer cannot depend on it.
      expect(retriesResolveToZero(regression, "")).toBe(false);
    }
  });

  it("fails when the key is removed altogether", () => {
    const removed = withoutRetries(shippedConfig);
    expect(topLevelRetriesValues(removed)).toEqual([]);
    expect(retriesResolveToZero(removed, "true")).toBe(false);
  });

  it("is not satisfied by a commented-out decoy", () => {
    // The trap documented in `db-suite-registry.test.ts`, reproduced for this
    // guard: a first-match text parse reads the COMMENT, so a decoy line
    // reading `retries: 0` would let the real setting go back to
    // `process.env.CI ? 2 : 0` while this file stayed green.
    const decoyOnly = [
      "// decoy: retries: 0",
      'import { defineConfig } from "@playwright/test";',
      "export default defineConfig({",
      "  retries: process.env.CI ? 2 : 0,",
      "});",
    ].join("\n");
    expect(topLevelRetriesValues(decoyOnly)).toEqual([
      "process.env.CI ? 2 : 0",
    ]);
    expect(retriesResolveToZero(decoyOnly, "true")).toBe(false);

    // The shipped comment block above the real key mentions `retries` several
    // times, including `retries: process.env.CI ? 2 : 0` quoted as history. If
    // comments were not stripped, that quoted history would be read as the live
    // value and this guard would be red on a correct config — or, worse, a
    // reviewer "fixing" it by loosening the read. Measured, not asserted:
    // this assertion was RED (returning `["0", "0"]`) until the scan was fixed
    // to advance past each match.
    expect(topLevelRetriesValues(shippedConfig)).toEqual(["0"]);
  });

  it("does not read a nested `retries` as the run-level one", () => {
    const nested = [
      'import { defineConfig } from "@playwright/test";',
      "export default defineConfig({",
      "  retries: 0,",
      "  use: { retries: 1 },",
      "  projects: [{ name: 'chromium', retries: 2 }],",
      "});",
    ].join("\n");
    expect(topLevelRetriesValues(nested)).toEqual(["0"]);
    expect(retriesResolveToZero(nested, "true")).toBe(true);
  });

  it("treats an unrecognised expression as a failure, not a pass", () => {
    const cryptic = withRetries(
      shippedConfig,
      "Number(process.env.PW_RETRIES ?? 0)",
    );
    expect(topLevelRetriesValues(cryptic)).toEqual([
      "Number(process.env.PW_RETRIES ?? 0)",
    ]);
    expect(retriesResolveToZero(cryptic, "true")).toBe(false);
  });

  it("accepts the CI-conditional-zero shape as well as a bare 0", () => {
    // The fix need not be the bare literal this card shipped. A config that says
    // `process.env.CI ? 0 : 0` is explicit about the intent and must not be
    // failed by a guard that only knows one spelling.
    const conditionalZero = withRetries(
      shippedConfig,
      "process.env.CI ? 0 : 0",
    );
    expect(topLevelRetriesValues(conditionalZero)).toEqual([
      "process.env.CI ? 0 : 0",
    ]);
    expect(retriesResolveToZero(conditionalZero, "true")).toBe(true);
  });
});
