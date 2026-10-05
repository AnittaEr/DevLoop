/**
 * The dependency-advisory gate (B50 / `t_e211ed32`).
 *
 * WHY THIS IS A SCRIPT RATHER THAN A PLAIN `bun audit` IN CI. `bun audit` exits
 * non-zero on ANY advisory, and one high-severity advisory in this tree
 * (GHSA-vfj7-8cjw-p6xm, `braces`) has no fixed release to move to — the latest
 * published `braces` IS the last vulnerable release. A gate wired naively today
 * is therefore RED and stays red forever, and a permanently red gate gets
 * deleted. So the honest shape is a committed, reviewable BASELINE of advisory
 * IDs that are known-unfixable right now, against which everything else is
 * compared.
 *
 * This is a BASELINE, NOT A WAIVER, and the difference is load-bearing:
 *   - it names exact advisory IDs — not a wildcard, not a severity threshold,
 *     not a package-name match. A new advisory for the SAME package is
 *     reported, not suppressed;
 *   - every entry carries a one-line reason stating WHY it is unfixable, and
 *     that reason is PRINTED on every run, so a suppressed advisory is visible
 *     in the CI log rather than silently absent from it;
 *   - it is a diffable file, so adding to it is a reviewed change;
 *   - removing an ID from it turns this gate RED (verified by execution, see
 *     the card's c4);
 *   - and this script NEVER REWRITES the baseline. A gate that absorbs new
 *     advisories on each run is precisely the invisible-fact failure this
 *     script exists to end.
 *
 * TRANSPORT FAILURE (the card's c6). `bun audit` needs the advisory feed, and a
 * runner may not have it. This script FAILS in that case, loudly and
 * distinguishably, rather than skipping: a step that could not reach the feed
 * has verified nothing, and reporting that as green is a false green. Failing
 * costs nothing in practice, because the CI step runs immediately after
 * `bun install --frozen-lockfile`, which needs the same registry and would
 * already have taken the job red. So a feed outage is never a *sole* cause of a
 * red run, and it is never laundered into a green one.
 *
 * Neither `bun audit`'s exit code nor its text output is trusted for the
 * verdict: it exits 1 both for "found vulnerabilities" and for "could not reach
 * the registry", which are opposite conditions. The verdict is computed from
 * `bun audit --json`, and the two failure modes are told apart by whether that
 * JSON parsed at all.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const BASELINE_PATH = path.join(REPO_ROOT, ".github", "audit-baseline.json");

/** One advisory as `bun audit --json` reports it. */
interface Advisory {
  url: string;
  title: string;
  severity: string;
  vulnerable_versions?: string;
}

type AuditJson = Record<string, Advisory[]>;

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// ── 1. the baseline ──────────────────────────────────────────────────────────
// Read-only, by construction: nothing in this file writes to it.

let baselineText: string;
try {
  baselineText = readFileSync(BASELINE_PATH, "utf8");
} catch {
  fail([
    `::error::Could not read the advisory baseline at ${BASELINE_PATH}.`,
    "The advisory gate has no baseline to compare against, so it cannot tell a",
    "known-unfixable advisory from a new one. Restore the file — do not bypass",
    "the gate.",
  ]);
}

let baseline: Record<string, string>;
try {
  baseline = JSON.parse(baselineText) as Record<string, string>;
} catch (error) {
  fail([
    `::error::${path.relative(REPO_ROOT, BASELINE_PATH)} is not valid JSON:`,
    `  ${error instanceof Error ? error.message : String(error)}`,
  ]);
}

// ── 2. the audit feed ────────────────────────────────────────────────────────

// `node:child_process`, not the `Bun` global: tsconfig.json pins
// `types: ["node"]`, so `Bun.spawnSync` is untyped here and adding @types/bun
// would widen the type environment for the whole repository to serve one script.
const audit = spawnSync("bun", ["audit", "--json"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});

const stdout = audit.stdout ?? "";
const stderr = audit.stderr ?? "";

let findings: AuditJson;
try {
  findings = JSON.parse(stdout) as AuditJson;
} catch {
  // No parseable JSON is the transport-failure branch, and it is deliberately
  // distinct from "the feed was reachable and reported no advisories" — which
  // parses as `{}` and takes the normal path below.
  fail([
    "::error::Could not retrieve the advisory feed, so dependency advisories",
    "::error::were NOT checked. This is a transport failure, not a clean run:",
    "::error::do not read this step's result as 'no known vulnerabilities'.",
    `bun audit exit code: ${audit.status ?? "not run"}`,
    stderr.trim() || stdout.trim() || "(bun audit produced no output)",
  ]);
}

if (findings === null || typeof findings !== "object") {
  fail(["::error::bun audit --json did not return a JSON object."]);
}

// ── 3. the verdict ───────────────────────────────────────────────────────────

/** Every advisory ID present in the tree, with the package that carries it. */
const present = new Map<string, string[]>();
for (const [pkg, advisories] of Object.entries(findings)) {
  for (const advisory of advisories) {
    // The ID is carried in the advisory URL
    // (.../advisories/GHSA-xxxx-xxxx-xxxx); it is the same string shape the
    // baseline keys use, which is what lets the two be compared exactly.
    const id = /\/advisories\/(GHSA-[A-Za-z0-9-]+)/.exec(advisory.url)?.[1];
    if (!id) {
      fail([
        `::error::Could not extract an advisory ID from ${pkg}: ${advisory.url}`,
        "The gate matches advisories by ID against the baseline, so an",
        "unrecognised advisory URL shape must fail loudly rather than be",
        "skipped into a false green.",
      ]);
    }
    const carriers = present.get(id) ?? [];
    carriers.push(pkg);
    present.set(id, carriers);
  }
}

const unbaselined: string[] = [];
const baselined: string[] = [];

for (const [id, carriers] of present) {
  const reason = Object.prototype.hasOwnProperty.call(baseline, id)
    ? baseline[id]
    : undefined;
  const advisory = Object.values(findings)
    .flat()
    .find((entry) => entry.url.includes(id));

  if (reason === undefined) {
    unbaselined.push(
      `${id} (${advisory?.severity ?? "unknown severity"}) ${advisory?.title ?? ""}\n` +
        `    via ${carriers.join(", ")}`,
    );
    continue;
  }

  if (typeof reason !== "string" || reason.trim() === "") {
    fail([
      `::error::Baseline entry ${id} has an empty or non-string reason.`,
      "Every baselined advisory must state WHY it is unfixable; an unexplained",
      "suppression is indistinguishable from a waiver.",
    ]);
  }
  baselined.push(
    `${id}\n    reason: ${reason}\n    via ${carriers.join(", ")}`,
  );
}

// A baseline entry that matches nothing present is stale: the advisory has been
// fixed and nobody removed the line. It is reported so the file cannot rot into
// a permanent blanket, but it is NOT fatal — a stale entry suppresses nothing,
// so it cannot hide a real advisory.
const stale = Object.keys(baseline).filter((id) => !present.has(id));

console.log(`bun audit reported ${present.size} advisory/advisories.`);

for (const line of baselined) {
  console.log(`\nBASELINED (known-unfixable, suppressed):\n  ${line}`);
}
for (const id of stale) {
  console.log(
    `\n::warning::Baseline entry ${id} matches no advisory in the current tree. ` +
      "It suppresses nothing, so it is not hiding a vulnerability, but it is " +
      "stale and should be removed from .github/audit-baseline.json.",
  );
}

if (unbaselined.length > 0) {
  fail([
    `::error::${unbaselined.length} dependency advisory/advisories are NOT in ` +
      `${path.relative(REPO_ROOT, BASELINE_PATH)}:`,
    ...unbaselined.map((line) => `  - ${line}`),
    "",
    "Either upgrade the affected dependency, or — if the advisory genuinely has",
    "no fixed release — add its ID to the baseline WITH a one-line reason",
    "stating why. Do not raise this gate's severity threshold to hide it.",
  ]);
}

console.log("\nbun audit: no unbaselined advisories.");
