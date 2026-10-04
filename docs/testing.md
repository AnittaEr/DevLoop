# Testing

Three independent runners. None replaces the others.

## Commands

| Command               | What it runs                                                                           |
| --------------------- | -------------------------------------------------------------------------------------- |
| `bun run test`        | Vitest — jsdom unit and component tests under `src/**`, plus `e2e/support/__tests__/`. |
| `bun run test:db`     | Vitest — the DB round-trip suite. Needs a real Postgres (see below).                   |
| `bun run lint`        | ESLint over the repo.                                                                  |
| `bun run typecheck`   | `tsc --noEmit` (includes `e2e/` and `playwright.config.ts`).                           |
| `bun run build`       | `next build` — production build.                                                       |
| `bun run e2e`         | Playwright end-to-end specs in `e2e/` against a real Chromium.                         |
| `bun run e2e:install` | One-time: downloads the Chromium build Playwright needs.                               |

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

- `verify` — `bun install --frozen-lockfile`, `bun run format:check`,
  `bun run lint`, `bun run typecheck`, `bun run test`, the migration-drift
  check, `bun run build`.
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
