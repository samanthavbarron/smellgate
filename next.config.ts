import type { NextConfig } from "next";
import path from "node:path";

/**
 * CSP (Content-Security-Policy) notes (#172)
 * ------------------------------------------
 * We ship CSP in **Report-Only** mode for v1. Enforcing CSP
 * (non-report-only) requires integrating per-request nonces for
 * Next.js's inline hydration bootstrap and Tailwind's inline styles —
 * that's a follow-up once the reports from real traffic show what the
 * baseline actually needs.
 *
 * The current policy:
 *   - `default-src 'self'`
 *   - `script-src 'self' 'unsafe-inline'` — required for Next.js's
 *     RSC/hydration bootstrap until we add nonce support.
 *   - `style-src 'self' 'unsafe-inline'` — required for Tailwind's
 *     generated inline `<style>` tags.
 *   - `img-src 'self' data:` — data URIs for inline chart/preview
 *     snippets if we ever add them.
 *   - `connect-src 'self' https://bsky.social https://plc.directory` —
 *     OAuth flow talks to bsky.social and PLC lookup hits plc.directory.
 *   - `frame-ancestors 'none'` — clickjacking guard (redundant with
 *     the hard `X-Frame-Options: DENY` header but belt-and-suspenders).
 */
const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://bsky.social https://plc.directory",
  "frame-ancestors 'none'",
].join("; ");

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
  // Drop the `x-powered-by: Next.js` header — minor info-disclosure leak (#172).
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value: cspReportOnly,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
