import { NextResponse } from "next/server";

// Liveness endpoint for Fly's [checks] block. Deliberately does NOT touch the
// database, OAuth session store, or any external service — a healthcheck that
// fails for any reason other than "the Node process is dead" will prevent the
// machine from ever coming up, which is a deploy hazard.
//
// The `commit` field echoes the `GIT_COMMIT` build-arg wired in from the
// deploy workflow (see `.github/workflows/deploy.yml` and the runner stage in
// the root `Dockerfile`). It's handy for confirming which revision a given
// machine is actually running after a rollout.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    commit: process.env.GIT_COMMIT ?? "unknown",
    now: new Date().toISOString(),
  });
}
