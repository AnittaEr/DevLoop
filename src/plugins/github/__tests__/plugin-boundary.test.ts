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

import { readdirSync, readFileSync } from "node:fs";
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

  it("has no provider SDK import anywhere under src/plugins/**", () => {
    const offenders: string[] = [];
    for (const file of listFiles(path.join(SRC_DIR, "plugins"))) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        // The plugin uses the platform `fetch`, not a vendor SDK, so a bare
        // import of one would be a real (and undeclared) dependency.
        if (/^(node:)?(@?[\w-]+\/)?(octokit|github|gitlab|glab)/.test(spec)) {
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
