import { NextResponse } from "next/server";
import { getOAuthClient } from "../../lib/auth/client";

// The URL of this endpoint IS the OAuth `client_id`. Authorization servers
// fetch it during PAR / token exchange to learn about the app, including the
// `jwks_uri` they should use to verify our `private_key_jwt` client
// assertions. The shape is built once by `getOAuthClient()` so the published
// metadata and the in-memory `NodeOAuthClient` cannot drift apart.
//
// Static-export safe: this route reads `process.env.PUBLIC_URL` /
// `process.env.PRIVATE_KEY` indirectly through `getOAuthClient`, which is
// request-time, not build-time.
export const dynamic = "force-dynamic";

export async function GET() {
  const client = await getOAuthClient();
  return NextResponse.json(client.clientMetadata);
}
