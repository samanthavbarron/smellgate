/**
 * GET /api/smellgate/curator/search — curator-only canonical-perfume
 * typeahead for the "Mark duplicate" flow (issue #139).
 *
 * Query params:
 *   - `q`  (required) : substring to match against name / house /
 *                       creator / note. Same semantics as the public
 *                       `/search` page.
 *   - `limit` (optional): how many candidates to return. Defaults to 5
 *                         inside the action; hard-capped at 25.
 *
 * Why curator-gated and not just a reuse of the public search endpoint:
 * we didn't want to grow a public endpoint just for this — and routing
 * under `/api/smellgate/curator/` keeps the authorization story
 * uniform with approve / reject / duplicate.
 *
 * The 401 / 403 split matches the sibling curator routes: 401 when no
 * session, 403 when the session isn't on the curator allowlist (handled
 * inside `listCanonicalCandidatesAction` via `ActionError`).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  listCanonicalCandidatesAction,
} from "@/lib/server/smellgate-curator-actions";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit =
    limitParam !== null && limitParam.length > 0
      ? Number.parseInt(limitParam, 10)
      : undefined;
  if (limit !== undefined && Number.isNaN(limit)) {
    return NextResponse.json({ error: "invalid limit" }, { status: 400 });
  }
  try {
    const result = await listCanonicalCandidatesAction(getDb(), session, {
      query: q,
      ...(limit !== undefined ? { limit } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
