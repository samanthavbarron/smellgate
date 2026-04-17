/**
 * POST /api/smellgate/review — post a review of a perfume.
 *
 * Thin wrapper around `postReviewAction`. See
 * `app/api/smellgate/shelf/route.ts` for the architecture rationale.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  postReviewAction,
  type PostReviewInput,
} from "@/lib/server/smellgate-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: PostReviewInput;
  try {
    input = (await request.json()) as PostReviewInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await postReviewAction(getDb(), session, input);
    // Issue #124: echo the persisted record.
    return NextResponse.json({
      success: true,
      uri: result.uri,
      record: result.record,
    });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
