import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray package-lock.json exists one level above the repo
  // (/Users/anita_er/Code/package-lock.json), which makes Next.js infer the
  // wrong workspace root and emit a multiple-lockfiles warning on every build.
  // Pin the tracing root to this repo so builds are deterministic regardless of
  // lockfiles that happen to live above us.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
