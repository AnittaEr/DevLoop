import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import { coreBoundaryPlugin, RULE_ID } from "./eslint-plugin-core-boundary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * WHY THIS RULE EXISTS.
 *
 * The plugin boundary (60-agent-briefs.md hard rule 1 -- "no GitHub-specific
 * type may cross into the core app") was policed by exactly ONE file:
 * `src/core/__tests__/plugin-boundary.test.ts`. QA established while reviewing
 * t_7a135bf0 that deleting that file outright leaves the suite GREEN
 * (32 passed): a one-line commit removes the only defence of the one genuinely
 * non-negotiable invariant in this project, and nothing else notices. That is
 * the security risk this rule closes -- see the risk register (DevLoop-Docs
 * 30-risk-register.md, the "plugin boundary has no second line of defence"
 * entry under R1a) and hard rule 1 itself.
 *
 * The boundary now has TWO independent defences that fail differently. The
 * Vitest guard is a text scanner and can be deleted in one commit. THIS rule
 * lives in `eslint.config.mjs`, runs on every PR in CI, and removing it is a
 * visible one-line diff in a lint config that leaves the config visibly
 * incomplete -- a materially different review surface from deleting a test.
 *
 * SCOPE AND VOCABULARY. Derived from the imports this repo actually uses, not
 * from a vendor-shaped guess (D-060/D-085). Reading
 * `src/core/plugins/plugin.ts`, `src/core/plugins/registry.ts` and
 * `src/core/events/canonical-event.ts`: legitimate core code imports only
 * relative siblings -- `../events/canonical-event`, `./plugin`, `./registry` --
 * and nothing outside `src/core/`. The shapes a real violation takes are
 * (a) reaching the plugin/provider IMPLEMENTATION namespace via the `@/` alias
 * or a repo-rooted `src/` specifier, (b) a relative `../plugins/` or
 * `../providers/` hop out of core, (c) naming a provider SDK package. Those
 * three families, and nothing broader, are denied here.
 *
 * Note what is deliberately NOT denied, because a deny-list that flags
 * legitimate core imports is worse than having no rule: `node:*` builtins (the
 * Vitest guard itself imports `node:fs`/`node:path`/`node:url`), `vitest`, and
 * bare relative siblings within core -- including the one-level
 * `../events/canonical-event` hop that core code legitimately makes. Note too
 * that `src/core/plugins/**` is the plugin CONTRACT, not the implementation
 * namespace, so a core file importing the contract is correct and unmatched
 * here -- both `./plugin`/`./registry` (same-directory, never matched) and the
 * one-level `../plugins/plugin` / `../plugins/registry` hop from a file deeper
 * in the tree (matched by the family below and then explicitly negated there,
 * so the contract stays importable while `../plugins/<impl>` stays denied).
 * And every import made by `src/app/**` is exempt by design:
 * the composition root is SUPPOSED to import from core and wire concrete
 * plugins there. That is why this block is scoped to `src/core/**` and nothing
 * else, and why the ticket's negative control matters.
 *
 * KNOWN RESIDUAL HOLE — AND IT IS NO LONGER THE `../` ONE.
 *
 * This family list still matches the import SPECIFIER string rather than the
 * resolved path, so it is spelling-dependent: a relative hop count other than
 * the one written here is not matched by it. That hole WAS the one cubic raised
 * on PR #3 (finding 1: `../plugins/*` matches one `../` only, so
 * `../../plugins/x` and `../../../plugins/x` escaped lint), and it is now closed
 * by the resolver-aware rule in `eslint-plugin-core-boundary.mjs`, which is
 * registered below and loads AFTER this one so it can share the same scope
 * decision. The two overlap by design: the specifier families here are the
 * cheap, human-readable deny-list for `@/plugins/*`, `src/plugins/*`, the
 * provider SDKs and the one-hop `../` shape, and the resolver rule is the
 * hop-count-independent backstop underneath them. `core-boundary-guard-exists`
 * style tests in `src/core/__tests__/eslint-core-boundary-rule.test.ts` assert
 * both halves, including that the two neutral contracts stay importable.
 *
 * What is still not covered here, recorded rather than hidden: a specifier that
 * is neither relative nor in a family below (a new path alias, for instance)
 * would need adding to this list; and the rule deliberately does not attempt to
 * decide whether a plugin IMPLEMENTATION under `src/plugins/` is well-behaved,
 * only that `src/core/**` cannot reach it. The Vitest guard scans resolved paths
 * over the whole core tree and remains the independent third layer.
 */
const CORE_PLUGIN_BOUNDARY_PATTERNS = [
  {
    // The plugin / provider-IMPLEMENTATION namespace, via the `@/` alias or a
    // repo-rooted specifier.
    group: ["@/plugins/*", "src/plugins/*", "@/providers/*", "src/providers/*"],
    message:
      "Plugin boundary: src/core/** must not import the plugin/provider implementation namespace. Only the neutral contracts in src/core/plugins (SourcePlugin, PluginRegistry) and CanonicalEvent may cross in.",
  },
  {
    // A relative hop out of core into that same namespace.
    //
    // The two negations are load-bearing, not decoration. `../plugins/*` from a
    // file inside `src/core/**` resolves into `src/core/plugins/**`, which is
    // the plugin CONTRACT tree, not the implementation namespace -- so without
    // them the rule would forbid exactly the imports family 1's own message
    // promises are legal (`SourcePlugin`, `PluginRegistry`), and a deny-list that
    // flags legitimate core imports is worse than having no rule. Everything
    // else under that hop (e.g. `../plugins/github/impl`) is still denied.
    // Verified with real lint output in the T8 handoff: a core file importing
    // both contracts plus `../plugins/github/impl` errors on the impl line only.
    group: [
      "../plugins/*",
      "!../plugins/plugin",
      "!../plugins/registry",
      "../providers/*",
    ],
    message:
      "Plugin boundary: src/core/** must not import the plugin/provider implementation namespace.",
  },
  {
    // Provider SDK packages, by the vocabulary the codebase actually uses.
    group: ["@octokit/*", "@gitlab/*", "@azure-devops/*", "@bitbucket/*"],
    message:
      "Plugin boundary: src/core/** must not depend on a provider SDK. Provider SDKs belong behind a plugin implementation.",
  },
];

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript", "prettier"),
  {
    // Scoped to core ONLY. See the comment above for why src/app/** is exempt.
    files: ["src/core/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    plugins: { "core-boundary": coreBoundaryPlugin },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: CORE_PLUGIN_BOUNDARY_PATTERNS },
      ],
      // The hop-count-independent half. Scoped to the same `src/core/**` files
      // and deliberately a SEPARATE rule from `no-restricted-imports` so that
      // removing the specifier list cannot silently take the resolver with it:
      // the two fail for different reasons and are deleted by different edits.
      [RULE_ID]: "error",
    },
  },
];

export default eslintConfig;
