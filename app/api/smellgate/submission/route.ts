/**
 * POST /api/smellgate/submission — propose a new perfume.
 *
 * Thin wrapper around `submitPerfumeAction`. Any authenticated user may
 * submit; no curator check. Writes a `com.smellgate.perfumeSubmission`
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
    return NextResponse.json({ success: true, uri: result.uri });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
