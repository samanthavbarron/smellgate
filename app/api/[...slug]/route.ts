/**
 * Catch-all `/api/*` 404 handler (#186).
 *
 * Any request to an unmatched `/api/*` path returns a JSON 404 rather
 * than falling through to the app's HTML `not-found.tsx`. The global
 * `app/not-found.tsx` is fine for human pages, but any programmatic
 * client (internal or third-party) that mistypes an endpoint will
 * choke if it gets HTML with `content-type: text/html`.
 *
 * This route is selected by Next.js only when no more-specific route
 * under `/api/` matches, so it doesn't shadow any real endpoint.
 */
import { NextResponse } from "next/server";

const NOT_FOUND_JSON = { error: "Not Found" };

function respond(): NextResponse {
  return NextResponse.json(NOT_FOUND_JSON, { status: 404 });
}

export const GET = respond;
export const HEAD = respond;
export const POST = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const OPTIONS = respond;
