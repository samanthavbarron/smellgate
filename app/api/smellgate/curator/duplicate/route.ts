/**
 * POST /api/smellgate/curator/duplicate — curator-only.
 *
 * Writes a `perfumeSubmissionResolution` with `decision: "duplicate"`
 * pointing at an existing canonical perfume. Used when a submission
 * is just a re-spelling of something already in the catalog.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  markDuplicateAction,
  type MarkDuplicateInput,
} from "@/lib/server/smellgate-curator-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: MarkDuplicateInput;
  try {
    input = (await request.json()) as MarkDuplicateInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await markDuplicateAction(getDb(), session, input);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
