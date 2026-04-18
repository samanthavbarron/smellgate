/**
 * POST /api/smellgate/submission — propose a new perfume.
 *
 * Thin wrapper around `submitPerfumeAction`. Any authenticated user may
 * submit; no curator check. Writes a `app.smellgate.perfumeSubmission`
 * to the caller's own PDS and returns the new AT-URI.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  submitPerfumeAction,
  type SubmitPerfumeInput,
} from "@/lib/server/smellgate-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: SubmitPerfumeInput;
  try {
    input = (await request.json()) as SubmitPerfumeInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await submitPerfumeAction(getDb(), session, input);
    // Issue #111 / #124 / #126 / #128: echo the full envelope so the
    // submitter can tell this is a submission (not a live record),
    // see what was stored, and detect the idempotent-duplicate path.
    return NextResponse.json({
      success: true,
      uri: result.uri,
      status: result.status,
      message: result.message,
      record: result.record,
      ...(result.idempotent ? { idempotent: true } : {}),
      // Issue #127: surface catalog-dup candidates so the composer can
      // warn the user. Omitted entirely when empty to keep the common
      // response shape clean.
      ...(result.potentialDuplicates
        ? { potentialDuplicates: result.potentialDuplicates }
        : {}),
      // Backwards-compatible alias for the #128 shape. New clients
      // should read `record.notes` etc.
      normalized: result.normalized,
    });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
