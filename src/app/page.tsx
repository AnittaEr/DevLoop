import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Hello World</h1>
      <p className="max-w-prose text-center text-muted-foreground">
        DevLoop foundation is in place: Next.js App Router, TypeScript strict,
        Tailwind, shadcn/ui, ESLint, Prettier and Vitest.
      </p>
      <Button>Get started</Button>
    </main>
  );
}
