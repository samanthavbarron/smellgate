/**
 * POST /api/smellgate/curator/reject — curator-only.
 *
 * Writes a `perfumeSubmissionResolution` with `decision: "rejected"`.
 * No canonical perfume is created. The UI prompts the submitter to
 * edit or delete; this route never touches the submitter's records.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  rejectSubmissionAction,
  type RejectSubmissionInput,
} from "@/lib/server/smellgate-curator-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: RejectSubmissionInput;
  try {
    input = (await request.json()) as RejectSubmissionInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await rejectSubmissionAction(getDb(), session, input);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
