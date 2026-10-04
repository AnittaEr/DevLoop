# Testing

Two independent runners. Neither replaces the other.

## Commands

| Command               | What it runs                                                   |
| --------------------- | -------------------------------------------------------------- |
| `bun run test`        | Vitest — jsdom unit and component tests under `src/**`.        |
| `bun run lint`        | ESLint over the repo.                                          |
| `bun run typecheck`   | `tsc --noEmit` (includes `e2e/` and `playwright.config.ts`).   |
| `bun run build`       | `next build` — production build.                               |
| `bun run e2e`         | Playwright end-to-end specs in `e2e/` against a real Chromium. |
| `bun run e2e:install` | One-time: downloads the Chromium build Playwright needs.       |

## End-to-end tests

```bash
bun run e2e:install   # once, after cloning
bun run build         # required — e2e runs the production server
bun run e2e
```

`e2e` **requires a build**. `playwright.config.ts` starts the app with
`bun run start` (`next start`), which serves `.next/` — without a prior
`bun run build` the server has nothing to serve. `reuseExistingServer` is
`!process.env.CI`, so a local run is fast if you already have `next dev` or
`next start` on port 3000, while CI always starts a fresh server and never
silently reuses a stale one.

Set `CI=true` to get CI behaviour locally (2 retries, `forbidOnly`, the `line`
reporter).

### What the current specs cover

- `e2e/home.spec.ts` — HTTP 200, the root `Hello World` heading, the document
  title, and the initial render of the shadcn/ui button.
- `e2e/interaction.spec.ts` — clicking the button produces a visible DOM change
  and no hydration errors are logged. This is the class of defect jsdom unit
  tests cannot catch.

Chromium only. No Firefox/WebKit projects and no visual-regression baselines
yet.

## CI status

**CI does NOT run `e2e` yet.** `.github/workflows/` is owned by a separate
ticket; the e2e job is not wired into CI. Until it is, a green CI run says
nothing about the e2e specs — run `bun run e2e` locally.

Vitest and Playwright do not overlap: Vitest's include is
`src/**/*.test.{ts,tsx}`, and the Playwright specs live in `e2e/*.spec.ts`.
