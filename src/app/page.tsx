import { GetStartedButton } from "@/app/get-started-button";
import { SIGN_IN_ROUTE } from "@/app/evidence/destination";

/**
 * The home page carries NO session guard, deliberately.
 *
 * It renders a hard-coded string and no persisted data, so there is nothing on
 * it to withhold and nothing for a guard to protect. This is the same finding
 * B46 measured and recorded: zero pages under `src/app/**` render canonical
 * events, which is why B46's redirect clause was unmeetable rather than
 * pending. `/evidence` is the page that renders evidence, and that is the one
 * that is guarded.
 *
 * The link below is therefore a plain anchor, not a form and not a
 * client-side guard.
 */
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Hello World</h1>
      <p className="max-w-prose text-center text-muted-foreground">
        DevLoop foundation is in place: Next.js App Router, TypeScript strict,
        Tailwind, shadcn/ui, ESLint, Prettier and Vitest.
      </p>
      <GetStartedButton />
      <p className="text-sm">
        <a className="underline" href={SIGN_IN_ROUTE}>
          Sign in to view your evidence
        </a>
      </p>
    </main>
  );
}
