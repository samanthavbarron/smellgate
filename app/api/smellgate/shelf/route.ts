/**
 * POST /api/smellgate/shelf — add a perfume to the signed-in user's shelf.
 *
 * Thin wrapper around `addToShelfAction` (lib/server/smellgate-actions).
 * Mirrors the shape of `app/api/status/route.ts`: pull the OAuth
 * session via `getSession`, parse the JSON body, delegate, return
 * `{ success, uri }` or an error JSON with the right HTTP status.
 *
 * Why route handlers (not server actions): the existing statusphere
 * write path is a POST route handler, and we match the in-tree
 * convention rather than introducing `"use server"` here.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import {
  ActionError,
  addToShelfAction,
  type AddToShelfInput,
} from "@/lib/server/smellgate-actions";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let input: AddToShelfInput;
  try {
    input = (await request.json()) as AddToShelfInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await addToShelfAction(getDb(), session, input);
    // Issue #119 / #124: echo the persisted record. Optional fields
    // (bottleSizeMl, isDecant, acquiredAt) only appear when set so
    // the client can confirm they landed.
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
