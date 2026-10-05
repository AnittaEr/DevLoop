/**
 * Meta test: `playwright.config.ts` may not declare a `retries` value that
 * Playwright can honour as non-zero — at ANY depth it can be read from.
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
 *   2. finds EVERY `retries` key at ANY brace depth and records the object it
 *      sits in, because Playwright reads `retries` from more than one place
 *      (see the schema note below — an earlier version of this guard read only
 *      the top level, and a per-project `retries: 2` slipped straight past it
 *      while still masking the run);
 *   3. treats an ABSENT `retries` key as a FAILURE, not as "0". Playwright's own
 *      default is 0, but "the config does not say" is not the same claim as
 *      "the config says zero", and only the second is worth pinning.
 *
 * Every one of those three tightenings is exercised below against a synthetic
 * config, including the decoy and the per-project key, so a future loosening of
 * the read is caught by a red test here rather than discovered when the defect
 * returns.
 *
 * WHICH `retries` KEYS PLAYWRIGHT CAN ACTUALLY HONOUR — from this repo's own
 * installed `playwright/types/test.d.ts`, not from memory:
 *
 *   - `TestConfig.retries`     (run-level)  — declared at test.d.ts:1647.
 *   - `TestProject.retries`    (per-project) — declared at test.d.ts:450.
 *     This is NOT a different key from the run-level one; it is an override
 *     honoured at run time. Measured: with top-level `retries: 0` and one
 *     `retries: 2` inside `projects[0]`, Playwright ran THREE attempts of a
 *     first-attempt-failing spec and reported `1 flaky` with exit 0 — the
 *     original defect, reintroduced by a single line, and the previous version
 *     of this guard stayed green through it. That is why this file is
 *     path-aware rather than depth-0-only.
 *   - `UseOptions` — declares NO `retries` member at all (grep over the
 *     `UseOptions` interface body: zero hits), so `use: { retries: n }` is a
 *     key Playwright ignores rather than one it honours. It is the single
 *     exemption below, and it is exempted on that measured schema fact, not on
 *     the convenient assumption that nested keys are always harmless — the
 *     per-project case proves the opposite.
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

/** One `retries` key found in a config, with the object that contains it. */
type RetriesEntry = {
  /**
   * Dotted path of enclosing object keys, outermost first. `""` is the
   * top level of `defineConfig`; `"projects"` is the object literal inside
   * `projects: [...]`; `"use"` is the `use` block.
   */
  ownerPath: string;
  value: string;
};

const KEY_AT = /['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*/y;
const VALUE_AT = /([^,\n}]+)/y;

/**
 * Every `retries` key in a config source, comment-stripped, at ANY depth.
 *
 * Depth tracking is not the mechanism — the PATH is. A scan that only recorded
 * brace depth 0 read `projects: [{ …, retries: 2 }]` as "no nested key" and
 * therefore as acceptable, which is exactly the live masking path described in
 * the header. So this records which object each key sits in, and the caller
 * decides what each object means.
 *
 * Two measured sharp edges in the scan, both hit while writing this and both
 * documented in-file because they fail SILENTLY rather than loudly:
 *
 *   1. It ADVANCES past each match instead of only incrementing `i`. The key
 *      pattern accepts a boundary character before the name, so at the
 *      separator and again at the `r` of `retries` one key matches twice. The
 *      first version of this loop returned `["0", "0"]` for a config carrying
 *      exactly one `retries` key — measured, not reasoned.
 *   2. `[` and `]` are deliberately NOT pushed onto the path stack, so
 *      `projects: [{ retries: 2 }]` reports `ownerPath === "projects"` rather
 *      than an anonymous `"[]"`. Array element objects are still entered at
 *      their `{`, which is the only thing that matters for the distinction
 *      this guard draws.
 *
 * Known limitation, stated rather than hidden: a ternary branch that is a bare
 * identifier immediately before a `{` (`x: a ? { … } : { … }`) can be mistaken
 * for the key that owns the object. That only affects the LABEL in `ownerPath`,
 * and the sole label this file acts on is `"use"`.
 */
function allRetriesEntries(configSource: string): RetriesEntry[] {
  const body = defineConfigBody(stripComments(configSource));
  const entries: RetriesEntry[] = [];
  const stack: string[] = [];
  let pendingKey = "?";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (char === "{") {
      stack.push(pendingKey);
      pendingKey = "?";
      continue;
    }
    if (char === "}") {
      stack.pop();
      pendingKey = "?";
      continue;
    }
    if (char === ",") {
      pendingKey = "?";
      continue;
    }
    if (char === "[" || char === "]") continue;

    const previous = body[i - 1];
    if (i > 0 && previous !== undefined && !/[\s,[(]/.test(previous)) {
      continue;
    }
    KEY_AT.lastIndex = i;
    const key = KEY_AT.exec(body);
    if (!key || key.index !== i) continue;
    const name = key[1];
    if (name === undefined) continue;
    pendingKey = name;
    const afterColon = i + key[0].length;
    if (name !== "retries") {
      i = afterColon - 1;
      continue;
    }
    VALUE_AT.lastIndex = afterColon;
    const value = VALUE_AT.exec(body);
    const expression = value?.[1];
    i = (value ? afterColon + (value[0]?.length ?? 0) : afterColon) - 1;
    if (expression === undefined) continue;
    entries.push({
      ownerPath: stack.join("."),
      value: expression.trim(),
    });
  }
  return entries;
}

/** Just the values, for the assertions that do not care where a key sat. */
function retriesValues(configSource: string): string[] {
  return allRetriesEntries(configSource).map((entry) => entry.value);
}

/**
 * Does every `retries` key Playwright can honour in this config evaluate to 0
 * with `CI` set to the given value?
 *
 * Every entry counts, not only the top-level one: a per-project override is a
 * live masking path (measured — three attempts and exit 0 behind a top-level
 * `retries: 0`), so exempting it by depth would leave the defect one line away.
 * The one exemption is a key inside a `use` block, which Playwright's
 * `UseOptions` does not declare at all.
 *
 * Only the two expressions this config could plausibly grow are evaluated, and
 * anything unrecognised is a FAILURE rather than a pass. A guard that silently
 * treats "I do not understand this expression" as "fine" is exactly the
 * self-certifying-green shape the rest of this file is about.
 */
function retriesResolveToZero(configSource: string, ci: string): boolean {
  const entries = allRetriesEntries(configSource);
  if (entries.length === 0) return false; // absent key: see the header, point 3.
  // `ci` is accepted so each call site states which CI value it is reasoning
  // about; the accepted forms below are all CI-independent, and that is the
  // point — nothing about the answer may depend on the flag being set.
  void ci;
  return entries.every((entry) => {
    // `UseOptions` has no `retries` member, so a key here is inert. Exempted on
    // that measured schema fact only — see the header.
    if (entry.ownerPath === "use") return true;
    const normalised = entry.value.replace(/\s+/g, "");
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
 *
 * It anchors on `^\s*retries` (line start) so it mutates the run-level key and
 * not a per-project one, which is what every caller here intends.
 */
function withRetries(source: string, replacement: string): string {
  const stripped = withoutProjectRetries(stripComments(source));
  if (!/^\s*retries\s*:/m.test(stripped)) {
    throw new Error(
      "no top-level `retries` key found in the config source to replace — " +
        "this helper's callers assume the shipped key is present.",
    );
  }
  return stripped.replace(
    /^\s*retries\s*:\s*[^,\n}]+/m,
    `  retries: ${replacement}`,
  );
}

/** Drop the run-level `retries` key entirely. */
function withoutRetries(source: string): string {
  const stripped = withoutProjectRetries(stripComments(source));
  return stripped.replace(/\n\s*retries\s*:\s*[^,\n}]+,/, "");
}

/**
 * Remove a `retries` key that sits inside `projects[0]`, if there is one.
 *
 * The three mutation helpers below all read `shippedConfig` from disk, so when
 * this file's own behaviour is under test against a config someone has actually
 * mutated — the one-line `projects[0]` edit, added by hand on the command line —
 * each helper would otherwise build its fixture ON TOP of that injected key and
 * fail for a reason unrelated to what it is asserting. Measured: with
 * `retries: 2` in `projects[0]`, ten of thirteen tests went red, and the two
 * that assert a per-project behaviour could not tell the masking case from
 * their own scaffolding.
 *
 * So every helper normalises its input back to the single-top-level-key shape
 * first. That is what makes a RED run mean "the guard caught the injected
 * masking" and nothing else, which is the difference between a useful
 * non-vacuity proof and a wall of collateral failures.
 */
function withoutProjectRetries(source: string): string {
  const anchor = /projects:\s*\[\s*\{/.exec(source);
  if (!anchor || anchor.index === undefined) return source;
  const blockStart = anchor.index + anchor[0].length;
  let depth = 1;
  let end = source.length;
  for (let i = blockStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = source
    .slice(blockStart, end)
    .replace(/\n\s*retries\s*:\s*[^,\n}]+,/, "");
  return source.slice(0, blockStart) + block + source.slice(end);
}

describe("playwright.config.ts retry policy", () => {
  it("ships exactly one `retries` key, at the top level", () => {
    // Non-vacuity floor: with no readable key at all, the assertions below
    // would pass on an empty array. The absence case is asserted separately,
    // below, as a FAILURE.
    expect(allRetriesEntries(shippedConfig)).toEqual([
      { ownerPath: "", value: "0" },
    ]);
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
      expect(retriesValues(regression)).toEqual([
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
    expect(retriesValues(removed)).toEqual([]);
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
    expect(retriesValues(decoyOnly)).toEqual(["process.env.CI ? 2 : 0"]);
    expect(retriesResolveToZero(decoyOnly, "true")).toBe(false);

    // A per-project decoy is not a way round it either: the comment above the
    // real key mentions `retries` several times, including
    // `retries: process.env.CI ? 2 : 0` quoted as history, and none of that
    // counts.
    expect(retriesValues(shippedConfig)).toEqual(["0"]);
  });

  it("fails on a per-project `retries`, which Playwright honours", () => {
    // The regression QA measured. `TestProject.retries` (test.d.ts:450) is a
    // run-time override, not a distinct key: with the run-level `retries: 0`
    // intact, ONE added line inside `projects[0]` made a first-attempt-failing
    // spec run three attempts and report `1 flaky` with exit 0. An earlier
    // version of this guard read only brace depth 0, asserted that
    // `projects: [{ retries: 2 }]` was ACCEPTABLE, and stayed green through it.
    // This test is the case that must go red.
    const perProject = [
      'import { defineConfig } from "@playwright/test";',
      "export default defineConfig({",
      "  retries: 0,",
      "  use: { baseURL: 'http://127.0.0.1:3000' },",
      "  projects: [",
      "    { name: 'chromium', retries: 2 },",
      "  ],",
      "});",
    ].join("\n");
    expect(allRetriesEntries(perProject)).toEqual([
      { ownerPath: "", value: "0" },
      { ownerPath: "projects", value: "2" },
    ]);
    expect(retriesResolveToZero(perProject, "true")).toBe(false);
    expect(retriesResolveToZero(perProject, "1")).toBe(false);
    expect(retriesResolveToZero(perProject, "")).toBe(false);
  });

  it("fails on the same masking spelled in the shipped config", () => {
    // The realistic version of the case above: the decoy reasoning and the
    // real config, rather than a synthetic string. Adds `retries: 2` to
    // `projects[0]` of the file that actually ships and asserts the guard goes
    // red — the shape a future author would most plausibly write, and the one
    // that previously sailed through 9/9 green.
    const mutated = withProjectRetries(shippedConfig, 2);
    expect(allRetriesEntries(mutated)).toEqual([
      { ownerPath: "", value: "0" },
      { ownerPath: "projects", value: "2" },
    ]);
    expect(retriesResolveToZero(mutated, "true")).toBe(false);
  });

  it("still accepts a zero-valued per-project key", () => {
    // Being explicit about retries per project is not itself the defect; only a
    // non-zero one is. A guard that rejected `retries: 0` inside `projects`
    // would push the next author back to hiding the policy in an expression the
    // guard cannot read.
    const explicitZero = withProjectRetries(shippedConfig, 0);
    expect(allRetriesEntries(explicitZero)).toEqual([
      { ownerPath: "", value: "0" },
      { ownerPath: "projects", value: "0" },
    ]);
    expect(retriesResolveToZero(explicitZero, "true")).toBe(true);
  });

  it("exempts `use: { retries }` because Playwright declares no such key", () => {
    // The distinction is drawn from this repo's installed schema, not assumed:
    // `UseOptions` (playwright/types/test.d.ts) contains no `retries` member —
    // grep over the interface body returns zero hits — while `TestConfig` and
    // `TestProject` both declare one. A `retries` inside `use` is therefore
    // inert, and failing it would be the guard reporting a defect that cannot
    // mask a run. If a future Playwright adds `UseOptions.retries`, this
    // exemption becomes the next hole; the fix is to delete it, and the test
    // below is written so deleting it turns the shipped-config case red first.
    const withUseKey = [
      'import { defineConfig } from "@playwright/test";',
      "export default defineConfig({",
      "  retries: 0,",
      "  use: { baseURL: 'http://127.0.0.1:3000', retries: 1 },",
      "});",
    ].join("\n");
    expect(allRetriesEntries(withUseKey)).toEqual([
      { ownerPath: "", value: "0" },
      { ownerPath: "use", value: "1" },
    ]);
    expect(retriesResolveToZero(withUseKey, "true")).toBe(true);
  });

  it("treats an unrecognised expression as a failure, not a pass", () => {
    const cryptic = withRetries(
      shippedConfig,
      "Number(process.env.PW_RETRIES ?? 0)",
    );
    expect(retriesValues(cryptic)).toEqual([
      "Number(process.env.PW_RETRIES ?? 0)",
    ]);
    expect(retriesResolveToZero(cryptic, "true")).toBe(false);
  });

  it("treats an unrecognised PER-PROJECT expression as a failure too", () => {
    // The cryptic spelling is just as easy to write inside `projects[0]`, and
    // it is the more dangerous one, because the run-level value still reads as
    // a clean `0`.
    const crypticProject = withProjectRetries(
      shippedConfig,
      "process.env.CI ? 2 : 0",
    );
    expect(allRetriesEntries(crypticProject)).toEqual([
      { ownerPath: "", value: "0" },
      { ownerPath: "projects", value: "process.env.CI ? 2 : 0" },
    ]);
    expect(retriesResolveToZero(crypticProject, "true")).toBe(false);
  });

  it("accepts the CI-conditional-zero shape as well as a bare 0", () => {
    // The fix need not be the bare literal this card shipped. A config that says
    // `process.env.CI ? 0 : 0` is explicit about the intent and must not be
    // failed by a guard that only knows one spelling.
    const conditionalZero = withRetries(
      shippedConfig,
      "process.env.CI ? 0 : 0",
    );
    expect(retriesValues(conditionalZero)).toEqual(["process.env.CI ? 0 : 0"]);
    expect(retriesResolveToZero(conditionalZero, "true")).toBe(true);
  });
});

/**
 * Add a `retries` key inside `projects[0]` of a config source — the exact
 * one-line edit QA measured as a live masking path.
 *
 * Comment-stripped first for the same reason `withRetries` is: the shipped
 * config's comment block quotes `retries: …` several times, so a text
 * insertion anchored only on the string `projects:` could land inside the
 * comment.
 */
function withProjectRetries(source: string, value: string | number): string {
  const stripped = withoutProjectRetries(stripComments(source));
  const anchor = /projects:\s*\[\s*\{/.exec(stripped);
  if (!anchor || anchor.index === undefined) {
    throw new Error(
      "no `projects: [ {` in the config source — this helper's callers assume " +
        "the shipped project block is present.",
    );
  }
  const insertAt = anchor.index + anchor[0].length;
  return `${stripped.slice(0, insertAt)}\n      retries: ${value},${stripped.slice(insertAt)}`;
}
