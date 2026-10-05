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

### What the rule does not catch

Stating this is part of the rule. `bun run secrets:scan` is a shape-and-entropy
gate over **base62** material, and its failure message ("If it is a real
credential, remove it and rotate it") is advice about a _finding_, not a claim
that every credential is found. The measured gaps:

| Shape                                                                    | Caught? | Why                                                                                                                               |
| ------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `github_pat_` + ≥ 20 contiguous base62 chars, ≥ 3.5 bits/char            | yes     | rule 1                                                                                                                            |
| Long opaque value assigned to a `*token*`/`*secret*`/`*password*`/… name | yes     | rule 2                                                                                                                            |
| **base64 value containing `+`, `/` or `=`**                              | **no**  | rule 2's value test is `^[A-Za-z0-9]{20,}$` — entirely base62 — so `+`/`/`/`=` make the value fail the test and it is not flagged |
| `github_pat_` + hyphen-grouped material                                  | no      | `-` terminates a base62 run, so no run reaches 20 chars. Not a GitHub PAT format; recorded for completeness.                      |
| A credential spread over multiple lines, or base64-decoded at runtime    | no      | the gate reads lines                                                                                                              |

**This is a recorded decision, not an accident.** QA (round 1, `20d5518`)
measured the base64 gap and explicitly forbade widening the baseline or
loosening `MIN_RUN`/entropy to close it — a looser rule 2 is what produced a
32-finding noise baseline in the first draft, and a baseline that noisy is the
fastest way to make a baseline ignored. So the limitation is written down here
instead. GitHub push protection and the remote's own secret scanning remain the
backstop for non-base62 material; that is a remote settings change, out of scope
for this repository.

### What the gate reads — the index, not the working tree

Every byte the gate scans comes out of the git **index**, via
`git cat-file blob :<path>`: the content the next commit will contain, or the
content already committed after a fresh checkout. It never reads a file off
disk.

This was a real defect, found by QA at `304bacd` and measured by execution, not
by reading the code. The first version took the path _list_ from
`git diff --cached` and then read each path with `readFileSync` — the working
tree — so `--staged` meant "the staged file list paired with whatever the file
contains right now":

```
git add -f a.ts                          # index now holds the credential
echo 'export const t = "clean";' > a.ts  # disk no longer does
git commit -qm x                         # COMMIT_EXIT=0, hook silent
git show HEAD:a.ts                       # the PAT IS IN THE COMMIT
```

That path needed no `--no-verify` at all. The default committed-tree mode had the
same hole and reported green over a `HEAD` holding a real-shaped PAT whenever the
working tree was clean; CI only escaped it because `actions/checkout` happens to
materialise `HEAD` into the working tree first, which is a coincidence of the
runner rather than a property of the gate.

The consequence for what is and is not covered:

| Content                                   | Scanned? | Why                                                                                                                                                                                                       |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The bytes the next commit will contain    | yes      | read from the index (`:<path>`)                                                                                                                                                                           |
| The bytes already committed (`HEAD`)      | yes      | after a checkout the index equals `HEAD`; CI reads the same thing                                                                                                                                         |
| An UNSTAGED file that exists only on disk | no       | deliberately — an uncommitted `.env.production` is the operator's, not a finding to block an unrelated commit over                                                                                        |
| An UNTRACKED file                         | no       | never enters the index; `.gitignore` plus the environment are the layers for these                                                                                                                        |
| An UNMERGED path (merge conflict)         | reported | `:<path>` needs a stage-0 entry, so the gate NAMES the path and says it did not scan it. Not fatal: `git commit` refuses an unmerged tree outright, so it cannot hide anything in a commit that gets made |
| A gitlink / submodule                     | reported | same naming path as above; a submodule's contents belong to another repository's gate                                                                                                                     |

A silently skipped path would be the same green lie in a new form, so the gate
prints every path it could not read rather than skipping in silence. See
`readIndexBlob` in `scripts/scan-secrets.ts` and the regression tests in
`scripts/__tests__/secret-scan.test.ts` that stage bytes deliberately different
from disk — they fail against the pre-fix code.

### Enabling the commit-time layer

The hook is committed at `.githooks/pre-commit`; the enablement is one line per
clone:

```bash
bun run secrets:hook:install     # runs: git config core.hooksPath .githooks
```

Run inside a git worktree, that command writes the **shared** `.git/config`, so
it enables the hook for every sibling worktree of the repository too. Harmless
(each commit is scanned in its own worktree) but surprising, which is why the
installer prints the warning and the undo command
(`git config --unset core.hooksPath`). `core.hooksPath` cannot be committed, so
this line must be run in every fresh clone.

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

## Load-bearing tests carry a MEASURED per-test timeout

`vitest.config.ts` sets **no** `testTimeout`, so every test inherits Vitest's
built-in `5000ms`. That default is deliberate and stays: it is what makes the
~500 in-process tests honest about a regression that made an ordinary assertion
slow. **Do not raise it.** A global raise spends a bigger budget on every test
to serve the handful that do real I/O, and lets a genuine hang sit unnoticed for
the new number.

A test that spawns a subprocess, or rebuilds a module graph per case, has a
duration that is a property of the **machine**, not of the code. Under
full-suite load those tests exceeded 5s and failed with
`Error: Test timed out in 5000ms` — a red that does not mean a red assertion.
The budgets live in `src/core/testing/load-bearing-test-timeout.ts` and are
attached per test as `{ timeout: LOAD_BEARING_TEST_TIMEOUT.<key> }`:

| budget         | for                                               | worst measurement it is sized from                            |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `subprocess`   | spawns a subprocess (a cold start per call)       | 28.1s, 4 concurrent suites — see the caveat below             |
| `subprocessX4` | a subprocess test measured **above** `subprocess` | **31.6s**, 7 concurrent **full** suites (the Prettier canary) |
| `moduleGraph`  | `vi.resetModules()` / re-import per case          | 6.9s, 7 concurrent suites (`route-auth.test.ts`)              |

The `subprocessX4` figure is the worst of 7 measured runs at 7x concurrency:
31563 / 30895 / 30811 / 30170 / 30050 / 29425 / 26160 ms (median 30170), in
**separate** detached worktrees, against 589 / 594 / 597 / 617 / 621 ms
isolated. Separate worktrees matter: that test writes a fixed-path canary and
deletes it in a `finally`, so concurrent suites sharing one worktree delete the
file out from under each other and the timing measures that contention instead
of the test.

At 4x the same test measured worst 10934 ms over 12 observations (median
7510 ms), and `route-auth.test.ts` CONTROL worst 2662 ms there against 6936 ms
at 7x. Both budgets clear their worst observation; the table quotes the 7x rows
because 4x is not the ceiling — the canary's duration grows roughly linearly
with the number of competing suites (621 ms → 10934 ms → 31563 ms at 1x → 4x →
7x).

Two caveats stated rather than smoothed over:

- **`subprocess` is sized from a file that is not on this branch yet.** The
  28.1s measurement is `scripts/__tests__/secret-scan.test.ts`, which lives only
  on the unintegrated branch `devloop/t_4cdeadc5` (B51) — `git ls-tree -r
origin/main --name-only | grep -i secret` returns nothing on `main` or on the
  branch carrying this table. So the budget has zero use sites today and sizes
  the _next_ subprocess test to arrive. Re-measure when B51 lands.
- **Two earlier figures for `subprocessX4` are withdrawn, not superseded.** A
  revision quoted **37.8s** here and **70.1s** in the budgets module for the same
  budget, then attributed both to four suites sharing one worktree and the
  canary-file race. The 7x row above reaches the same order in _separate_
  worktrees, so that explanation does not hold and the attribution is dropped
  rather than restated. The table now quotes the worst measurement that actually
  reproduces at a stated condition. The `moduleGraph` row had the same problem:
  its "21.4s" did not reproduce, and is withdrawn for 6.9s.

The rule for a new budget is stated in that file: take the worst duration you
have **measured** for that test under the worst load you can actually produce,
then round up to the next round number. That rule was previously "multiply by 4"
and is no longer, because the 1x → 4x → 7x progression above shows the growth is
roughly linear in suite count rather than bounded by any constant multiplier.

`src/__tests__/load-bearing-test-timeouts.test.ts` enforces this. It reads test
sources as **text** (importing them would drag a module graph into the runner),
resolves **file-level helpers and classes** so a marker in a helper the test only
_calls_, or in a class method it only invokes, is still attributed to that test,
and fails when a load-scaled test names no budget. Its coverage claim is itself
under test, in both directions:

- the guard's first version was blind to helper-delegated work and green on the
  exact defect it existed to catch;
- its second was blind to a **class method** — QA built that counter-example and
  the guard reported zero offenders on it.

Two shapes it still does **not** resolve, asserted as limitations so the claim
cannot drift back into coverage it does not have: an instance returned by a
factory (`makeScanner().run()`), and an object-literal method. Both hide the
spawn behind a value whose type only a compiler knows; closing them needs type
information, not a wider regex.
