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

CI has **two jobs**, both defined in `.github/workflows/ci.yml`:

- `verify` — `bun install --frozen-lockfile`, `bun run format:check`,
  `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
- `e2e` — installs Chromium, then runs `bun run build` and `bun run e2e`.

They run concurrently on their own runners and report independent status and
timing. A green CI run therefore **does** cover the e2e specs: the `e2e` check
must be green for the PR to be mergeable. `bun run e2e` remains the local
equivalent of the `e2e` job; it just also needs a Chromium build of the app,
which `playwright.config.ts` handles via its `webServer` entry.

Vitest's include is `["src/**/*.test.{ts,tsx}", "e2e/**/*.test.{ts,tsx}"]`
(source of truth: `vitest.config.ts`). The `e2e/**` half is deliberate — the
shared harness helpers under `e2e/support/` must be resolvable by Vitest so
they can carry Vitest negative controls. The two runners still never pick up
each other's files: Playwright's `testMatch` is `*.spec.ts`, so a `.test.ts`
under `e2e/` is invisible to `playwright test`, and a `.spec.ts` under `e2e/`
is invisible to Vitest.
