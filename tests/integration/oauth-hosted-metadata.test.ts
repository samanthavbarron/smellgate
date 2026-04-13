/**
 * Shape test for the OAuth hosted-metadata code path.
 *
 * The end-to-end loopback OAuth flow is exercised by `oauth-pds.test.ts`.
 * The hosted path (`PUBLIC_URL` + `PRIVATE_KEY` set, `private_key_jwt`
 * client authentication, JWKS published from the app) has historically
 * never been touched by tests because every dev/test interaction runs at
 * 127.0.0.1 against an in-process PDS. This test catches the obvious
 * failure modes — bit rot in the metadata shape, mismatch between the
 * static metadata and what `getOAuthClient()` actually constructs, and
 * (critically) leakage of the private key component from the JWKS route.
 *
 * What it verifies:
 *
 * 1. With `PUBLIC_URL` and a valid `PRIVATE_KEY` JWK set in the env,
 *    `getOAuthClient()` constructs without throwing and the `clientMetadata`
 *    on the resulting client has the expected hosted shape (private_key_jwt,
 *    ES256, JWKS URI, redirect URI under PUBLIC_URL).
 * 2. The static metadata route at `app/oauth-client-metadata.json/route.ts`
 *    returns the same shape `getOAuthClient()` constructs (so the published
 *    `client_id` URL and the in-memory client never drift).
 * 3. The JWKS route at `app/.well-known/jwks.json/route.ts` returns a
 *    well-formed JWKS document AND — security-critical — every key in the
 *    response has no `d` (private scalar) component.
 *
 * What it does NOT verify (out of scope, requires a real host):
 *
 * - That a real Authorization Server can fetch `oauth-client-metadata.json`
 *   over HTTPS and validate it.
 * - That a real PAR / token exchange / DPoP cycle with `private_key_jwt`
 *   works against a remote PDS. The loopback `oauth-pds.test.ts` covers
 *   the full flow with `none` client auth.
 *
 * This test must NOT import `lib/auth/client.ts` at the top level: that
 * module reads `PUBLIC_URL` / `PRIVATE_KEY` at import time, so the env
 * vars have to be set first. We use dynamic `import()` after `vi.resetModules()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JoseKey } from '@atproto/oauth-client-node'

const TEST_PUBLIC_URL = 'https://smellgate.example'

async function makeTestPrivateJwk(): Promise<string> {
  const key = await JoseKey.generate(['ES256'], 'test-key-' + Date.now())
  return JSON.stringify(key.privateJwk)
}

describe('OAuth hosted metadata path', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it('getOAuthClient() builds a valid hosted clientMetadata when PUBLIC_URL + PRIVATE_KEY are set', async () => {
    const privateJwk = await makeTestPrivateJwk()
    process.env.PUBLIC_URL = TEST_PUBLIC_URL
    process.env.PRIVATE_KEY = privateJwk

    const { getOAuthClient, SCOPE } = await import('../../lib/auth/client')
    const client = await getOAuthClient()

    const md = client.clientMetadata
    expect(md.client_id).toBe(`${TEST_PUBLIC_URL}/oauth-client-metadata.json`)
    expect(md.client_uri).toBe(TEST_PUBLIC_URL)
    expect(md.redirect_uris).toEqual([`${TEST_PUBLIC_URL}/oauth/callback`])
    expect(md.jwks_uri).toBe(`${TEST_PUBLIC_URL}/.well-known/jwks.json`)
    expect(md.scope).toBe(SCOPE)
    expect(md.token_endpoint_auth_method).toBe('private_key_jwt')
    expect(md.token_endpoint_auth_signing_alg).toBe('ES256')
    expect(md.grant_types).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    )
    expect(md.response_types).toEqual(['code'])
    expect(md.dpop_bound_access_tokens).toBe(true)
    expect(md.application_type).toBe('web')

    // The clientMetadata must not embed the private key.
    const serialized = JSON.stringify(md)
    expect(serialized).not.toContain('"d":')
  })

  it('the oauth-client-metadata.json route serves the same shape that getOAuthClient() uses', async () => {
    const privateJwk = await makeTestPrivateJwk()
    process.env.PUBLIC_URL = TEST_PUBLIC_URL
    process.env.PRIVATE_KEY = privateJwk

    const { getOAuthClient } = await import('../../lib/auth/client')
    const { GET } = await import('../../app/oauth-client-metadata.json/route')

    const res = await GET()
    expect(res.status).toBe(200)
    const served = await res.json()

    const client = await getOAuthClient()
    expect(served).toEqual(JSON.parse(JSON.stringify(client.clientMetadata)))

    // Defense-in-depth: the published metadata document MUST NOT contain
    // the private key scalar `d`. JWKS goes out via /.well-known/jwks.json,
    // not via the client metadata document.
    expect(JSON.stringify(served)).not.toContain('"d":')
  })

  it('the .well-known/jwks.json route returns a well-formed JWKS with NO private components', async () => {
    const privateJwk = await makeTestPrivateJwk()
    process.env.PUBLIC_URL = TEST_PUBLIC_URL
    process.env.PRIVATE_KEY = privateJwk

    const { GET } = await import('../../app/.well-known/jwks.json/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> }

    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys.length).toBe(1)

    const [jwk] = body.keys
    // Required public-key fields for an EC key.
    expect(jwk.kty).toBe('EC')
    expect(jwk.crv).toBe('P-256')
    expect(typeof jwk.x).toBe('string')
    expect(typeof jwk.y).toBe('string')
    // Anything that would expose the private key.
    expect(jwk).not.toHaveProperty('d')
    // And as a final guard, no `d` anywhere in the serialized response.
    expect(JSON.stringify(body)).not.toContain('"d":')

    // The `d` we generated is in the env, so this also confirms we are
    // not just stringifying the input as-is.
    const original = JSON.parse(privateJwk) as { d?: string }
    expect(original.d).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain(original.d as string)
  })

  it('the .well-known/jwks.json route returns an empty key set when PRIVATE_KEY is unset (loopback dev)', async () => {
    delete process.env.PRIVATE_KEY
    delete process.env.PUBLIC_URL

    const { GET } = await import('../../app/.well-known/jwks.json/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { keys: unknown[] }
    expect(body.keys).toEqual([])
  })
})
