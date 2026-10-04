/**
 * The RESOLVER-AWARE half of the plugin boundary's second line of defence.
 *
 * WHY THIS IS NOT IN `eslint.config.mjs` AS A PATTERN LIST.
 *
 * `no-restricted-imports` with `patterns:` matches the import SPECIFIER string.
 * A specifier is written relative to the importing file, so the same text means
 * a different path from a different directory, and no single glob can express
 * "a `../` hop of any hop count". The batch-3 config tried
 * (`../plugins/*`) and matched exactly ONE hop: from
 * `src/core/events/foo.ts`, `../../plugins/x` and `../../../plugins/x` both
 * slipped through. That was cubic's finding 1 on PR #3, reproduced by
 * execution against merged `main` `b277d96`.
 *
 * The fix is to stop matching the string and match the DESTINATION: resolve
 * the relative specifier against the directory of the importing file, normalise
 * it, and ask whether the resulting absolute path lands in an
 * implementation namespace. `../`, `../../` and `../../../` then behave
 * identically, because none of them is ever inspected as text -- they are
 * collapsed by `path.resolve` before the comparison. There is no hop count to
 * get wrong, and no pattern that only works by accident of the current tree.
 *
 * WHAT "THE IMPLEMENTATION NAMESPACE" MEANS HERE, AND WHY IT STILL HOLDS ONCE
 * `src/plugins/` EXISTS.
 *
 * The denied roots are computed as absolute paths from this file's own
 * location, i.e. from the repo root, rather than by walking the tree looking
 * for a directory that may not be there yet. `path.resolve` does no
 * filesystem access, so a denied root that does not exist yet is still a valid
 * string prefix and a specifier pointing into it is still denied. Concretely:
 * when `src/plugins/` is created (it does not exist on this base -- `git
 * ls-tree -r HEAD -- src` shows no such path), a core file importing
 * `../../plugins/acme/impl` resolves to
 * `<root>/src/plugins/acme/impl`, which is inside `<root>/src/plugins`, and is
 * denied on the very first lint run after that directory appears -- no config
 * edit, no new rule, nothing to remember. That is the difference between this
 * and a glob that would quietly stop matching.
 *
 * The two NEUTRAL contracts are exempted by RESOLVED PATH EQUALITY rather than
 * by negating a text pattern. `<root>/src/core/plugins/plugin` and
 * `<root>/src/core/plugins/registry` are the only two modules of the contract
 * that core code may import, so the exemption is exactly those two paths, and
 * it is spelling-independent: `../plugins/plugin`, `../../core/plugins/plugin`
 * and an extension-bearing form all resolve to the same file and are all
 * allowed, while `../plugins/acme/impl` -- which the old `../plugins/*` family
 * denied and which this also denies -- is not. Same two exemptions, at least
 * as precise, and no longer dependent on how many `../` the author typed.
 *
 * SCOPE. Only files INSIDE `src/core/**` are checked, exactly as the batch-3
 * rule was scoped: `src/app/**` is the composition root and is supposed to
 * import core and wire concrete plugins there.
 *
 * WHAT THE ALIAS HALF ADDS, AND WHY IT IS NOT A DENY-LIST ENTRY.
 *
 * The rule resolves the `../` spelling by matching the DESTINATION. The `@/`
 * alias needed the same treatment: `tsconfig.json` maps `@/*` to `./src/*`, so
 * `@/core/../plugins/acme/impl` names `src/plugins/acme/impl` while containing
 * no glob-matchable substring. Every defence in this repo accepted that
 * spelling — this rule returned `null` for it (it only resolved RELATIVE
 * specifiers), `no-restricted-imports` matched the string, the Vitest scanner
 * needed `plugins/` to follow a quote or a slash, and `tsc` resolved it
 * happily. Mapping the alias to a directory and then running the SAME
 * `path.resolve` + denied-roots comparison makes the escape fail for a reason
 * (where does it land?) rather than for a reason (what does it look like?), so
 * the next spelling cannot re-open it.
 *
 * This module exports the flat-config plugin object and the rule so that
 * `src/core/__tests__/eslint-core-boundary-rule.test.ts` can exercise the rule
 * directly; the guard's behaviour is asserted by tests, not by reading it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, from this file's own location. Never derived from cwd. */
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(ROOT_DIR, "src");
const CORE_DIR = path.join(SRC_DIR, "core");

/**
 * The tsconfig `paths` aliases, as prefix -> absolute target directory.
 *
 * WHY AN `@/` SPECIFIER WAS PREVIOUSLY UNRESOLVABLE, AND WHAT THAT COST.
 *
 * This rule originally returned `null` for every non-relative specifier, so
 * `@/...` fell out of the resolver entirely and was left to the specifier
 * deny-list in `eslint.config.mjs`. That list matches the SPECIFIER STRING,
 * and the alias makes a specifier that names a denied path without containing
 * a denied substring: `@/core/../plugins/acme/impl` reaches
 * `src/plugins/acme/impl` but the substring `plugins/` follows `../` rather
 * than a quote or a slash, so no glob in the list matches it. The shape was
 * accepted by this rule, by `no-restricted-imports`, by the Vitest scanner and
 * by `tsc` — the plugin boundary (hard rule 1) was enforced by nothing at all
 * on that spelling. Normalising the alias HERE means the escape is caught by
 * the same resolution-based comparison as every `../` hop count, so the next
 * spelling (`@/core/./../plugins`, `@/providers/...`, a repo-rooted
 * `src/plugins/...`) is caught for the same reason rather than by a new glob.
 *
 * The key is the alias PREFIX and the value its target DIRECTORY, so one entry
 * covers every specifier under that alias. These are declared here rather than
 * read from `tsconfig.json` at lint time so the rule stays dependency-free and
 * performs no I/O; a test asserts this table still matches
 * `tsconfig.json`'s `compilerOptions.paths`, so adding an alias there without
 * adding it here turns the suite RED instead of silently opening a new hole.
 */
const PATH_ALIASES = new Map([
  ["@/", SRC_DIR],
  // `src/plugins/acme/impl` is repo-root-relative rather than alias-relative,
  // but it names the same destination and is denied by the same comparison,
  // so it is normalised here too instead of being enumerated in a glob.
  ["src/", SRC_DIR],
]);

/**
 * Directories a `src/core/**` file may not resolve an import into.
 *
 * The two under `src/core/` are the contract trees: everything in them is
 * denied EXCEPT the two files in `ALLOWED_CONTRACTS` below, which preserves the
 * intent of the old `../plugins/*` + `!../plugins/plugin` + `!../plugins/registry`
 * family exactly. The two under `src/` are the implementation namespaces and
 * have no exemption at all.
 */
const DENIED_DIRS = Object.freeze([
  path.join(SRC_DIR, "plugins"),
  path.join(SRC_DIR, "providers"),
  path.join(CORE_DIR, "plugins"),
  path.join(CORE_DIR, "providers"),
]);

/**
 * The neutral contracts. `SourcePlugin` / `PluginRegistry` / `CanonicalEvent`
 * are the only things allowed to cross the boundary in either direction, so
 * these two resolved paths are the whole exemption list.
 */
const ALLOWED_CONTRACTS = new Set([
  path.join(CORE_DIR, "plugins", "plugin"),
  path.join(CORE_DIR, "plugins", "registry"),
]);

/** A source-file extension to strip before comparing paths. */
const SOURCE_SUFFIX = /\.[cm]?[jt]sx?$/;

/** True when `target` is `dir` itself or lives underneath it. */
function isInside(dir, target) {
  return target === dir || target.startsWith(dir + path.sep);
}

/**
 * Normalise one alias-prefixed specifier to a repo-relative path, or `null`.
 *
 * `@/x` becomes `<SRC_DIR>/x` and `src/x` becomes the same, which is then
 * collapsed by `path.resolve`/`path.normalize` exactly like a `../` hop. The
 * crucial property is that this happens BEFORE the denied-roots comparison, so
 * the destination is what decides, not the spelling.
 *
 * `path.resolve` on the mapped value is what makes `../` inside the alias
 * harmless-but-correct: `@/core/../plugins/acme/impl` maps to
 * `<SRC_DIR>/core/../plugins/acme/impl`, and resolving normalises that to
 * `<SRC_DIR>/plugins/acme/impl` — the plugin implementation namespace, denied.
 *
 * Returns `null` for a bare package specifier (`zod`, `node:fs`,
 * `@octokit/rest`): those are not repo paths and are out of this rule's reach.
 * Note the asymmetry with `@/`, which is deliberately NOT a package specifier —
 * it is this repo's own path alias, and a bare `@scope/name` is.
 */
function resolveAliasSpecifier(specifier) {
  for (const [prefix, targetDir] of PATH_ALIASES) {
    if (!specifier.startsWith(prefix)) continue;
    return path
      .resolve(targetDir, specifier.slice(prefix.length))
      .replace(SOURCE_SUFFIX, "");
  }
  return null;
}

/**
 * Resolve a module specifier to a normalised, extension-less absolute path, or
 * `null` when it names neither a relative path nor a known alias.
 *
 * Exported for the test, which asserts the hop-collapse and alias-collapse
 * properties directly. The name keeps `Relative` in it deliberately: the
 * `returns null for a non-relative specifier` case in the test file is renamed
 * in the same commit so it cannot keep asserting the old, now-false claim that
 * an alias specifier is unresolvable.
 */
export function resolveRelativeSpecifier(filename, specifier) {
  if (typeof specifier !== "string") return null;
  if (specifier.startsWith(".")) {
    return path
      .resolve(path.dirname(filename), specifier)
      .replace(SOURCE_SUFFIX, "");
  }
  return resolveAliasSpecifier(specifier);
}

/** Repo-relative, forward-slashed form of an absolute path, for messages. */
function displayPath(absolute) {
  return path.relative(ROOT_DIR, absolute).split(path.sep).join("/");
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Deny a src/core/** file from importing the plugin/provider implementation namespace, at any ../ hop count.",
    },
    schema: [],
    messages: {
      escape:
        "Plugin boundary: {{from}} resolves to {{to}}, which is inside the plugin/provider implementation namespace. Only the neutral contracts src/core/plugins/plugin, src/core/plugins/registry and src/core/events/canonical-event may cross into src/core/**.",
    },
  },
  create(context) {
    const filename = context.filename;
    if (
      typeof filename !== "string" ||
      !isInside(CORE_DIR, path.resolve(filename))
    ) {
      return {};
    }

    const check = (node, specifier) => {
      const resolved = resolveRelativeSpecifier(filename, specifier);
      if (resolved === null) return;
      if (ALLOWED_CONTRACTS.has(resolved)) return;
      if (!DENIED_DIRS.some((dir) => isInside(dir, resolved))) return;
      context.report({
        node,
        messageId: "escape",
        data: { from: specifier, to: displayPath(resolved) },
      });
    };

    /** `require("...")` and `import("...")` must not be a way around this. */
    const checkCall = (node) => {
      const { callee } = node;
      const isImport =
        callee.type === "Import" ||
        (callee.type === "Identifier" && callee.name === "require");
      if (!isImport) return;
      const first = node.arguments[0];
      if (first?.type === "Literal" && typeof first.value === "string") {
        check(first, first.value);
      }
    };

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source, node.source.value);
      },
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      CallExpression: checkCall,
      // `import("…")` is an ImportExpression node, NOT a CallExpression, so it
      // needs its own visitor — without this, a dynamic import is a one-line
      // bypass of the whole rule. Asserted by a named test case.
      ImportExpression: (node) => {
        const first = node.source;
        if (first?.type === "Literal" && typeof first.value === "string") {
          check(first, first.value);
        }
      },
    };
  },
};

/** Flat-config plugin. Register with `plugins: { "core-boundary": … }`. */
export const coreBoundaryPlugin = {
  rules: {
    "no-plugin-boundary-escape": rule,
  },
};

/** The fully-qualified rule id as configured in `eslint.config.mjs`. */
export const RULE_ID = "core-boundary/no-plugin-boundary-escape";
