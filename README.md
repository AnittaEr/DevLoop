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

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## Getting started

```bash
npm install     # install dependencies
npm run dev     # http://localhost:3000
```

## Scripts

| Script                 | Purpose                         |
| ---------------------- | ------------------------------- |
| `npm run dev`          | Start the dev server            |
| `npm run build`        | Production build                |
| `npm start`            | Serve the production build      |
| `npm run lint`         | ESLint (`next/core-web-vitals`) |
| `npm run typecheck`    | `tsc --noEmit`                  |
| `npm test`             | Vitest, single run              |
| `npm run test:watch`   | Vitest in watch mode            |
| `npm run format`       | Prettier write                  |
| `npm run format:check` | Prettier check (no writes)      |

## Verification

The full gate used before every handoff:

```bash
npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

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
