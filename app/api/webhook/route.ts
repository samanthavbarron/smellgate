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

const TAP_ADMIN_PASSWORD = process.env.TAP_ADMIN_PASSWORD;

const STATUSPHERE_COLLECTION = "xyz.statusphere.status";
const SMELLGATE_NSID_PREFIX = "app.smellgate.";

export async function POST(request: NextRequest) {
  // Verify request is from our TAP server
  if (TAP_ADMIN_PASSWORD) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      assureAdminAuth(TAP_ADMIN_PASSWORD, authHeader);
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
