# Testing

Three independent runners. None replaces the others.

## Commands

| Command                | What it runs                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `bun run test`         | Vitest — jsdom unit and component tests under `src/**`, plus `e2e/support/__tests__/`. |
| `bun run test:db`      | Vitest — the DB round-trip suite. Needs a real Postgres (see below).                   |
| `bun run lint`         | ESLint over the repo.                                                                  |
| `bun run typecheck`    | `tsc --noEmit` (includes `e2e/` and `playwright.config.ts`).                           |
| `bun run build`        | `next build` — production build.                                                       |
| `bun run e2e`          | Playwright end-to-end specs in `e2e/` against a real Chromium.                         |
| `bun run e2e:install`  | One-time: downloads the Chromium build Playwright needs.                               |
| `bun run secrets:scan` | Scans the tracked tree for credential-shaped strings; fails on anything not baselined. |

## Credential scanning

`bun run secrets:scan` fails if a tracked file holds a credential-shaped string
that is not listed in `security/secret-scan-baseline.txt`. It runs in the `verify`
CI job, before the other gates, so a leaked credential is the first thing a red
run reports.

The rule is a **shape and entropy** rule, not a vendor-prefix substring match: a
vendor prefix followed by a contiguous run of ≥ 20 base62 characters whose
Shannon entropy is ≥ 3.5 bits/character. That distinction is what lets this
repository keep its own deliberately credential-_shaped_ test fixtures without
the gate being red on arrival — and a gate that is red on arrival is a gate that
gets ignored. See `scripts/secret-scan.ts` for the rules and
`scripts/__tests__/secret-scan.test.ts` for the tests that pin them.

Three commands, all safe to run locally:

```bash
bun run secrets:scan             # verify; exits 1 on any unbaselined finding
bun run secrets:scan:baseline    # rewrite the baseline's entries (still needs reasons)
bun run secrets:hook:install     # enable the pre-commit hook in this clone
```

Every baseline entry carries a **per-entry reason** saying why the finding is not
a credential, and an entry without one is fatal rather than ignored: a bare
fingerprint is a silent blanket waiver wearing the costume of a reviewed entry.

The `pre-commit` hook (`.githooks/pre-commit`) is the cheap first layer that
catches a credential before it becomes a commit. It is enabled per clone by
`git config core.hooksPath .githooks` — a **local** setting that is not pushed, so
a fresh clone has no hook until `bun run secrets:hook:install` is run there. CI
is therefore the layer that is actually guaranteed to run on every push, and it
does not depend on the hook having been installed.

## Database round-trip tests

```bash
bun run db:check      # optional — confirms DATABASE_URL reaches a live server
bun run db:migrate    # required — applies db/migrations
bun run test:db
```

`test:db` is a **separate Vitest config** (`vitest.db.config.ts`), not the
default one. The split is deliberate:

- `vitest.config.ts` collects `["src/**/*.test.{ts,tsx}", "e2e/**/*.test.{ts,tsx}"]`.
  It does **not** collect `db/**`, so `bun run test` never runs the round trip.
- `vitest.db.config.ts` collects `["db/**/__tests__/**/*.test.ts"]` plus one
  explicitly named file, `src/app/sources/__tests__/persist-canonical-events-upsert.test.ts`,
  and is reachable only through `bun run test:db`.

**Why that one file is named rather than globbed.** `src/**` is collected by the
default suite, which runs in the `verify` CI job — a job with no database. The
upsert proof gates its real-database block on `DATABASE_URL` and skips without
it, so on its own it was collected in that job and reported **skipped**, inside
a green run. A skipped suite is indistinguishable from a passing one, which is
the failure this naming prevents. A `src/app/sources/__tests__/**` glob was
measured and rejected: it also drags in `composition-root.test.ts`, which needs no
database and deletes `process.env.DATABASE_URL` inside one of its tests.

The trade is stated rather than hidden: the `include` list is now the registry of
db-backed tests living outside `db/**`, and **a new db-backed test under `src/**`
must be added to it by hand\*\* or it will ship ungated exactly as this one did.

**The DB suite is not skip-safe, on purpose.** `vitest.db.setup.ts` throws when
`DATABASE_URL` is unset, so running `bun run test:db` with no database is a hard
failure, not a green run with skipped tests. A round trip that silently skips
proves nothing. Do not "fix" that throw by skipping the suite — if you need the
default suite to stay runnable without a database, that is what the separate
config is for.

Because the suite inserts real rows into a real table, it must run after
`bun run db:migrate`, and it is serial (`fileParallelism: false`) against one
shared table.

## End-to-end tests

```bash
bun run e2e:install   # once, after cloning
bun run build         # required — e2e runs the production server
bun run e2e
```

`e2e` **requires a build unless it can reuse a running server.**
`playwright.config.ts` starts the app with `bun run start` (`next start`),
which serves `.next/` — so if Playwright has to start that server itself, a
prior `bun run build` is mandatory or it has nothing to serve. The exception is
`reuseExistingServer`, which is `!process.env.CI`: locally, when something is
already answering on port 3000, Playwright reuses it and no build of your own
is needed. CI always starts a fresh server, so on CI the build is always
required. If you are unsure which case you are in, run `bun run build` — it is
never wrong, only occasionally unnecessary.

Set `CI=true` to get CI behaviour locally (2 retries, `forbidOnly`, the `line`
reporter).

### What the current specs cover

- `e2e/home.spec.ts` — HTTP 200, the root `Hello World` heading, the document
  title, and the initial render of the shadcn/ui button.
- `e2e/interaction.spec.ts` — clicking the button produces a visible DOM change,
  and the page logs no React hydration failure while doing so. This is the class
  of defect jsdom unit tests cannot catch.
- `e2e/support/hydration.ts` — not a spec; the shared matcher, used by
  `interaction.spec.ts` only (`home.spec.ts` does not call it). Because `e2e`
  runs against a **minified production** build, React reports mismatches as
  `Minified React error #418` (and `#421`–`#425`) rather than the word
  "hydration", so the matcher accepts both the full development text and those
  numbered codes. A bare `#NNN` is not accepted — the code is only honoured
  behind React's `Minified React error` prefix or the `react.dev/errors/<code>`
  link, so an unrelated `POST /api 500 (error #418)` does not fail the suite.
  If you add a spec that cares about hydration, use
  `collectHydrationErrors(page)` rather than `/hydrat/i` — a bare `/hydrat/i`
  filter silently matches almost nothing here.

Chromium only. No Firefox/WebKit projects and no visual-regression baselines
yet.

## CI status

CI has **three jobs**, all defined in `.github/workflows/ci.yml`:

- `verify` — `bun install --frozen-lockfile`, `bun run secrets:scan`,
  `bun run format:check`, `bun run lint`, `bun run typecheck`,
  `bun run test`, the migration-drift check, `bun run build`. The credential
  scan runs FIRST among the gates, so a leaked credential is reported as itself
  rather than buried behind a later failure.
- `e2e` — verifies the lockfile, installs dependencies, runs `bun run build`,
  then installs Chromium, then runs `bun run e2e`. The build must precede the
  e2e steps (see the ordering note in `ci.yml`).
- `db round trip` — verifies the lockfile, installs dependencies, then runs
  `bun run db:check`, `bun run db:migrate` and `bun run test:db` against a
  Postgres **service container**.

They run concurrently on their own runners and report independent status and
timing. A green CI run therefore **does** cover both the e2e specs and the DB
round trip: each reports under its own check name, so a red round trip is
visible as `db round trip` rather than hidden inside a green aggregate. Note
that CI _reports_ these checks but does not _enforce_ them — the repository has
no branch protection and no rulesets, so nothing on GitHub requires any check
to pass before a PR can be merged. A human reviewer decides whether a red
`e2e` or `db round trip` blocks the merge. `bun run e2e` remains the local
equivalent of the `e2e` job, and carries the same build requirement described
under "End-to-end tests" above — a prior `bun run build`, not something
`playwright.config.ts` does for you.

### The `db round trip` job's database is ephemeral

The Postgres the `db round trip` job uses is a **`postgres:16-alpine` service
container declared in `ci.yml`** — created fresh for that job on the runner's
own loopback interface and destroyed when the job ends. It is **not** a
developer's local Postgres, not a shared instance, and not a hosted database.
`DATABASE_URL` is set in the job's `env:` block as a throwaway CI-only string
for that container; it is not read from a repository secret and no step prints
it. A PR that breaks the persistence layer therefore fails in CI for everyone,
including on a fork, with no credential required.

What that means for local runs: `bun run test:db` locally still points at
**your own** Postgres via `DATABASE_URL` in your gitignored `.env` (see
`.env.example`), and that local database can carry state the ephemeral CI one
never has. The CI job's equivalent of your local setup is `db:check` →
`db:migrate` → `test:db` against a clean database, which is why the job runs
`db:migrate` itself rather than assuming a migrated server.

Vitest's include is `["src/**/*.test.{ts,tsx}", "e2e/**/*.test.{ts,tsx}"]`
(source of truth: `vitest.config.ts`). The `e2e/**` half is deliberate — the
shared harness helpers under `e2e/support/` must be resolvable by Vitest so
they can carry Vitest negative controls. The two runners still never pick up
each other's files: Playwright's `testMatch` is `*.spec.ts`, so a `.test.ts`
under `e2e/` is invisible to `playwright test`, and a `.spec.ts` under `e2e/`
is invisible to Vitest.

## Dependency advisories

`bun run audit` is a CI gate. It runs as its own named step (`Dependency
advisories`) inside the existing `verify` job in `.github/workflows/ci.yml`,
immediately after `bun install --frozen-lockfile` — `bun audit` reads the
resolved lockfile, and running it before the quality gates means a new advisory
is reported as itself rather than buried behind a later failure.

The gate's verdict is `bun audit --json` compared against a committed baseline,
`.github/audit-baseline.json`. An advisory is acceptable **only** if its GitHub
advisory ID is a key in that file. It is a baseline, not a waiver: it is a
diffable file, every entry carries a reason that is printed on each run,
removing an ID turns the gate red, and no code path rewrites the file. It is
matched by **ID** — not by package name, not by severity, not by wildcard — so a
new advisory for an already-listed package is still reported.

### The known-unfixable advisory: `GHSA-vfj7-8cjw-p6xm`

`braces` — **high**, stack-exhaustion denial of service through deeply nested
patterns (CWE-674, CVSS 7.5). Reached via two independent chains:

```
tailwindcss › micromatch › braces
eslint-config-next › @next/eslint-plugin-next › fast-glob › micromatch › braces
```

**No fixed release exists.** `braces`' `dist-tags.latest` is `3.0.3` and the
advisory's `vulnerable_versions` is `<=3.0.3`, so the latest published release
is itself the last vulnerable release — there is no version to move to. And
`micromatch@4.0.8` (also latest) depends on `braces: ^3.0.3`, so no upstream
re-resolution escapes it either. The only real paths off it are upgrading
`tailwindcss` to v4 or `eslint-config-next` to 16, both multi-commit migrations
with their own breakage.

### A fixed advisory that was fixed, not baselined

`esbuild` — **moderate**, `GHSA-67mh-4wv8-2f99` ("enables any website to send
any requests to the development server and read the response"). This one **was**
reachable, via `drizzle-kit › esbuild`. `esbuild@0.18.20` was required by
`@esbuild-kit/core-utils@3.3.2`, whose own latest pins `esbuild: ~0.18.20`.

bun 1.3.10 does not honour npm's scoped `parent>child` override syntax (both
`@esbuild-kit/core-utils>esbuild` and the `>parent>child` form were measured to
leave `esbuild@0.18.20` in the lockfile), so the working path is the flat
`"overrides": { "esbuild": "0.28.2" }` entry — which also collapses the
`0.18.20`/`0.25.12`/`0.28.2` copies to one non-vulnerable `0.28.2`. That is
why the baseline has one entry, not two: the second advisory was genuinely
fixable and was fixed rather than waived.

### When the gate runs red

A transport failure is **not** a skip. If the advisory feed cannot be reached,
`bun run audit` fails with a `::error::` naming the failure, because a run that
could not reach the feed has verified nothing and reporting that as green would
be a false green. This costs little in practice: the step runs directly after
`bun install --frozen-lockfile`, which needs the same registry and would already
have failed the job.

When a genuine new advisory appears, either upgrade the dependency, or — if the
advisory truly has no fixed release — add its ID to
`.github/audit-baseline.json` with a one-line reason. Do not raise a severity
threshold to hide it. A baseline entry that matches nothing in the current tree
is reported as a `::warning::` so the file cannot rot into a permanent blanket.

## No test file may be collected by no suite

`src/__tests__/no-orphaned-test-files.test.ts` fails the **default** suite (so
`verify`, which has no database) if any **tracked** file matching
`*.test.*` / `*.spec.*` is collected by none of the three runners. It reads the
tracked list from `git ls-files` — an untracked file is work in progress, not a
defect — and derives the collected sets by parsing `test.include` in
`vitest.config.ts` and `vitest.db.config.ts` plus `testDir`/`testMatch` in
`playwright.config.ts` as **text**. It imports no config: executing a
Vitest/Playwright config from inside a jsdom test is a measured failure, and
`db-suite-registry.test.ts` records the exact error it causes.

This is the inverse of `db-suite-registry.test.ts`. That guard answers "is this
db-backed test collected by the _right_ suite?"; this one answers "is this test
file collected by _any_ suite?". A file that is written, committed, and matched
by no glob runs nowhere and looks green in every report — this guard closes that
gap.

It carries its own non-vacuity floors, asserted rather than commented: the
tracked set must exceed 20 files, the unit config must contribute at least 10,
the db config at least 1, and Playwright at least 1. So deleting a whole
`include:` array turns the guard **red** instead of quietly shrinking the
difference to nothing.
