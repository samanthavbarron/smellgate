import { NextRequest, NextResponse } from "next/server";
import { getOAuthClient } from "@/lib/auth/client";
import { getDb } from "@/lib/db";
import { rewritePendingRecords } from "@/lib/server/smellgate-curator-actions";

const PUBLIC_URL = process.env.PUBLIC_URL || "http://127.0.0.1:3000";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const client = await getOAuthClient();

    // Exchange code for session
    const { session } = await client.callback(params);

    // Phase 3.C rewrite mechanic: once we have a usable OAuth session,
    // check whether this user has any pending `com.smellgate.*` records
    // whose submission has been resolved since the last login, and
    // rewrite their strongRefs to the canonical perfume in place on
    // their PDS. See `lib/server/smellgate-curator-actions.ts` and
    // docs/lexicons.md §"The submission → canonical flow".
    //
    // Fire-and-forget (#62): the rewrite can take seconds against the
    // user's PDS and we don't want to make login wait on it. Errors
    // are swallowed and logged — the next login will retry, because
    // `rewritePendingRecords` recomputes the pending set from the
    // cache every time. This assumes the Node.js runtime: Next.js
    // Edge functions abort dangling promises when the response is
    // sent, but this route runs on Node (see next.config and the
    // absence of `export const runtime = "edge"`).
    void rewritePendingRecords(getDb(), session).catch((err) => {
      console.warn("[callback] rewrite failed", err);
    });

    const response = NextResponse.redirect(new URL("/", PUBLIC_URL));

    // Set DID cookie
    response.cookies.set("did", session.did, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 1 week
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("OAuth callback error:", error);
    return NextResponse.redirect(new URL("/?error=login_failed", PUBLIC_URL));
  }
}
