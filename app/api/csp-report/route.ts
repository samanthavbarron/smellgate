/**
 * CSP violation reporting sink (#172).
 *
 * Accepts POST bodies from browsers when a Content-Security-Policy
 * (or Content-Security-Policy-Report-Only) directive is violated. The
 * endpoint is referenced from:
 *   - `report-uri /api/csp-report` (legacy CSP Level 2 directive —
 *     still widely supported; body Content-Type is
 *     `application/csp-report`).
 *   - `report-to csp-endpoint` (newer Reporting API; body Content-Type
 *     is `application/reports+json`, shape is an array of reports).
 *
 * We're in Report-Only mode today: the whole point of collecting these
 * is to see what a real baseline needs before we flip CSP to enforce.
 * So we `console.warn` (Fly captures stdout/stderr, that's the log
 * channel we'll watch), and return 204.
 *
 * The handler never fails the request — a reporting endpoint that
 * 5xx's will cost the browser a retry but not affect the page load,
 * though some browsers blacklist flaky endpoints. We accept malformed
 * bodies silently.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    const body = await req.text();
    // Two shapes to handle: `application/csp-report` (single `{ "csp-report": {...} }`)
    // and `application/reports+json` (array of `{ type, body, ... }`). We don't
    // try to normalize — just log what we got.
    console.warn("[csp-report]", {
      contentType,
      userAgent: req.headers.get("user-agent") ?? undefined,
      body: body.slice(0, 4000), // cap to keep stray huge payloads from flooding logs
    });
  } catch {
    // Swallow — this endpoint must never throw upstream. Missing or
    // unreadable bodies aren't worth a 500.
  }
  return new NextResponse(null, { status: 204 });
}
