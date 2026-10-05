/**
 * T22 (`t_db9d9455`): README.md must not drift from `package.json` or
 * `.github/workflows/ci.yml`.
 *
 * WHY THIS FILE EXISTS. The four gates — `lint`, `typecheck`, `test`,
 * `build` — all answer "is what we wrote correct?". None of them answers
 * "is what we wrote ABOUT true?". That gap is how `README.md` reached `main`
 * describing a scaffold-only project while the repository already carried
 * Drizzle schema and migrations, Better Auth, the GitHub plugin, the evidence
 * timeline, 8 of 16 scripts and 2 of 3 CI jobs — and while asserting, in bold,
 * that "Local green == CI green", which was false in the direction that hurts:
 * a developer could be locally green and red in CI. Every historical README
 * defect in this repo (npm/bun drift, unresolved conflict markers, a stale CI
 * command list) would have passed a test that only greps for a literal string
 * such as "npm". So this file asserts STRUCTURE, derived from the two source
 * files, in both directions:
 *
 *   - every script in `package.json` is named in the README's Scripts table,
 *     and the table's row count EQUALS `Object.keys(scripts).length`;
 *   - every script the README names exists in `package.json`;
 *   - every job and every step name in `ci.yml` appears in the README, and the
 *     README names no job or step that `ci.yml` no longer declares.
 *
 * NON-VACUITY (measured in both directions when this file landed — see the
 * card's VERIFY section):
 *   - renaming or deleting a script in `package.json` fails the first test;
 *   - deleting a job from `.github/workflows/ci.yml` fails the job test.
 *
 * HOW IT READS ITS INPUTS — AS TEXT, NEVER BY IMPORT. Same constraint
 * `audit-baseline.test.ts` records from execution: importing a build-time or
 * config module into the default jsdom suite can fail the whole file with
 * `Invariant violation: "new TextEncoder().encode("") instanceof Uint8Array"
 * is incorrectly false`, taking `verify` red. `package.json` is parsed with
 * `JSON.parse` (what every consumer does) and `ci.yml` is parsed by a small
 * indentation-scoped reader, because the repo has no YAML dependency and
 * adding one is out of scope for a documentation fix.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const README_PATH = path.join(REPO_ROOT, "README.md");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const CI_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

const readme = readFileSync(README_PATH, "utf8");
const scripts =
  (
    JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      scripts?: Record<string, string>;
    }
  ).scripts ?? {};
const ciText = readFileSync(CI_PATH, "utf8");

/** `| `bun run foo` | … |` rows — the first cell is the only thing read. */
function scriptsTableRows(markdown: string): string[] {
  const rows: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`bun run ([A-Za-z0-9:_-]+)`\s*\|/.exec(line);
    if (match?.[1]) rows.push(match[1]);
  }
  return rows;
}

const readmeScriptNames = scriptsTableRows(readme);

/** The body of the README's own `## CI` section, up to the next `## `. */
function ciHeadings(markdown: string): string {
  const start = markdown.indexOf("\n## CI\n");
  expect(start, "README must have a `## CI` section").toBeGreaterThan(-1);
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Job keys and their `name:` labels, read from the `jobs:` block. */
function ciJobs(yaml: string): { key: string; name: string | null }[] {
  const lines = yaml.split("\n");
  const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  expect(
    jobsStart,
    "ci.yml must declare a top-level `jobs:` block",
  ).toBeGreaterThanOrEqual(0);

  const jobs: { key: string; name: string | null }[] = [];
  let current: { key: string; name: string | null } | null = null;

  for (const line of lines.slice(jobsStart + 1)) {
    // A new top-level key ends the jobs block.
    if (/^[A-Za-z]/.test(line)) break;

    const jobKey = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobKey?.[1]) {
      current = { key: jobKey[1], name: null };
      jobs.push(current);
      continue;
    }
    if (!current) continue;

    const label = /^ {4}name:\s*(.+)$/.exec(line);
    if (label?.[1] && current.name === null) {
      current.name = label[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return jobs;
}

/** Step names of one job, indented 6 spaces under `- name:`. */
function ciStepNames(yaml: string, jobKey: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^ {2}${jobKey}:`).test(line),
  );
  expect(
    start,
    `ci.yml must declare the \`${jobKey}\` job`,
  ).toBeGreaterThanOrEqual(0);

  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z]/.test(line) || /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    const step = /^ {6}- name:\s*(.+)$/.exec(line);
    if (step?.[1]) names.push(step[1].trim().replace(/^["']|["']$/g, ""));
  }
  return names;
}

const jobs = ciJobs(ciText);

describe("README Scripts table", () => {
  it("names every script in package.json", () => {
    // Re-derived from package.json at run time; the card's count is never
    // trusted, and neither is a hard-coded number in this file.
    const missing = Object.keys(scripts).filter(
      (name) => !readmeScriptNames.includes(name),
    );
    expect(
      missing,
      missing.length === 0
        ? undefined
        : [
            "Every script in package.json must appear in the README's Scripts",
            "table, or a newcomer cannot run a gate CI runs.",
            ...missing.map((name) => `  - bun run ${name}  (${scripts[name]})`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("has exactly as many rows as package.json has scripts", () => {
    expect(Object.keys(scripts).length).toBeGreaterThan(0);
    expect(readmeScriptNames.length).toBe(Object.keys(scripts).length);
  });

  it("names no script that package.json does not define", () => {
    // The other direction. Without it, a table row for a deleted script is
    // invisible: the missing-script assertion above still passes.
    const phantom = readmeScriptNames.filter((name) => !(name in scripts));
    expect(
      phantom,
      phantom.length === 0
        ? undefined
        : [
            "The README names scripts that package.json does not define.",
            ...phantom.map((name) => `  - bun run ${name}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("quotes the real `lint` script text, including the warning cap", () => {
    const lintRow = readme
      .split("\n")
      .find((line) => /^\|\s*`bun run lint`\s*\|/.test(line));
    expect(lintRow, "README must have a `bun run lint` row").toBeTypeOf(
      "string",
    );
    // The real text, not a paraphrase: `--max-warnings 0` is what makes lint
    // a gate rather than a suggestion, and it is what a reader needs to know
    // their local lint is as strict as CI's.
    expect(scripts.lint).toContain("--max-warnings 0");
    expect(lintRow).toContain(scripts.lint ?? "<no lint script>");
  });
});

describe("README CI section", () => {
  it("names every job ci.yml declares", () => {
    expect(jobs.length).toBeGreaterThan(0);
    const missing = jobs
      .filter((job) => !readme.includes(job.key))
      .map((job) => `${job.key} (${job.name ?? "unnamed"})`);
    expect(
      missing,
      missing.length === 0
        ? undefined
        : [
            "Every CI job must appear in the README. A job omitted from the",
            "README is a check a developer does not know to run locally.",
            ...missing.map((job) => `  - ${job}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("names every job's own `name:` label as ci.yml declares it", () => {
    const labelled = jobs.filter((job) => job.name !== null);
    const missing = labelled
      .filter((job) => !readme.includes(job.name as string))
      .map((job) => `${job.key} → ${job.name}`);
    expect(missing).toEqual([]);
  });

  it("names no job the README mentions that ci.yml no longer declares", () => {
    // The direction that catches a deleted job: the README would keep
    // documenting a check that does not exist. The scope is the CI section's
    // own table — every backticked first cell in it is a job key, whichever
    // jobs those are — so a fourth job or a renamed one is covered too.
    const ciSection = ciHeadings(readme);
    const documented = [
      ...ciSection.matchAll(/^\|\s*`([A-Za-z0-9_-]+)`\s*\|/gm),
    ].map((match) => match[1] as string);
    const phantom = documented.filter(
      (name) => !jobs.some((job) => job.key === name),
    );
    expect(
      phantom,
      phantom.length === 0
        ? undefined
        : [
            "The README documents CI jobs that .github/workflows/ci.yml does",
            "not declare.",
            ...phantom.map((name) => `  - ${name}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("names every step of every job", () => {
    const missing: string[] = [];
    for (const job of jobs) {
      for (const step of ciStepNames(ciText, job.key)) {
        if (!readme.includes(step)) missing.push(`${job.key}: ${step}`);
      }
    }
    expect(
      missing,
      missing.length === 0
        ? undefined
        : [
            "Every step name in ci.yml must appear in the README's CI section.",
            ...missing.map((step) => `  - ${step}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("carries the exact step list of every job, in order", () => {
    // STRUCTURAL, not a substring search. `readme.includes(step)` above cannot
    // see a step RENAMED in ci.yml — "Format check" no longer appears, but the
    // prose around it still does, so the file stayed green through a rename.
    // This reads the README's own per-job step tables as tables, so a rename,
    // an addition or a removal in ci.yml is a mismatch rather than a new
    // substring nobody has to notice.
    const section = ciHeadings(readme);
    const problems: string[] = [];

    for (const job of jobs) {
      // The heading may carry a trailing gloss ("Steps of `verify`, in
      // order — …"), so only the part up to the colon is fixed.
      const heading = new RegExp(`^Steps of \`${job.key}\`[:,]`, "m");
      const at = section.search(heading);
      if (at === -1) {
        problems.push(
          `${job.key}: no "Steps of \`${job.key}\`:" table in the CI section`,
        );
        continue;
      }
      const rest = section.slice(at + heading.lastIndex + 1);
      const nextHeading = rest.search(/^(Steps of |\*\*Local green)/m);
      const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

      const documented = block
        .split("\n")
        .map((line) => /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|?$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => (m[1] as string).trim())
        // Drop the header row and its `---` separator.
        .filter((cell) => cell !== "Step" && !/^-+$/.test(cell));

      const actual = ciStepNames(ciText, job.key);
      if (documented.join(" ") !== actual.join(" ")) {
        problems.push(
          `${job.key}: README lists [${documented.join(", ")}] but ci.yml has [${actual.join(", ")}]`,
        );
      }
    }

    expect(
      problems,
      problems.length === 0
        ? undefined
        : [
            "The README's per-job step tables must match ci.yml exactly, in",
            "order. Change the README in the same commit that changes the",
            "workflow.",
            ...problems.map((problem) => `  - ${problem}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("does not claim local green equals CI green", () => {
    // The unqualified claim is the specific falsehood this card removes. It
    // is asserted as a regex over the whole file rather than a comment, so it
    // survives re-wording.
    expect(readme).not.toMatch(/Local green == CI green/i);
    expect(readme).not.toMatch(/If all five commands pass locally, CI passes/i);
    // And the true replacement must name the two runners it does not cover.
    expect(readme).toContain("bun run e2e");
    expect(readme).toContain("bun run test:db");
  });
});

describe("README Setup and Layout sections", () => {
  it("states the .env setup the app requires", () => {
    expect(readme).toContain("cp .env.example .env");
    expect(readme).toContain("DATABASE_URL");
    expect(readme).toContain("BETTER_AUTH_SECRET");
    expect(readme).toContain("openssl rand -base64 32");
    // Local-only, no deployment (D2).
    expect(readme).toMatch(/locally only/i);
  });

  it("carries no credential", () => {
    // Placeholders only. A committed secret is an incident, not a typo, so the
    // shapes a real credential takes are rejected outright.
    expect(readme).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
    expect(readme).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(readme).not.toMatch(/postgres(ql)?:\/\/[^\s:@/]+:[^@\s]+@/);
  });

  it("lists only layout directories that exist", () => {
    // c7's rule in both directions: every directory named in the Layout block
    // must exist on disk, and each of the load-bearing ones must be named.
    const required = ["db/", "docs/", "scripts/", "src/core", "src/plugins"];
    for (const dir of required) {
      expect(existsSync(path.join(REPO_ROOT, dir)), `${dir} must exist`).toBe(
        true,
      );
      expect(readme, `README Layout must name ${dir}`).toContain(dir);
    }
  });
});
