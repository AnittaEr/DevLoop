import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

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
 * Known residual hole, recorded rather than hidden: this rule matches the
 * import SPECIFIER string, not the resolved path, so a deep relative path that
 * walks out of core without passing through a `plugins`/`providers` segment
 * would not be caught here. Closing that properly needs a resolver-aware rule,
 * which is out of scope for this card; the Vitest guard scans resolved paths and
 * remains the backstop.
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
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: CORE_PLUGIN_BOUNDARY_PATTERNS },
      ],
    },
  },
];

export default eslintConfig;
