import { NextResponse } from "next/server";
import { JoseKey } from "@atproto/oauth-client-node";

// JWKS endpoint for the hosted-metadata OAuth flow. The Authorization Server
// fetches this URL (referenced as `jwks_uri` in the client metadata document)
// to verify `private_key_jwt` client assertions during PAR / token exchange.
//
// SECURITY: this route MUST only ever return public-key components. We
// derive the public JWK via `@atproto/jwk`'s `JoseKey.publicJwk` getter,
// which strips the private scalar `d` (and any other private fields). Do
// NOT serialize the raw `PRIVATE_KEY` env var here — that would leak the
// signing key. The shape test in
// `tests/integration/oauth-hosted-metadata.test.ts` enforces this.
//
// The env var is read at request time, not module load time, so a
// production deploy can rotate the key by restarting without rebuilding.
export const dynamic = "force-dynamic";

export async function GET() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) {
    // Loopback dev mode: no signing key is configured, so there is nothing
    // to publish. Return an empty key set rather than 404 so that any
    // upstream that probes the URL gets a well-formed JWKS document.
    return NextResponse.json({ keys: [] });
  }

  const key = await JoseKey.fromJWK(JSON.parse(PRIVATE_KEY));
  const publicJwk = key.publicJwk;
  if (!publicJwk) {
    // Defensive: a symmetric key would not have a public counterpart.
    // We never generate one (`scripts/gen-key.ts` produces ES256), but if
    // somebody points PRIVATE_KEY at the wrong thing we fail closed
    // rather than echoing the input.
    return NextResponse.json({ keys: [] });
  }
  return NextResponse.json({ keys: [publicJwk] });
}
