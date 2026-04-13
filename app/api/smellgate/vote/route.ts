/**
 * POST /api/smellgate/vote — up/down a description.
 *
 * Thin wrapper around `voteOnDescriptionAction`. Add-only writes —
 * a re-vote produces a fresh record on the user's PDS and read-time
 * dedupe in `lib/db/smellgate-queries.ts` keeps the latest.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  voteOnDescriptionAction,
  type VoteOnDescriptionInput,
} from "@/lib/server/smellgate-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: VoteOnDescriptionInput;
  try {
    input = (await request.json()) as VoteOnDescriptionInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await voteOnDescriptionAction(getDb(), session, input);
    return NextResponse.json({ success: true, uri: result.uri });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
