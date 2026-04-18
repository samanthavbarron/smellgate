/**
 * GET /api/smellgate/me/submissions — the authenticated user's own
 * `app.smellgate.perfumeSubmission` records, annotated with
 * resolution state.
 *
 * Response shape mirrors the HTML at `/profile/me/submissions`: a
 * flat `items: MySubmissionItem[]` plus a `grouped` object keyed by
 * state so the CLI can print a bucketed summary without replaying
 * the group-by logic client-side. Issue #131.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  groupSubmissionsByState,
  listMySubmissionsAction,
} from "@/lib/server/smellgate-actions";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const items = await listMySubmissionsAction(getDb(), session);
    const grouped = groupSubmissionsByState(items);
    return NextResponse.json({
      total: items.length,
      items,
      counts: {
        pending: grouped.pending.length,
        approved: grouped.approved.length,
        rejected: grouped.rejected.length,
        duplicate: grouped.duplicate.length,
      },
    });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
