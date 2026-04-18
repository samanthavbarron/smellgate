import { NextRequest, NextResponse } from "next/server";
import { parseTapEvent, assureAdminAuth } from "@atproto/tap";
import { AtUri } from "@atproto/syntax";
import { getDb } from "@/lib/db";
import { dispatchSmellgateEvent } from "@/lib/tap/smellgate";
import * as xyz from "@/lib/lexicons/xyz";
import {
  upsertAccount,
  deleteAccount,
  insertStatus,
  deleteStatus,
} from "@/lib/db/queries";

// Captured once at module load. `instrumentation.ts` enforces a
// non-empty value in production; this constant is the runtime side
// of that guarantee, and carries a deliberately conservative check
// (`typeof === "string" && length > 0`) so we never treat an empty
// string, `undefined`, or any truthy-but-malformed value as "auth
// disabled". The only escape hatch is `NODE_ENV !== "production"` —
// local dev and the integration tests read the env as literally
// empty, which we treat as "auth not configured, skip" for ergonomic
// reasons.
const TAP_ADMIN_PASSWORD = process.env.TAP_ADMIN_PASSWORD;
const AUTH_ENABLED =
  typeof TAP_ADMIN_PASSWORD === "string" && TAP_ADMIN_PASSWORD.length > 0;

const STATUSPHERE_COLLECTION = "xyz.statusphere.status";
const SMELLGATE_NSID_PREFIX = "app.smellgate.";

export async function POST(request: NextRequest) {
  // Belt-and-suspenders: if the production guard in instrumentation.ts
  // ever slips (e.g. a future refactor moves the check elsewhere),
  // refuse to serve requests rather than fall back to "auth disabled".
  if (process.env.NODE_ENV === "production" && !AUTH_ENABLED) {
    return NextResponse.json(
      { error: "Service misconfigured: TAP_ADMIN_PASSWORD is empty" },
      { status: 503 },
    );
  }

  // Verify request is from our TAP server. Skipped entirely in non-
  // production when the secret is unset/empty — matches the existing
  // contract used by tests.
  if (AUTH_ENABLED) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      assureAdminAuth(TAP_ADMIN_PASSWORD as string, authHeader);
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await request.json();
  const evt = parseTapEvent(body);

  // Handle account/identity changes
  if (evt.type === "identity") {
    if (evt.status === "deleted") {
      await deleteAccount(evt.did);
    } else {
      await upsertAccount({
        did: evt.did,
        handle: evt.handle,
        active: evt.isActive ? 1 : 0,
      });
    }
  }

  // Handle record events. We dispatch by collection NSID:
  //  - app.smellgate.* → Phase 2 read-cache dispatcher
  //  - xyz.statusphere.status → legacy starter handler (untouched)
  //  - anything else → no-op
  if (evt.type === "record") {
    if (evt.collection.startsWith(SMELLGATE_NSID_PREFIX)) {
      await dispatchSmellgateEvent(getDb(), evt);
    } else if (evt.collection === STATUSPHERE_COLLECTION) {
      const uri = AtUri.make(evt.did, evt.collection, evt.rkey);

      if (evt.action === "create" || evt.action === "update") {
        let record: xyz.statusphere.status.Main;
        try {
          record = xyz.statusphere.status.$parse(evt.record);
        } catch {
          return NextResponse.json({ success: false });
        }

        await insertStatus({
          uri: uri.toString(),
          authorDid: evt.did,
          status: record.status,
          createdAt: record.createdAt,
          indexedAt: new Date().toISOString(),
          current: 1,
        });
      } else if (evt.action === "delete") {
        await deleteStatus(uri);
      }
    }
  }

  return NextResponse.json({ success: true });
}
