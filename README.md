# DevLoop

Turn delivery evidence (PRs, issues, reviews) into a career narrative, automatically.

Milestone **M0 — Foundation**. This branch contains the project scaffold only.

## Stack

| Layer     | Choice                                     |
| --------- | ------------------------------------------ |
| Framework | Next.js 15 (App Router), React 19          |
| Language  | TypeScript (strict)                        |
| Styling   | Tailwind CSS + shadcn/ui                   |
| Testing   | Vitest + Testing Library                   |
| Quality   | ESLint (`next/core-web-vitals`) + Prettier |
| Packages  | bun                                        |

## Requirements

- bun 1.3.10 (see `packageManager` in `package.json`)

## Getting started

```bash
bun install     # install dependencies
bun run dev     # http://localhost:3000
```

## Scripts

| Script                 | Purpose                         |
| ---------------------- | ------------------------------- |
| `bun run dev`          | Start the dev server            |
| `bun run build`        | Production build                |
| `bun run start`        | Serve the production build      |
| `bun run lint`         | ESLint (`next/core-web-vitals`) |
| `bun run typecheck`    | `tsc --noEmit`                  |
| `bun run test`         | Vitest, single run              |
| `bun run test:watch`   | Vitest in watch mode            |
| `bun run format`       | Prettier write                  |
| `bun run format:check` | Prettier check (no writes)      |

## Verification

The full gate used before every handoff:

```bash
bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test && bun run build
```

## CI

`.github/workflows/ci.yml` runs on every pull request against `main` and every push to `main`.

CI runs exactly these commands, in this order, each as its own step so a failure is attributable:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

**Local green == CI green.** If all five commands pass locally, CI passes; if CI is red, one of
those five failed locally too. CI also refuses to start if `bun.lock` is missing from the
repository, and `--frozen-lockfile` makes it fail loudly on a stale `bun.lock` rather than silently
resolving new versions — run `bun install` and commit the updated lockfile before pushing. (Both
halves are needed: `--frozen-lockfile` on its own exits 0 when the lockfile is absent entirely and
just resolves from the registry.) The workflow needs no repository secrets, so it also runs on fork
PRs.

## Layout

```
src/
  app/            App Router routes, global styles, layout
  components/ui/  shadcn/ui primitives (button)
  lib/            Framework-agnostic helpers (cn)
```

## Architecture rule

Data acquisition is pluggable. Plugins emit a **canonical event** shape and nothing else —
no GitHub-specific type may cross into the core domain. See `AGENTS.md`.

## Out of scope here

Database/ORM, auth, the GitHub plugin, and any UI beyond the hello-world page arrive in later
M0 tickets.
