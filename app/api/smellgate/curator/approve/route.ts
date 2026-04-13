/**
 * POST /api/smellgate/curator/approve — curator-only.
 *
 * Wraps `approveSubmissionAction`: writes a canonical
 * `com.smellgate.perfume` + a `perfumeSubmissionResolution` to the
 * curator's PDS.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  approveSubmissionAction,
  type ApproveSubmissionInput,
} from "@/lib/server/smellgate-curator-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: ApproveSubmissionInput;
  try {
    input = (await request.json()) as ApproveSubmissionInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await approveSubmissionAction(getDb(), session, input);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
