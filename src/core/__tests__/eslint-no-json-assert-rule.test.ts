/**
 * Meta test for the R145 lint rule (`eslint-plugin-no-json-assert.mjs`).
 *
 * THE DEFECT THIS CLOSES, AND WHY IT IS NOT THE SAME DEFECT AS ITS TICKET
 * DESCRIBES.
 *
 * The ticket (B40 / R145) states that `tsc` does not enforce the removal of the
 * `as JsonObject` cast in `db/canonical-event-mapper.ts`. That is TRUE, but only
 * of ONE of the file's two casts, and the distinction is the whole rule:
 *
 *   - WRITE path, `metadata: structuredClone(event.metadata) as JsonObject`
 *     — MEASURED at `e780063`: deleting ` as JsonObject` leaves
 *     `bun run typecheck` at exit 0, and so does substituting the provably
 *     false `"nonsense" as unknown as JsonObject`. Nothing checks it.
 *   - READ path, `metadata: (row.metadata ?? {}) as JsonObject`
 *     — MEASURED: deleting the cast yields `TS2322: Type '{}' is not
 *     assignable to type 'JsonObject'`. `tsc` ALREADY holds this one.
 *
 * So the rule is pointed at the write path, the only one that can vanish
 * silently. This test asserts that scope explicitly, because pointing a rule at
 * a line the compiler already defends would be decoration, and because a rule
 * that silently widened later would be worse than no rule.
 *
 * WHY A LINT RULE NEEDS A TEST AT ALL (c3) AND A META-TEST ON TOP OF IT (c4).
 *
 * Two independent ways this defence could evaporate while the suite stays
 * green, both already realised once in this repository:
 *
 *   1. The RULE stops working — a renamed AST node type, a broken scope check,
 *     a config glob that quietly stopped matching `db/**`. No assertion
 *     anywhere would notice, because nothing asserts the rule fires.
 *   2. The RULE is deleted or de-registered from `eslint.config.mjs`. This is
 *     the R1a shape: QA measured that deleting `plugin-boundary.test.ts`
 *     outright left the suite GREEN, and `boundary-guard-exists.test.ts` exists
 *     to close it.
 *
 * The `guard-exists` pattern (read the config as TEXT, then load the RESOLVED
 * config object and check the rule is enabled as "error") is reused rather than
 * reinvented, per the ticket. Each layer covers a gap the other cannot: the
 * text read survives a config object built differently; the resolved read
 * catches a rule downgraded to "warn" or dropped from the block entirely.
 *
 * THE FIXTURES ARE LINTED WITH A FILE PATH INSIDE `db/`, BECAUSE THE SCOPE IS
 * PART OF THE CONTRACT.
 *
 * Every case below drives the real plugin through ESLint's own `Linter` at a
 * filename under `<root>/db/`. If the rule's scope were widened or narrowed, the
 * cases would move with it — and there is an explicit case proving that a file
 * OUTSIDE the scope is not checked, so the scope cannot be widened by accident
 * and start flagging, say, `e2e/**` fixtures.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import eslintConfig from "../../../eslint.config.mjs";
import {
  DENIED_TYPE_NAMES,
  noJsonAssertPlugin,
  RULE_ID,
} from "../../../eslint-plugin-no-json-assert.mjs";

/**
 * The repo root, derived from this file's own location rather than from `cwd`.
 *
 * This file is `<root>/src/core/__tests__/<name>.ts`, so the root is three
 * levels up. A test that trusted `process.cwd()` would assert against
 * whichever tree Vitest happened to be invoked from — the exact class of
 * green-but-wrong claim this whole meta-test genre exists to prevent.
 */
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const linter = new Linter();

/**
 * The denied shape as a text pattern, built from the PLUGIN'S OWN exported set
 * rather than hardcoded here.
 *
 * A second copy of the type list in a test is a list that can drift: the rule
 * could gain `PgJsonb` and this scan would keep checking for four names. Derived,
 * it cannot. This pattern is for the two tests that assert a CLAIM ABOUT THE
 * TREE (a count over files), not for deciding what the rule reports — that is
 * decided by the AST visitor, which is why `bun run lint` passes over this file
 * even though the pattern below matches its own docstrings.
 */
const DENIED_SHAPE = new RegExp(
  `as (?:${[...DENIED_TYPE_NAMES].join("|")})\\b`,
);

/**
 * Every `.ts`/`.tsx` file under `ROOT/<relative>`, recursively.
 *
 * Used to re-assert the rule's scope claim over the WHOLE tree rather than one
 * named file, so the empty allowlist is a codebase-wide statement. `node_modules`
 * is skipped: a dependency's source is not this repo's assertion and linters do
 * not gate on it.
 */
function walk(root: string, relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    if (entry.name === "node_modules") continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(root, child));
    } else {
      found.push(path.join(root, child));
    }
  }
  return found;
}

/**
 * The TypeScript parser, which this rule cannot work without.
 *
 * `Linter` defaults to espree, which cannot parse `x as JsonObject` at all and
 * reports `Parsing error: Unexpected token :` with a null `ruleId`. Those parse
 * errors are deliberately NOT conflated with "no config matched" in `lint()`
 * below: a parse error means the fixture is bad, while a non-matching config
 * means the rule never ran, and the two demand different fixes.
 */
const tsParser = (await import("@typescript-eslint/parser")).default;

/** An absolute path inside the rule's scope, built from safe segments. */
function dbFile(name: string): string {
  return path.join(ROOT, "db", name);
}

/** An absolute path OUTSIDE the rule's scope, for the scope-boundary case. */
function outsideFile(name: string): string {
  return path.join(ROOT, "e2e", name);
}

/**
 * The scope the real config registers, kept here so the out-of-scope case below
 * exercises the SAME decision the shipped config makes.
 *
 * `lint()` defaults to a match-everything glob, which matches any path and
 * therefore cannot express a scope boundary. The out-of-scope case passes this list
 * instead, so it tests the real `db/`+`src/` pairing — including that `e2e/**`
 * is genuinely not covered.
 */
const REAL_SCOPE_FILES = ["db/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"];

/**
 * Lint `code` at `filename` and return only this rule's messages.
 *
 * The `unconfigured` guard is load-bearing: a flat-config `files` glob that
 * fails to match the supplied absolute path makes `Linter` emit a single
 * "No matching configuration found" warning with a `null` ruleId and ZERO rule
 * messages. Every negative case below would then pass VACUOUSLY, and every
 * positive one would fail for a reason unrelated to the rule. So a null-ruleId
 * message is an explicit failure naming the file.
 *
 * Note this also catches a genuine PARSE error, which is reported with the same
 * null ruleId. That is deliberate: with the TS parser wired in below, the only
 * way to produce one is a malformed fixture, and both are "the rule did not
 * produce a verdict", which is the thing that must never pass silently.
 */
function lint(
  filename: string,
  code: string,
  allow?: string[],
  files: string[] = ["**/*.ts"],
  expectScoped = true,
): string[] {
  const config = [
    {
      files,
      // Explicit, so the fixtures parse as TypeScript. Without this the Linter
      // uses espree, reports a null-ruleId parse error, and the assertions
      // below would be testing a fixture rather than the rule.
      languageOptions: { parser: tsParser as unknown as Linter.Parser },
      plugins: { "no-json-assert": noJsonAssertPlugin },
      rules: { [RULE_ID]: allow ? ["error", { allow }] : "error" },
    },
  ] as unknown as Linter.Config[];
  const messages = linter.verify(code, config, filename);
  const unconfigured = messages.filter((m) => m.ruleId === null);
  if (expectScoped) {
    expect(
      unconfigured.map((m) => m.message),
      `the flat config did not apply to ${filename}, so the rule never ran`,
    ).toEqual([]);
  } else {
    // Inverted on purpose. For an intentionally-OUT-of-scope path, "no matching
    // configuration" is the outcome being asserted — it is how the flat config
    // declines a file — so treating it as an error would make it impossible to
    // prove the scope boundary. It is still required to be exactly that one
    // message and not a silent pass, because a lint call that returned NOTHING
    // at all (no warning, no message) would also pass `toEqual([])` below and
    // would prove nothing at all.
    expect(
      unconfigured.map((m) => m.message),
      `expected ${filename} to fall outside the rule's scope`,
    ).toHaveLength(1);
    expect(unconfigured[0]?.message).toContain("No matching configuration");
  }
  return messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.message);
}

describe("no-json-assert: it FIRES (the negative control that makes this a gate)", () => {
  it("rejects the exact write-path shape from db/canonical-event-mapper.ts", () => {
    // The literal line R145 is about, verbatim in shape. This lints CLEAN
    // today with no rule anywhere in the repository.
    const messages = lint(
      dbFile("probe.ts"),
      "export const f = (event: CanonicalEvent) =>\n" +
        "  structuredClone(event.metadata) as JsonObject;\n",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("JsonObject");
  });

  it("rejects the shape after the cast is REMOVED — the property under test", () => {
    // Stated separately from the line above on purpose. "The cast is there and
    // gets flagged" and "the cast being GONE gets flagged" are different
    // properties, and only the second one is R145. A rule that merely banned
    // the existing text would pass the first and fail this.
    const messages = lint(
      dbFile("probe.ts"),
      "export const f = (x: unknown) => x as JsonObject;\n",
    );
    expect(messages).toHaveLength(1);
  });

  it("rejects the double-assertion laundering, which tsc also accepts", () => {
    const messages = lint(
      dbFile("probe.ts"),
      'export const f = () => "nonsense" as unknown as JsonObject;\n',
    );
    expect(messages).toHaveLength(1);
  });

  it("rejects every denied type name, and a qualified spelling of one", () => {
    for (const name of DENIED_TYPE_NAMES) {
      const messages = lint(
        dbFile("probe.ts"),
        `export const f = (x: unknown) => x as ${name};\n`,
      );
      expect(messages, `expected ${name} to be denied`).toHaveLength(1);
    }
    // `drizzle.PgJsonb` must resolve to its trailing segment, or the rule would
    // only work for the exact spelling this repo happens to use today.
    const qualified = lint(
      dbFile("probe.ts"),
      "export const f = (x: unknown) => x as drizzle.PgJsonb;\n",
    );
    expect(qualified).toHaveLength(1);
  });

  it("rejects the angle-bracket assertion form too", () => {
    // `.ts` files may use either spelling; checking one leaves "which syntax
    // did the author type" as a one-token bypass.
    expect(
      lint(
        dbFile("probe.ts"),
        "export const f = (x: unknown) => <JsonObject>x;\n",
      ),
    ).toHaveLength(1);
  });
});

describe("no-json-assert: it does NOT fire on legitimate code", () => {
  it("ignores the same token inside a comment and inside a string literal", () => {
    // THIS is why the rule is an AST selector and not a text search — this very
    // file, the config and the mapper's doc comments all NAME `as JsonObject`.
    // A regex over raw text fires on all of them, including on the fixtures
    // that prove the rule works.
    const messages = lint(
      dbFile("probe.ts"),
      "// mention `x as JsonObject` in a comment\n" +
        'const doc = "and `y as PgJsonb` in a string";\n' +
        "/** and `<JsonObject>z` in a block comment */\n" +
        "export const f = (x: { [k: string]: unknown }) => x;\n",
    );
    expect(messages).toEqual([]);
  });

  it("allows a legitimate type ANNOTATION and a type alias", () => {
    // Denying `JsonObject` everywhere would forbid the neutral vocabulary in
    // `src/core/events/canonical-event.ts` itself. Only ASSERTIONS are denied.
    const messages = lint(
      dbFile("probe.ts"),
      'import type { JsonObject } from "../src/core/events/canonical-event";\n' +
        "export type Legit = JsonObject;\n" +
        "export function f(m: JsonObject): JsonObject { return m; }\n",
    );
    expect(messages).toEqual([]);
  });

  it("allows assertions to unrelated types, including Json-adjacent names", () => {
    for (const type of [
      "string",
      "unknown",
      "Record<string, unknown>",
      "Jsonify",
      "MyJsonObject",
    ]) {
      const messages = lint(
        dbFile("probe.ts"),
        `export const f = (x: unknown) => x as ${type};\n`,
      );
      expect(messages, `${type} must stay assertable`).toEqual([]);
    }
  });

  it("does not check files outside db/** and src/**", () => {
    // The scope boundary is part of the contract, so it is asserted rather than
    // assumed: this rule must not start flagging e2e fixtures or config files.
    // Uses the REAL scope globs, not `lint()`'s match-everything default —
    // otherwise this case would be asserting that the rule is absent from a
    // glob that simply was not applied.
    const code = "export const f = (x: unknown) => x as JsonObject;\n";
    expect(
      lint(outsideFile("probe.ts"), code, undefined, REAL_SCOPE_FILES, false),
    ).toEqual([]);
    // …and the same code at the same scope IS checked, so the case above is
    // passing because of the path and not because the rule is inert.
    expect(
      lint(dbFile("probe.ts"), code, undefined, REAL_SCOPE_FILES),
    ).toHaveLength(1);
  });
});

describe("no-json-assert: the allowlist is line-pinned, not file-wide", () => {
  it("honours an allowlisted file:line", () => {
    expect(
      lint(
        dbFile("probe.ts"),
        "export const f = (x: unknown) => x as JsonObject;\n",
        ["db/probe.ts:1"],
      ),
    ).toEqual([]);
  });

  it("does NOT honour the same file at a different line", () => {
    // The property being protected is a property of a specific line. A
    // file-level allowlist would legalise every FUTURE cast in the mapper, which
    // is the one file this defect has ever been observed in.
    //
    // Two messages is the correct outcome, not a flake: the assertion on line 1
    // is reported, AND the unused `db/probe.ts:2` entry is reported stale. An
    // entry that points at the wrong line is itself the defect this case
    // documents, so the assertion is made on the two specifically rather than
    // on a count.
    const messages = lint(
      dbFile("probe.ts"),
      "export const f = (x: unknown) => x as JsonObject;\n",
      ["db/probe.ts:2"],
    );
    expect(
      messages.filter((m) => m.includes("Unchecked assertion")),
    ).toHaveLength(1);
    expect(messages.filter((m) => m.includes("db/probe.ts:2"))).toHaveLength(1);
  });

  it("reports an allowlist entry that no longer matches anything", () => {
    // A stale entry after an edit would otherwise sit there silently, and the
    // NEXT assertion on the shifted line would be waved through.
    const messages = lint(
      dbFile("probe.ts"),
      "export const f = (x: unknown) => x;\n",
      ["db/probe.ts:99"],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("db/probe.ts:99");
  });
});

describe("no-json-assert: it is REGISTERED in eslint.config.mjs (the R1a defence)", () => {
  it("is registered as an error over db/** and src/**, in the real config", () => {
    // Every case above drives the plugin object DIRECTLY, so all of them would
    // still pass if `eslint.config.mjs` stopped enabling the rule — leaving the
    // repo with no protection while the suite stayed green. Reading the config
    // as text and then loading the RESOLVED config closes that, and is the same
    // two-part trick `boundary-guard-exists.test.ts` already uses.
    const source = readFileSync(path.join(ROOT, "eslint.config.mjs"), "utf8");
    expect(source).toContain("eslint-plugin-no-json-assert.mjs");
    expect(source).toContain("noJsonAssertPlugin");
    // The rule id is a computed key, so the literal id is not in the config
    // text; the computed-key form is what must be there.
    expect(source).toContain("[JSON_ASSERT_RULE_ID]");

    const config = eslintConfig as unknown as Linter.Config[];
    const scoped = config.filter((entry) => entry.plugins?.["no-json-assert"]);
    expect(
      scoped.length,
      "no config block registers the no-json-assert plugin, so the rule is not active in any lint run",
    ).toBeGreaterThan(0);
    for (const entry of scoped) {
      const rules = entry.rules as Record<string, unknown>;
      const setting = rules[RULE_ID];
      // A rule configured WITH options is the array `["error", {...}]`, not the
      // bare string `"error"`. Comparing the whole setting to `"error"` would
      // fail against this rule's own correct config while still passing for a
      // rule that was genuinely downgraded to `"warn"`, so the severity is read
      // from element 0 of the array form and from the string form directly.
      const severity = Array.isArray(setting) ? setting[0] : setting;
      expect(
        severity,
        `${RULE_ID} is not enabled as an error on ${JSON.stringify(entry.files)}`,
      ).toBe("error");
      // Scope is asserted, not assumed: a glob that silently stopped matching
      // `db/` would leave the write path undefended while the key was present.
      const files = JSON.stringify(entry.files);
      expect(files, `${RULE_ID} no longer covers db/`).toContain("db/");
      expect(files, `${RULE_ID} no longer covers src/`).toContain("src/");
    }
  });

  it("carries an EMPTY allowlist", () => {
    // c5, applied at the integrated head bd15b73: the write-path cast was
    // removed by narrowing the value, so `allow` is `[]`. This asserts the
    // STRONGEST state, which is the point of c5: an allowlist entry is a hole
    // in this rule, and a future author adding one to silence a violation is
    // re-introducing the exact defect R145 describes. So a non-empty allowlist
    // is now a test failure naming what must be justified in eslint.config.mjs,
    // not a silent pass.
    const config = eslintConfig as unknown as Linter.Config[];
    const scoped = config.filter((entry) => entry.plugins?.["no-json-assert"]);
    const entry = scoped[0]?.rules?.[RULE_ID] as unknown as
      | ["error", { allow: string[] }]
      | undefined;
    expect(entry?.[0]).toBe("error");
    expect(
      entry?.[1]?.allow,
      "the no-json-assert allowlist must stay empty; narrow the value at the " +
        "boundary instead of asserting it (see eslint.config.mjs)",
    ).toEqual([]);
  });

  it("is a real plugin module, not an empty stub", () => {
    const modulePath = path.join(ROOT, "eslint-plugin-no-json-assert.mjs");
    expect(statSync(modulePath).isFile()).toBe(true);
    // A stub plugin would satisfy every import above while defining no rule.
    expect(readFileSync(modulePath, "utf8")).toContain("TSAsExpression");
  });
});

describe("no-json-assert: the scope it claims matches what it does", () => {
  it("db/canonical-event-mapper.ts has NO occurrence of the denied shape", () => {
    // The property c5 exists to make true: zero assertions to a JSON type in
    // the one file that carried them. Asserted here so that re-introducing one
    // fails as "the cast came back" rather than as "lint broke", and so the
    // `allow: []` assertion above cannot be weakened without this going too.
    const source = readFileSync(
      path.join(ROOT, "db", "canonical-event-mapper.ts"),
      "utf8",
    );
    // `?? []` because `String.match` returns null on no match, and a null here
    // would fail `toHaveLength` with "Target cannot be null or undefined" rather
    // than the message naming the property.
    const occurrences =
      source.match(new RegExp(DENIED_SHAPE.source, "g")) ?? [];
    // Zero, at the integrated head. The base `e780063` carried two: the write
    // path (unguarded by tsc — the R145 subject, removed by c5) and the read
    // path (already guarded by tsc, removed by batch 12).
    expect(
      occurrences,
      "db/canonical-event-mapper.ts has re-acquired an assertion to a JSON type",
    ).toHaveLength(0);
  });

  it("no file in db/ or src/ has an occurrence of the denied shape", () => {
    // c2's measurement, re-asserted as an invariant rather than reported once:
    // the count is 0 across both trees the rule covers, so the empty allowlist
    // is a statement about the whole codebase and not just about the mapper.
    //
    // THIS FILE IS EXEMPTED, and the exemption is the point rather than a
    // workaround: it names `as JsonObject` in its own docstrings and regexes, so
    // a text scan necessarily hits itself. That self-hit is also why the shipped
    // rule is an AST rule — `bun run lint` passes over this very file with
    // `allow: []` precisely because string literals and comments are not
    // assertions. Skipping it here keeps this test's text scan aligned with what
    // the rule actually enforces instead of contradicting it.
    const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
    const hits: string[] = [];
    for (const root of ["db", "src"]) {
      for (const file of walk(ROOT, root)) {
        if (!/\.tsx?$/.test(file)) continue;
        const relative = path.relative(ROOT, file);
        if (relative === SELF) continue;
        const text = readFileSync(file, "utf8");
        if (DENIED_SHAPE.test(text)) {
          hits.push(relative);
        }
      }
    }
    expect(
      hits,
      `assertions to a JSON type exist outside the allowlist: ${hits.join(", ")}`,
    ).toEqual([]);
  });
});
