/**
 * GET /api/smellgate/curator/submissions — list pending perfume
 * submissions for the curator UI / CLI. Curator-gated via `isCurator`
 * inside `listPendingSubmissionsAction`.
 *
 * Response shape is the decorated `DecoratedPendingSubmission[]` the
 * SSR page consumes, so CLI triage sees notes + authorHandle without
 * re-implementing the fan-out (issue #140).
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
    const { submissions } = await listPendingSubmissionsAction(
      getDb(),
      session,
    );
    return NextResponse.json({ submissions });
  } catch (err) {
    if (err instanceof ActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
