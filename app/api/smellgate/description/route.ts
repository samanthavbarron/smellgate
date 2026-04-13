/**
 * POST /api/smellgate/description — post a community description.
 *
 * Thin wrapper around `postDescriptionAction`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  postDescriptionAction,
  type PostDescriptionInput,
} from "@/lib/server/smellgate-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: PostDescriptionInput;
  try {
    input = (await request.json()) as PostDescriptionInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await postDescriptionAction(getDb(), session, input);
    return NextResponse.json({ success: true, uri: result.uri });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
