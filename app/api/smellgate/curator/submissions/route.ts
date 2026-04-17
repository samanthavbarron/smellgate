/**
 * GET /api/smellgate/curator/submissions — list pending perfume
 * submissions for the curator UI / CLI. Curator-gated via `isCurator`
 * inside `listPendingSubmissionsAction`.
 *
 * Response shape is the same decorated `DecoratedPendingSubmission[]`
 * the SSR page consumes, plus a `totalPending` count (issue #140).
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  listPendingSubmissionsAction,
} from "@/lib/server/smellgate-curator-actions";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { submissions, totalPending } = await listPendingSubmissionsAction(
      getDb(),
      session,
    );
    return NextResponse.json({ submissions, totalPending });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
