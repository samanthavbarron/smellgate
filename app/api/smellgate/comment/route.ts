/**
 * POST /api/smellgate/comment — comment on a review.
 *
 * Thin wrapper around `commentOnReviewAction`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  commentOnReviewAction,
  type CommentOnReviewInput,
} from "@/lib/server/smellgate-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: CommentOnReviewInput;
  try {
    input = (await request.json()) as CommentOnReviewInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await commentOnReviewAction(getDb(), session, input);
    // Issue #124: echo the persisted record + `indexed: false`.
    return NextResponse.json({
      success: true,
      uri: result.uri,
      record: result.record,
      indexed: result.indexed,
    });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
