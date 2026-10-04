/**
 * Meta test for the RESOLVER-AWARE plugin-boundary lint rule.
 *
 * The plugin boundary (60-agent-briefs.md hard rule 1) has two independent
 * defences that fail differently: the Vitest text scanner in
 * `plugin-boundary.test.ts`, and lint in `eslint.config.mjs`. The lint half had
 * a real hole, raised as cubic's finding 1 on PR #3 and reproduced by execution
 * against merged `main` `b277d96`: its relative family matched exactly ONE `..`
 * hop, so a core file at `src/core/a/b/` could import three levels up and out
 * and lint clean.
 *
 * `eslint-plugin-core-boundary.mjs` closes that by resolving the specifier
 * against the importing file's directory and comparing the normalised absolute
 * path, so hop count stops mattering. The point of THIS file is that the rule
 * cannot be quietly deleted, weakened, or reverted to a one-hop glob without
 * turning the suite RED — the same defect class as
 * `boundary-guard-exists.test.ts`, which exists because QA measured that
 * deleting the Vitest guard left the suite green.
 *
 * It drives the real rule through ESLint's own `Linter`, so a passing case means
 * the CONFIGURED rule fires, not that a copy of it inside this file fires.
 *
 * WHY THE FIXTURES ARE ASSEMBLED FROM PATH SEGMENTS RATHER THAN WRITTEN LITERALLY.
 *
 * A literal `"../../../plugins/acme/impl"` in a fixture would be a live escape
 * shape sitting in a core source file, which is exactly what
 * `plugin-boundary.test.ts` scans for. Building the specifier from parts keeps
 * this file clean under that scanner by construction rather than by carve-out,
 * so the two defences in this repo do not fight each other.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import eslintConfig from "../../../eslint.config.mjs";
import {
  coreBoundaryPlugin,
  resolveRelativeSpecifier,
  RULE_ID,
} from "../../../eslint-plugin-core-boundary.mjs";

/**
 * The repo root, derived from this file's own location rather than from `cwd`.
 *
 * This file is `<root>/src/core/__tests__/<name>.ts`, so the root is three
 * levels up from its directory. A test that trusted `process.cwd()` would
 * silently start asserting against the wrong tree depending on where Vitest was
 * invoked from, which is precisely the class of green-but-wrong claim this whole
 * meta-test genre exists to prevent. `fileURLToPath` rather than `URL.pathname`
 * because the latter is percent-encoded and breaks on any path with a space.
 */
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * The implementation namespace segment, assembled at runtime.
 *
 * `plugin-boundary.test.ts` scans every core source file and flags a provider
 * namespace path segment appearing on an import-shaped line. The fixtures below
 * genuinely need that segment, so it is built from two halves: this file stays
 * clean under that scanner by construction rather than by being carved out of
 * it, so the two defences in this repo do not have to fight each other.
 */
const NS = `${"plug"}${`ins`}`;

/**
 * A provider-SDK specifier, assembled at runtime for the same reason as `NS`.
 *
 * `plugin-boundary.test.ts` flags the provider SDK token and the `@<sdk>/`
 * pattern on any import-shaped line in core, and this file is NOT self-skipped
 * (only the scanner's own file is). Its positive-control block gets away with a
 * literal SDK specifier for exactly that reason. A literal here would be a real
 * provider-SDK import sitting in a core source file, which is the thing this
 * whole repo exists to prevent — so these fixtures are assembled instead.
 *
 * Naming the token in this comment would fail the scanner too, and correctly:
 * block comments are deliberately NOT stripped, because a provider token inside
 * one is a failure by design.
 */
const SDK = `@${"octo"}kit/rest`;

/** A path inside `src/core/**` at an arbitrary depth, used as `filename`. */
function coreFile(...segments: string[]): string {
  return [ROOT, "src", "core", ...segments].join("/");
}

/**
 * Assemble an escaping specifier without writing it as a literal.
 *
 * `rest` is joined with a "/": passing bare segments (`escapeSpecifier(1, NS,
 * "acme")`) would silently produce "pluginsacme" and the fixture would resolve
 * somewhere harmless, turning a MUST-FIRE case into a vacuous one. Callers pass
 * a single pre-joined remainder (`escapeSpecifier(1, `${NS}/acme`)`).
 */
function escapeSpecifier(hops: number, remainder: string): string {
  return "../".repeat(hops) + remainder;
}

const linter = new Linter({ configType: "flat" });

/**
 * Lint `code` as if it lived at `filename`; return only this rule's messages.
 *
 * The config is built through a single cast because ESLint's flat-config type
 * wants `plugins` as `Record<string, ESLint.Plugin>` while the plugin object
 * here is inferred from plain JS. The cast is confined to this helper so the
 * assertions below read as ordinary string comparisons.
 *
 * `coreOnly` is the same shape the real `eslint.config.mjs` uses, and it is the
 * default on purpose: these cases assert the rule fires on files that scope
 * covers. The out-of-scope case passes `false` to widen the glob, so what it
 * measures is the rule's OWN `src/core/**` check rather than the glob's.
 */
function lint(filename: string, code: string, coreOnly = true): string[] {
  // Both details here are load-bearing and were found the hard way.
  //
  // 1. The config must be an ARRAY carrying a `files` glob. Given a bare object
  //    with no `files`, `Linter` returns a single "No matching configuration
  //    found" warning and ZERO rule messages — so every negative assertion below
  //    would have passed for the wrong reason, and every positive one would have
  //    failed for a reason that had nothing to do with the rule.
  // 2. The glob must be `src/core/**/*.ts` rather than `**/*`, because ESLint's
  //    flat matcher does not treat a bare `**/*` as matching an absolute path
  //    supplied as `filename`.
  const config = [
    {
      files: [coreOnly ? "src/core/**/*.{ts,tsx}" : "src/**/*.{ts,tsx}"],
      plugins: { "core-boundary": coreBoundaryPlugin },
      rules: { [RULE_ID]: "error" },
    },
  ] as unknown as Linter.Config[];
  const messages = linter.verify(code, config, filename);
  // A "no matching configuration" warning means the rule never ran, which would
  // make a `toEqual([])` assertion vacuously true. Fail loudly instead.
  const unconfigured = messages.filter((m) => m.ruleId === null);
  expect(
    unconfigured.map((m) => m.message),
    `the flat config did not apply to ${filename}, so the rule never ran`,
  ).toEqual([]);
  return messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.message);
}

describe("core-boundary lint rule: hop count is irrelevant", () => {
  // The regression itself. Both of these linted CLEAN before this rule existed.
  it("denies a TWO-hop escape", () => {
    const spec = escapeSpecifier(2, `${NS}/acme/impl`);
    const messages = lint(
      coreFile("a", "b", "b14-twohop.ts"),
      `import "${spec}";\n`,
    );
    expect(messages.length, `expected a report for ${spec}`).toBe(1);
    // The message names the RESOLVED path, which is what makes the denial
    // legible in review: the reader does not have to count `../` themselves.
    expect(messages[0]).toContain(`src/core/${NS}/acme/impl`);
  });

  it("denies a THREE-hop escape", () => {
    const spec = escapeSpecifier(3, `${NS}/acme/impl`);
    const messages = lint(
      coreFile("a", "b", "b", "b14-threehop.ts"),
      `import "${spec}";\n`,
    );
    expect(messages.length, `expected a report for ${spec}`).toBe(1);
    expect(messages[0]).toContain(`src/core/${NS}/acme/impl`);
  });

  it("denies the same escape at EVERY hop count from 1 to 8", () => {
    // The importing file is placed at the depth that makes N hops land on the
    // SAME destination each time, which is the point: identical destination,
    // different spelling. A file at `src/core/<N dirs>/f.ts` reaching N levels
    // up resolves to `src/core/<target>` for every N.
    for (let hops = 1; hops <= 8; hops += 1) {
      const spec = escapeSpecifier(hops, `${NS}/acme/impl`);
      const depth = Array.from({ length: hops }, (_, i) => `d${i}`);
      const messages = lint(
        coreFile(...depth, "hop.ts"),
        `import "${spec}";\n`,
      );
      expect(messages, `hop count ${hops} escaped the rule`).toHaveLength(1);
      expect(messages[0]).toContain(`src/core/${NS}/acme/impl`);
    }
  });

  it("denies a sibling `providers` namespace at depth too", () => {
    const spec = escapeSpecifier(3, "providers/acme/impl");
    expect(
      lint(coreFile("a", "b", "b", "providers.ts"), `import "${spec}";\n`),
    ).toHaveLength(1);
  });
});

describe("core-boundary lint rule: the neutral contracts stay importable", () => {
  // This is what makes the rule safe to add: a deny-list that flags legitimate
  // core imports is worse than having no rule, which is why the old
  // `../plugins/*` family carried two negations in the first place.
  it("allows both contracts from a file one level below them", () => {
    for (const name of ["plugin", "registry"]) {
      const spec = escapeSpecifier(1, `${NS}/${name}`);
      expect(
        lint(coreFile("events", `use-${name}.ts`), `import "${spec}";\n`),
        `${spec} must stay importable`,
      ).toEqual([]);
    }
  });

  it("allows both contracts at THREE hops, which the old one-hop negation could not", () => {
    for (const name of ["plugin", "registry"]) {
      const spec = escapeSpecifier(3, `${NS}/${name}`);
      expect(
        lint(
          coreFile("d0", "d1", "d2", `deep-${name}.ts`),
          `import "${spec}";\n`,
        ),
        `${spec} must stay importable`,
      ).toEqual([]);
    }
  });

  it("allows a contract named with an explicit extension", () => {
    const spec = escapeSpecifier(1, `${NS}/plugin.ts`);
    expect(lint(coreFile("events", "ext.ts"), `import "${spec}";\n`)).toEqual(
      [],
    );
  });

  it("still denies everything else under the contract directory", () => {
    // The exemption is two resolved PATHS, not "the plugins directory", so a
    // sibling module in the same directory is not accidentally legal. This is
    // the case the old `!../plugins/plugin` negation could NOT express.
    const spec = escapeSpecifier(1, `${NS}/acme`);
    expect(
      lint(coreFile("events", "sibling.ts"), `import "${spec}";\n`),
    ).toHaveLength(1);
  });
});

describe("core-boundary lint rule: it is resolver-based, not a text match", () => {
  it("collapses any hop count to the same resolved path", () => {
    // Depth and hop count must AGREE or the two specifiers land in different
    // places and the comparison is meaningless. Five dirs below src/core, five
    // hops up, therefore always src/core.
    const from = coreFile("d0", "d1", "d2", "d3", "d4", "f.ts");
    const two = resolveRelativeSpecifier(from, escapeSpecifier(2, `${NS}/x`));
    const five = resolveRelativeSpecifier(from, escapeSpecifier(5, `${NS}/x`));
    expect(two).toBe(`${ROOT}/src/core/d0/d1/d2/${NS}/x`);
    expect(five).toBe(`${ROOT}/src/core/${NS}/x`);
    // And from a file at the matching depth, every hop count collapses.
    // One level deeper, six hops: `path.resolve` collapses the extra `..` and
    // both land on the same place, which is exactly the property being relied on.
    const deep = coreFile("d0", "d1", "d2", "d3", "d4", "d5", "f.ts");
    expect(resolveRelativeSpecifier(deep, escapeSpecifier(6, `${NS}/x`))).toBe(
      `${ROOT}/src/core/${NS}/x`,
    );
  });

  it("returns null for a bare package specifier, which is not a repo path", () => {
    // Renamed from "returns null for a non-relative specifier, so aliases are not
    // this rule's job": that claim became FALSE when the alias half landed, and
    // leaving the old title in place would have kept asserting an idealised
    // version of the resolver — exactly the defect class D-100 is about. `zod`
    // and `node:fs` are still null, for the reason the new title states.
    expect(resolveRelativeSpecifier(coreFile("f.ts"), "zod")).toBeNull();
    expect(resolveRelativeSpecifier(coreFile("f.ts"), "node:fs")).toBeNull();
    expect(resolveRelativeSpecifier(coreFile("f.ts"), SDK)).toBeNull();
  });

  it("denies an escape into src/plugins/ even though that directory does not exist on this base", () => {
    // The requirement that the pattern must not work only by accident of the
    // current tree. `path.resolve` performs no filesystem access, so a denied
    // root that is absent is still a valid string prefix. The assertion is on
    // the resolved path rather than on the filesystem, so this test keeps its
    // meaning unchanged once src/plugins is created.
    // Four dirs below src/core plus one more hop leaves src/core itself, so six
    // hops out of src/plugins/ — a directory this base does not have.
    const from = coreFile("d0", "d1", "d2", "d3", "d4", "f.ts");
    const spec = escapeSpecifier(6, `${NS}/acme/impl`);
    expect(resolveRelativeSpecifier(from, spec)).toBe(
      `${ROOT}/src/${NS}/acme/impl`,
    );
    expect(lint(from, `import "${spec}";\n`)).toHaveLength(1);
  });
});

describe("core-boundary lint rule: no non-import way around it", () => {
  it("denies a re-export", () => {
    const spec = escapeSpecifier(2, `${NS}/acme/impl`);
    expect(
      lint(coreFile("a", "b", "reexport.ts"), `export { x } from "${spec}";\n`),
    ).toHaveLength(1);
  });

  it("denies `export *`", () => {
    const spec = escapeSpecifier(2, `${NS}/acme/impl`);
    expect(
      lint(coreFile("a", "b", "star.ts"), `export * from "${spec}";\n`),
    ).toHaveLength(1);
  });

  it("denies a dynamic import()", () => {
    // `import("…")` is an ImportExpression node, not a CallExpression. Without
    // its own visitor this is a one-line bypass of the entire rule.
    const spec = escapeSpecifier(3, `${NS}/acme/impl`);
    expect(
      lint(
        coreFile("a", "b", "b", "dyn.ts"),
        `export async function f() { return import("${spec}"); }\n`,
      ),
    ).toHaveLength(1);
  });

  it("denies a require()", () => {
    const spec = escapeSpecifier(2, `${NS}/acme/impl`);
    expect(
      lint(coreFile("a", "b", "req.ts"), `const m = require("${spec}");\n`),
    ).toHaveLength(1);
  });
});

describe("core-boundary lint rule: the `@/` alias escape (B17)", () => {
  // The hole this block closes, and the reason it was worse than a lint gap.
  //
  // `tsconfig.json` maps `@/*` -> `./src/*`, so
  // `@/core/../plugins/acme/impl` names `src/plugins/acme/impl` while
  // containing no glob-matchable substring. At B14's approved head 59f0171 the
  // shape was accepted by ALL FOUR defences at once: this rule returned `null`
  // for it (it resolved only RELATIVE specifiers), `no-restricted-imports`
  // matched the specifier string and found nothing, the Vitest scanner needed
  // `plugins/` to follow a quote or a slash and found nothing, and `tsc`
  // resolved it cleanly. The boundary (hard rule 1) was enforced by nothing.
  //
  // The fix is in the resolver, not in a glob: the alias is mapped to its
  // target directory and then run through the same `path.resolve` +
  // denied-roots comparison every hop count already used.

  /** Assemble the escaping alias specifier without writing it as a literal. */
  const aliasEscape = (prefix: string, remainder: string): string =>
    `${prefix}${NS}/${remainder}`;

  it("DENIES `@/core/../plugins/acme/impl` — the shape all four gates accepted at base", () => {
    const spec = aliasEscape("@/core/../", "acme/impl");
    const messages = lint(
      coreFile("b17-alias-escape.ts"),
      `import "${spec}";\n`,
    );
    expect(messages.length, `expected a report for ${spec}`).toBe(1);
    // The message names the RESOLVED destination, which is what makes the denial
    // legible in review and proves the rule fired on WHERE IT LANDS, not on a
    // substring.
    expect(messages[0]).toContain(`src/${NS}/acme/impl`);
  });

  it("denies the alias escape through every non-import door as well", () => {
    // If the fix were applied only to `ImportDeclaration`, these four would be
    // one-line bypasses and the suite would still be green.
    const spec = aliasEscape("@/core/../", "acme/impl");
    for (const [label, code] of [
      ["re-export", `export { x } from "${spec}";\n`],
      ["export *", `export * from "${spec}";\n`],
      [
        "dynamic import",
        `export async function f() { return import("${spec}"); }\n`,
      ],
      ["require", `const m = require("${spec}");\n`],
    ] as const) {
      expect(
        lint(coreFile("a", "b", `b17-${label}.ts`), code),
        `${label} must not be a way around the alias normalisation`,
      ).toHaveLength(1);
    }
  });

  it("denies the OTHER alias spellings of the same destination, not just the reported one", () => {
    // This is the anti-deny-list assertion. `@/core/./../plugins`, `@/providers/…`
    // and the repo-rooted `src/plugins/…` all reach a denied directory and none
    // of them is the string the PM reported. They are denied because they
    // RESOLVE into a denied root, so a spelling nobody has thought of yet is
    // denied for the same reason.
    for (const spec of [
      aliasEscape("@/core/./../", "acme/impl"),
      "@/providers/acme/impl",
      "src/providers/acme/impl",
      `@/${NS}/../${NS}/acme/impl`,
    ]) {
      expect(
        lint(coreFile("b17-spelling.ts"), `import "${spec}";\n`),
        `${spec} must be denied by resolution`,
      ).toHaveLength(1);
    }
  });

  it("keeps the neutral contracts importable THROUGH THE ALIAS at one hop", () => {
    // The acceptance criterion that stops a resolver fix becoming a blunt
    // "reject every alias import". These three are the whole legal crossing.
    for (const spec of [
      "@/core/plugins/plugin",
      "@/core/plugins/registry",
      "@/core/events/canonical-event",
    ]) {
      expect(
        lint(coreFile("events", "b17-onehop.ts"), `import "${spec}";\n`),
        `${spec} must stay importable via the alias`,
      ).toEqual([]);
    }
  });

  it("keeps them importable at THREE hops and via `export *`", () => {
    for (const spec of [
      "@/core/plugins/plugin",
      "@/core/plugins/registry",
      "@/core/events/canonical-event",
    ]) {
      const deep = coreFile("d0", "d1", "d2", "b17-threehop.ts");
      expect(
        lint(deep, `import "${spec}";\n`),
        `${spec} must stay importable at depth`,
      ).toEqual([]);
      expect(
        lint(deep, `export * from "${spec}";\n`),
        `${spec} must stay re-exportable`,
      ).toEqual([]);
    }
  });

  it("still denies an implementation under the contract directory reached VIA THE ALIAS", () => {
    // `@/core/plugins/acme` is a sibling of the two contracts inside the contract
    // tree. Resolving it must not be mistaken for resolving a contract: the
    // exemption is two PATHS, not "the plugins directory".
    const spec = `@/core/${NS}/acme`;
    expect(
      lint(coreFile("events", "b17-sibling.ts"), `import "${spec}";\n`),
    ).toHaveLength(1);
  });

  it("does not fire outside src/core even for the alias escape", () => {
    // `coreOnly = false` widens the flat-config glob to `src/**` so the rule
    // genuinely executes on this file. Measured with the narrow glob it would
    // never run, and the assertion would be measuring the config — which is
    // how B14's MUST-FIRE control came out green for the wrong reason.
    const spec = aliasEscape("@/core/../", "acme/impl");
    expect(
      lint(`${ROOT}/src/app/b17-wiring.tsx`, `import "${spec}";\n`, false),
      "src/app is the composition root and is supposed to wire plugins",
    ).toEqual([]);
  });

  it("does not fire on a bare package specifier that merely looks alias-shaped", () => {
    // `@scope/name` is a PACKAGE, not this repo's `@/` alias. Treating every
    // `@`-prefixed specifier as a path would deny the provider SDKs by accident
    // here and — worse — deny any legitimate dependency.
    for (const spec of [SDK, "@testing-library/react", "zod"]) {
      expect(
        lint(coreFile("a", "b", "b17-pkg.ts"), `import "${spec}";\n`),
        `${spec} must not be treated as a path alias`,
      ).toEqual([]);
    }
  });

  it("normalises the alias to the tsconfig target rather than to a guess", () => {
    // The mapping is asserted against the resolved path rather than observed,
    // so this keeps its meaning if the alias target ever moves.
    const from = coreFile("f.ts");
    expect(resolveRelativeSpecifier(from, "@/core/plugins/plugin")).toBe(
      `${ROOT}/src/core/${NS}/plugin`,
    );
    expect(resolveRelativeSpecifier(from, `src/${NS}/acme/impl`)).toBe(
      `${ROOT}/src/${NS}/acme/impl`,
    );
  });

  it("every alias in tsconfig paths is normalised by the rule", () => {
    // The alias table lives in the plugin module (so the rule stays
    // dependency-free and does no I/O), which creates a new way for the boundary
    // to rot: someone adds an alias to tsconfig and forgets the rule. Compare the
    // two and the suite goes RED instead of the hole opening silently. This is
    // the guard against the "one more spelling" class the ticket warns about.
    const tsconfig = JSON.parse(
      readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    const declared = Object.keys(tsconfig.compilerOptions?.paths ?? {});
    expect(declared.length).toBeGreaterThan(0);
    for (const alias of declared) {
      // Each declared alias must resolve to a path inside src/, which is what
      // PATH_ALIASES is keyed on. An alias pointing anywhere else needs the rule
      // extended and this test updated deliberately.
      const target = (tsconfig.compilerOptions?.paths ?? {})[alias]?.[0] ?? "";
      expect(
        path.isAbsolute(target) ? false : target.startsWith("./src/"),
        `alias ${alias} targets ${target}, which this rule does not normalise`,
      ).toBe(true);
      // tsconfig keys are patterns (`@/*`) while the rule keys on the concrete
      // prefix (`@/`), so drop the wildcard before probing.
      expect(
        resolveRelativeSpecifier(
          coreFile("f.ts"),
          `${alias.replace("*", "")}probe/x`,
        ),
        `${alias} is declared in tsconfig but not normalised by the rule`,
      ).toBe(`${ROOT}/src/probe/x`);
    }
  });
});

describe("core-boundary lint rule: the lint helper cannot false-green", () => {
  it("throws rather than returning [] when the config does not apply", () => {
    // The single most likely way this whole block produces a green suite that
    // asserts nothing: a flat config with no `files` (or a glob that matches
    // nothing) yields ONE `ruleId: null` warning and ZERO rule messages, so
    // every `toEqual([])` above would pass for the wrong reason and every
    // `toHaveLength(1)` would fail for an unrelated one. The `lint` helper
    // already asserts this on every call; this case proves the assertion is
    // live rather than trusting that it is.
    const broken = [
      { rules: { [RULE_ID]: "error" } },
    ] as unknown as Linter.Config[];
    const messages = linter.verify(`import "x";\n`, broken, coreFile("f.ts"));
    expect(
      messages.some((m) => m.ruleId === null),
      "expected the unloaded config to surface a ruleId-less message",
    ).toBe(true);
    // And therefore the helper's own guard has something real to catch.
    expect(() => lint(`${ROOT}/not-core/file.ts`, `import "x";\n`)).toThrow();
  });
});

describe("core-boundary lint rule: scope and non-regression", () => {
  it("does not fire outside src/core — src/app is the composition root", () => {
    const spec = escapeSpecifier(1, `${NS}/acme/impl`);
    // `coreOnly = false` widens the flat-config glob to all of `src/**`, so the
    // rule really executes on this file. With the narrow glob it would not run
    // at all and the assertion would be measuring the config, not the rule.
    expect(
      lint(`${ROOT}/src/app/page.tsx`, `import "${spec}";\n`, false),
    ).toEqual([]);
  });

  it("does not fire on a bare relative sibling inside core", () => {
    expect(
      lint(coreFile("events", "sib.ts"), `import "./canonical-event";\n`),
    ).toEqual([]);
    expect(
      lint(
        coreFile("a", "b", "sib.ts"),
        `import "${escapeSpecifier(2, "events/canonical-event")}";\n`,
      ),
    ).toEqual([]);
  });

  it("does not fire on a builtin or a package import", () => {
    expect(
      lint(coreFile("a", "pkg.ts"), `import fs from "node:fs";\n`),
    ).toEqual([]);
    expect(lint(coreFile("a", "dep.ts"), `import { z } from "zod";\n`)).toEqual(
      [],
    );
  });

  it("is registered in eslint.config.mjs under its own rule id", () => {
    // Every case above drives the plugin object directly, so they would all
    // still pass if the config stopped enabling the rule — leaving the repo
    // with no protection while the suite stayed green. Reading the config as
    // text closes that gap, and it is the same trick
    // `boundary-guard-exists.test.ts` uses on the Vitest guard.
    const source = readFileSync(path.join(ROOT, "eslint.config.mjs"), "utf8");
    // The config imports RULE_ID and uses it as a computed key, so the literal
    // id never appears in its text. What must be there is the computed-key form
    // plus the plugin registration — dropping either silently disables the rule.
    expect(source).toContain("[RULE_ID]");
    expect(source).toContain("coreBoundaryPlugin");
    expect(source).toContain("eslint-plugin-core-boundary.mjs");

    // Reading the text proves the KEYS are present; it does not prove the rule
    // is actually enabled on any file. Load the real config and check the
    // resolved value, so de-registering the rule by any means — deleting the
    // key, downgrading it to "off"/"warn", or dropping the whole config block —
    // fails HERE, naming this case, rather than passing on the strength of the
    // surrounding strings still being present.
    const config = eslintConfig as unknown as Linter.Config[];
    const scoped = config.filter((entry) => entry.plugins?.["core-boundary"]);
    expect(
      scoped.length,
      "no config block registers the core-boundary plugin",
    ).toBeGreaterThan(0);
    for (const entry of scoped) {
      expect(
        (entry.rules as Record<string, unknown>)[RULE_ID],
        `${RULE_ID} is not enabled as "error" on ${JSON.stringify(entry.files)}`,
      ).toBe("error");
      // And the resolver rule must be scoped to core exactly as the text-above
      // case describes; a glob that silently stopped matching src/core would
      // leave the boundary undefended while the key was still present.
      expect(
        JSON.stringify(entry.files),
        `${RULE_ID} is not scoped to src/core`,
      ).toContain("src/core/");
    }
  });

  it("carries no comment in the config claiming the ../ hole is still open", () => {
    // D-100: a guard's own comment is an acceptance criterion, and a comment
    // describing an idealised version of the guard is what hid cubic's finding 4
    // for two integration cycles. If the hole is closed, the config must not
    // still say closing it is out of scope.
    const source = readFileSync(path.join(ROOT, "eslint.config.mjs"), "utf8");
    expect(source).not.toMatch(/resolver-aware rule, which is out of scope/);
  });

  it("the plugin module is a real file with real content, not an empty stub", () => {
    const modulePath = path.join(ROOT, "eslint-plugin-core-boundary.mjs");
    expect(statSync(modulePath).isFile()).toBe(true);
    expect(readFileSync(modulePath, "utf8").split("\n").length).toBeGreaterThan(
      80,
    );
  });
});
