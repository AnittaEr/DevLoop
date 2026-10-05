# DevLoop

Turn delivery evidence (PRs, issues, reviews) into a career narrative, automatically.

DevLoop runs **locally only**: a local PostgreSQL database, credentials in a local
`.env`, and no deployment, hosted database or domain (D2). There is no hosted
mode to configure.

## Stack

| Layer     | Choice                                               |
| --------- | ---------------------------------------------------- |
| Framework | Next.js 15 (App Router), React 19                    |
| Language  | TypeScript (strict)                                  |
| Database  | PostgreSQL via Drizzle ORM, migrations in `db/`      |
| Auth      | Better Auth — local credentials, single user         |
| Styling   | Tailwind CSS + shadcn/ui                             |
| Testing   | Vitest + Testing Library; Playwright for e2e         |
| Quality   | ESLint + Prettier, TypeScript, dependency advisories |
| Packages  | bun                                                  |

## Requirements

- bun 1.3.10 (see `packageManager` in `package.json`)
- A local PostgreSQL server — `/sign-in`, `/evidence` and the sync API need it

## Getting started

```bash
bun install
cp .env.example .env   # then edit .env — see Setup below
bun run dev            # http://localhost:3000
```

## Setup

`.env.example` is the template; `.env` is the real file and is gitignored.

```bash
cp .env.example .env
```

Two variables must be set before `/sign-in` and `/evidence` work at all:

| Variable             | Required | Notes                                                           |
| -------------------- | -------- | --------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | Local PostgreSQL connection string, e.g. the `.env.example` one |
| `BETTER_AUTH_SECRET` | yes      | Generate with `openssl rand -base64 32`                         |

If `BETTER_AUTH_SECRET` is unset, the auth route answers **503
`auth_not_configured`** rather than failing open.

`GITHUB_FINE_GRAINED_PAT` is optional: it is the credential the GitHub plugin
reads when you sync from GitHub. Leave it empty and the plugin is simply not
usable; fill it with a real token **only in `.env`** — `.env.example` ships it
empty and no credential belongs in the repository.

## Scripts

Every script in `package.json`, all 16 of them:

| Script                 | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `bun run dev`          | Start the dev server                                        |
| `bun run build`        | Production build (`next build`)                             |
| `bun run start`        | Serve the production build (`next start`)                   |
| `bun run lint`         | `eslint . --max-warnings 0` — zero tolerance, so it gates   |
| `bun run typecheck`    | `tsc --noEmit`                                              |
| `bun run test`         | Vitest, single run (`src/**` plus `e2e/**` helpers)         |
| `bun run e2e`          | Playwright end-to-end specs against a real Chromium         |
| `bun run e2e:install`  | One-time: download the Chromium build Playwright needs      |
| `bun run test:watch`   | Vitest in watch mode                                        |
| `bun run test:db`      | The DB round-trip suite (separate config, needs a database) |
| `bun run format`       | Prettier write                                              |
| `bun run format:check` | Prettier check (no writes) — the only gate that reads `.md` |
| `bun run db:generate`  | `drizzle-kit generate` — regenerate `db/migrations`         |
| `bun run db:migrate`   | Apply `db/migrations` to `DATABASE_URL`                     |
| `bun run db:check`     | Confirm `DATABASE_URL` reaches a live server                |
| `bun run audit`        | Dependency advisories against `.github/audit-baseline.json` |

Note the three runners: `test`, `test:db` and `e2e` are independent and none
substitutes for another. `docs/testing.md` explains the split.

## Verification

The gate before every handoff:

```bash
bun run lint && bun run typecheck && bun run test && bun run format:check && bun run build
```

The two suites CI runs and this list does not cover:

```bash
bun run e2e:install && bun run build && bun run e2e   # e2e job
bun run db:migrate && bun run test:db                 # db round trip job
```

`bun run e2e` needs `bun run build` first (Playwright's web server runs
`bun run start`, which serves `.next/`), and `bun run test:db` needs
`bun run db:migrate` against a live database.

## CI

`.github/workflows/ci.yml` runs on every pull request against `main` and every
push to `main`. It declares **three jobs**, each an independent check with no
`needs:` edge — a red e2e is its own named check rather than a step buried
inside `verify`:

| Job key  | Job name                             | Needs a database                    |
| -------- | ------------------------------------ | ----------------------------------- |
| `verify` | format, lint, typecheck, test, build | no                                  |
| `e2e`    | e2e                                  | no                                  |
| `db`     | db round trip                        | yes (Postgres 16 service container) |

Steps of `verify`, in order — the Runs column is the command each step executes:

| Step                         | Runs                                                      |
| ---------------------------- | --------------------------------------------------------- |
| Checkout                     | —                                                         |
| Install bun                  | —                                                         |
| Verify lockfile is committed | shell guard for a missing `bun.lock`                      |
| Install dependencies         | `bun install --frozen-lockfile`                           |
| Dependency advisories        | `bun run audit`                                           |
| Format check                 | `bun run format:check`                                    |
| Lint                         | `bun run lint`                                            |
| Typecheck                    | `bun run typecheck`                                       |
| Test                         | `bun run test`                                            |
| Database migrations in sync  | `bun run db:generate`, then `git diff` on `db/migrations` |
| Build                        | `bun run build`                                           |

Steps of `e2e`:

| Step                                         | Runs                                           |
| -------------------------------------------- | ---------------------------------------------- |
| Checkout                                     | —                                              |
| Install bun                                  | —                                              |
| Verify lockfile is committed                 | shell guard for a missing `bun.lock`           |
| Install dependencies                         | `bun install --frozen-lockfile`                |
| Build                                        | `bun run build`                                |
| Install Chromium and its system dependencies | `bunx playwright install --with-deps chromium` |
| E2E (Playwright)                             | `bun run e2e`                                  |

Steps of `db`:

| Step                         | Runs                                 |
| ---------------------------- | ------------------------------------ |
| Checkout                     | —                                    |
| Install bun                  | —                                    |
| Verify lockfile is committed | shell guard for a missing `bun.lock` |
| Install dependencies         | `bun install --frozen-lockfile`      |
| Check database connection    | `bun run db:check`                   |
| Apply migrations             | `bun run db:migrate`                 |
| DB round-trip tests          | `bun run test:db`                    |

**Local green is not CI green.** The gate above covers the `verify` job and
parts of `e2e` (build only). It proves nothing about the Playwright run or the
database round trip, so you can be locally green and red in CI. Run
`bun run e2e` after `bun run e2e:install` and `bun run db:migrate && bun run
test:db` before you call a change done.

Every job refuses to start if `bun.lock` is missing from the repository, and
`--frozen-lockfile` makes it fail loudly on a stale lockfile rather than
silently resolving new versions — run `bun install` and commit the updated
lockfile before pushing. (Both halves are needed: `--frozen-lockfile` on its
own exits 0 when the lockfile is absent entirely and just resolves from the
registry.) The workflow needs no repository secrets, so it also runs on fork
PRs.

## Layout

```
db/               Drizzle schema, SQL migrations, migrate/check scripts
docs/             docs/testing.md — the three runners, and why they are split
e2e/              Playwright specs
scripts/          Repository-level gates (audit)
src/app/          App Router pages, API routes, global styles, layout
src/components/   shadcn/ui primitives
src/core/         Framework-agnostic domain: canonical events, the evidence
                  timeline, credential providers, the plugin contract
src/lib/          Framework helpers (cn), Better Auth, session guard, db client
src/plugins/      Adapters to outside services; plugins/github is the only one
src/__tests__/    Repo-level assertions about the gates themselves
```

## Architecture rule

Data acquisition is pluggable. Plugins emit a **canonical event** shape and
nothing else — no GitHub-specific type may cross into the core domain. See
`AGENTS.md`.
