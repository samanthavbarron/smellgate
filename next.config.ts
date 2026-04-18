import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Emit a minimal self-contained server bundle at `.next/standalone` so the
  // Docker `runner` stage only needs to copy that + `.next/static` + `public`
  // rather than the full workspace `node_modules`. See Dockerfile and
  // docs/deployment.md.
  output: "standalone",
  // Pin the tracing root to this directory. Without this, Next.js walks
  // upward looking for a workspace root (pnpm-lock.yaml, etc.) and can land
  // on a parent tree — which, under our local multi-agent worktree layout,
  // produces a `.next/standalone/.claude/worktrees/<id>/` nested mess that
  // breaks the Dockerfile's COPY paths. Pinning to `__dirname` keeps the
  // standalone output shaped like `.next/standalone/{server.js,node_modules,...}`
  // in every environment (worktree, fresh clone, CI, Docker).
  outputFileTracingRoot: path.resolve(__dirname),
  serverExternalPackages: ["@atproto/tap", "thread-stream", "pino"],
};

export default nextConfig;
