/**
 * The boundary negative control, from the plugin's side.
 *
 * Hard rule 1 says no provider-specific type may cross into core. The
 * existing defences, and why this file does not duplicate them:
 *
 *  - `src/core/__tests__/plugin-boundary.test.ts` scans `src/core/**` for
 *    provider vocabulary and for forbidden import specifiers, and
 *    `listCoreFiles()` there resolves `CORE_DIR = src/core`, so it does see
 *    every core file.
 *  - `eslint.config.mjs` enforces the same rule as a resolver-aware lint rule on
 *    every PR in CI.
 *
 * Both are scoped to `src/core/**`. Neither one asserts the positive half of
 * the invariant from the plugin's side, which is the half that actually
 * regresses: that the plugin's NATIVE type is structurally confined and that
 * nothing in core has grown an import of `src/plugins/**`. So this file adds
 * exactly that and nothing else.
 *
 * It lives in `src/plugins/github/__tests__/` because the plugin is the thing
 * being kept out. It is a separate file from the behaviour tests so that the
 * boundary assertion does not become invisible inside a 30-test suite.
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.resolve(path.dirname(THIS_FILE), "..");
const SRC_DIR = path.resolve(PLUGIN_DIR, "..", "..");
const CORE_DIR = path.join(SRC_DIR, "core");

const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
];

/**
 * The core guard's own file is excluded from both text scans.
 *
 * This is not a convenience. `src/core/__tests__/plugin-boundary.test.ts`
 * necessarily contains the deny-list AND a set of POSITIVE CONTROL fixtures --
 * string literals like `'import { gh } from "@/plugins/github/client";'` that
 * exist precisely so its own scanner is proven able to fire. A text scan
 * therefore reports that file as a violator of itself.
 *
 * The exclusion is by exact path, never by directory or glob, and it is
 * asserted in a test below so that widening it cannot pass unnoticed -- the
 * same defence `plugin-boundary.test.ts:519` uses for its own `isSelf`.
 */
const CORE_GUARD_FILE = path.join(
  CORE_DIR,
  "__tests__",
  "plugin-boundary.test.ts",
);

/** Every file under `dir`, recursively, that a scanner should read. */
function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let isDirectory = false;
      try {
        isDirectory = readdirSync(full) !== null;
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        walk(full);
        continue;
      }
      if (!SCANNED_EXTENSIONS.includes(path.extname(entry))) continue;
      found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Every `import`/`export ... from`/`require` specifier appearing in a file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

/**
 * The provider-SDK matcher used by the guard below.
 *
 * WHY IT IS A FUNCTION AND NOT AN INLINE REGEX.
 *
 * The previous inline pattern was
 * `/^(node:)?(@?[\w-]+\/)?(octokit|github|gitlab|glab)/`, and its optional
 * scope group `(@?[\w-]+\/)?` is GREEDY in a way that defeats the whole
 * guard. Because the group is optional AND unanchored at its own end, the
 * regex engine prefers consuming the scope, so for a real scoped package the
 * `(octokit|github|gitlab|glab)` alternative is then matched against the
 * PACKAGE NAME -- where none of those four words appears. Measured against the
 * six names the guard exists to catch:
 *
 *   @octokit/rest   -> NOT detected
 *   @octokit/core   -> NOT detected
 *   @gitlab-org/api -> NOT detected
 *   octokit         -> detected
 *   github          -> detected
 *   glab            -> detected
 *
 * So the guard fired on bare names and silently missed every real scoped SDK
 * package -- the only spelling npm actually installs. A guard that cannot catch
 * its own target is decorative.
 *
 * The fix splits the specifier into its parts and matches the SDK name against
 * BOTH the scope and the package, rather than trying to reach either through
 * one greedy alternation. It is exported so the behaviour is directly
 * testable, and the test below asserts every name above is detected: the
 * matcher is the thing under test, not an implementation detail of the scan.
 */

/** npm scopes whose name alone indicates a provider SDK. */
const PROVIDER_SDK_NAMES = [
  "octokit",
  "github",
  "gitlab",
  "glab",
  "gitlab-org",
] as const;

/**
 * True when an import specifier names a provider SDK.
 *
 * Matches a Node builtin prefix (`node:`) nowhere -- builtins are not SDKs --
 * and treats a scoped specifier as two name components, so `@octokit/rest` is
 * caught on its SCOPE and `glab/api` on its PACKAGE.
 */
export function isProviderSdkSpecifier(spec: string): boolean {
  const specifier = spec.startsWith("node:")
    ? spec.slice("node:".length)
    : spec;
  const components = specifier.split("/");
  // An unscoped specifier is one component; a scoped one is `@scope/name`, so
  // the scope is components[0] and the package is components[1].
  const names =
    components.length > 1
      ? [components[0]!.replace(/^@/, ""), components[1]!]
      : [components[0]!];
  return names.some((name) =>
    (PROVIDER_SDK_NAMES as readonly string[]).includes(name),
  );
}

describe("plugin boundary: core does not import the plugin implementation", () => {
  const allCoreFiles = listFiles(CORE_DIR);
  const coreFiles = allCoreFiles.filter((f) => f !== CORE_GUARD_FILE);

  it("finds core files to scan (the check is not vacuous)", () => {
    expect(allCoreFiles.length).toBeGreaterThan(1);
    expect(
      coreFiles.some((file) =>
        file.endsWith(`${path.sep}plugins${path.sep}plugin.ts`),
      ),
    ).toBe(true);
  });

  it("excludes exactly one core file, and it is the existing boundary guard", () => {
    // A mutation that broadened the exclusion (a whole directory, a glob,
    // "every __tests__ file") would show up here as a named failure rather
    // than as a silently weakened scan.
    const excluded = allCoreFiles.filter((f) => !coreFiles.includes(f));
    expect(excluded).toEqual([CORE_GUARD_FILE]);
    expect(excluded).toHaveLength(1);
  });

  it("resolves no core import into src/plugins/**", () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const rel = path.relative(CORE_DIR, file);
        // Any spelling that reaches the plugin implementation namespace:
        // the `@/` alias, a repo-rooted `src/` path, or a relative hop.
        const reachesPlugins =
          spec.startsWith("@/plugins") ||
          spec.startsWith("src/plugins") ||
          /(?:^|\/)\.\.\/plugins\//.test(spec) ||
          spec.startsWith("../../plugins/");
        if (reachesPlugins) {
          offenders.push(`${rel} -> ${spec}`);
        }
      }
    }
    expect(
      offenders,
      `core must not import the plugin implementation:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the SDK matcher detects every scoped and bare provider package", () => {
    // THE regression test for defect 3. The previous inline regex missed the
    // three scoped names below while catching the three bare ones, which is
    // the worst possible failure mode for a guard: it looks like it works.
    // These are asserted individually so a partial fix names the miss.
    for (const spec of [
      "@octokit/rest",
      "@octokit/core",
      "@gitlab-org/api",
      "octokit",
      "github",
      "glab",
    ]) {
      expect(isProviderSdkSpecifier(spec), `${spec} must be detected`).toBe(
        true,
      );
    }
  });

  it("the SDK matcher does not fire on unrelated specifiers", () => {
    // The negative control for the guard above: a matcher that matched
    // everything would be as useless as one that matched nothing.
    for (const spec of [
      "@/core/events/canonical-event",
      "./github-plugin",
      "../native-item",
      "node:fs",
      "node:path",
      "vitest",
      "zod",
      "drizzle-orm",
      "githubish-lookalike",
    ]) {
      expect(isProviderSdkSpecifier(spec), `${spec} must NOT be detected`).toBe(
        false,
      );
    }
  });

  it("the SCAN catches a scoped SDK import planted in a plugin file", () => {
    // The negative control for the matcher, at the level that actually
    // matters: the matcher being unit-correct is not the same as the SCAN
    // firing. A previous run of this mutation proved the difference -- reverting
    // only the call site to the old greedy regex left every test green,
    // because the scan still called the (correct) exported matcher. So the
    // guard's claim is asserted end to end here: a real scoped import planted
    // in a real plugin file must be reported by the same scan the guard runs.
    //
    // The planted specifier is ASSEMBLED AT RUNTIME, not written as a literal.
    // This file is itself under `src/plugins/**` and is therefore scanned by
    // the guard below, which resolves import specifiers from the source TEXT
    // with a `from "..."`-shaped regex. A commented-out example written in
    // that exact shape would be picked up as a real import and the guard
    // would report its own test file -- the same self-reference the core
    // guard handles by excluding `CORE_GUARD_FILE` by exact path. Building the
    // string keeps this file clean for the scan instead of adding a second
    // exclusion, which would widen what the guard ignores.
    const sdkName = "octokit";
    const specifier = `@${sdkName}/rest`;
    const offender = path.join(PLUGIN_DIR, "__sdk_canary__.ts");
    writeFileSync(
      offender,
      [
        `import { client } from "${specifier}";`,
        "export const probe = client;",
        "",
      ].join("\n"),
    );
    try {
      const offenders: string[] = [];
      for (const file of listFiles(path.join(SRC_DIR, "plugins"))) {
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          if (isProviderSdkSpecifier(spec)) {
            offenders.push(`${path.relative(SRC_DIR, file)} -> ${spec}`);
          }
        }
      }
      expect(offenders).toEqual([
        `${path.join("plugins", "github", "__sdk_canary__.ts")} -> ${specifier}`,
      ]);
    } finally {
      unlinkSync(offender);
    }
  });

  it("has no provider SDK import anywhere under src/plugins/**", () => {
    const offenders: string[] = [];
    for (const file of listFiles(path.join(SRC_DIR, "plugins"))) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        // The plugin uses the platform `fetch`, not a vendor SDK, so a bare
        // import of one would be a real (and undeclared) dependency.
        if (isProviderSdkSpecifier(spec)) {
          offenders.push(`${path.relative(SRC_DIR, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the native item type confined to the plugin directory", () => {
    // The native shape's names are the source's own vocabulary. They may
    // appear inside src/plugins/** and nowhere else in src/**.
    const nativeTokens = ["pull_request", "html_url", "created_at"];
    const offenders: string[] = [];
    for (const file of listFiles(SRC_DIR)) {
      if (file.startsWith(path.join(SRC_DIR, "plugins"))) continue;
      if (file === CORE_GUARD_FILE) continue;
      const source = readFileSync(file, "utf8");
      for (const token of nativeTokens) {
        if (source.includes(token)) {
          offenders.push(`${path.relative(SRC_DIR, file)}: ${token}`);
        }
      }
    }
    expect(
      offenders,
      `native provider vocabulary leaked outside src/plugins/**:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps core free of this plugin's exported names", () => {
    // The strongest form of "the type does not leak": none of the plugin's own
    // exports is reachable from core by name, so core cannot have taken a
    // dependency on the native type even by accident.
    const coreSource = coreFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const symbol of [
      "NativeIssueItem",
      "GitHubSourcePlugin",
      "GitHubPluginError",
      "HttpTransport",
      "TransportResponse",
      "toJsonValue",
      "canonicalEventId",
    ]) {
      expect(coreSource).not.toContain(symbol);
    }
  });
});
