/**
 * End-to-end OAuth integration test against an in-process ATProto PDS.
 *
 * This test exercises the real OAuth authorization-code flow that the
 * smellgate app uses in production (`@atproto/oauth-client-node`) — no
 * mocks, no stubs, no shortcuts via `SeedClient` JWTs. The only thing we
 * use `createTestAccounts` for is to pre-create an account on the test
 * PDS so the OAuth flow has something to sign in as. The JWTs it returns
 * are intentionally discarded.
 *
 * How the flow is driven without a browser:
 *
 * 1. `NodeOAuthClient.authorize(handle)` does a Pushed Authorization
 *    Request (PAR) against the test PDS and returns an authorization
 *    URL (`/oauth/authorize?request_uri=...`).
 * 2. We GET that URL with a cookie jar. The PDS sign-in page sets a
 *    `csrf-token` cookie and a device-id cookie on the response.
 * 3. We POST to the OAuth provider API (`/@atproto/oauth-provider/~api`)
 *    `/sign-in` and `/consent` endpoints directly, with the cookies,
 *    a matching `x-csrf-token` header, a `Referer` pointing at the
 *    authorize page, and `Sec-Fetch-*` headers — the same things a real
 *    browser would send. The `/consent` response gives us a redirect URL.
 * 4. We GET the redirect URL (with redirects disabled). The PDS responds
 *    with a 3xx whose `Location` header is the loopback `redirect_uri`
 *    with `?code=...&state=...&iss=...` — exactly what a browser would
 *    receive.
 * 5. We parse those params and feed them to `client.callback(params)`,
 *    which exchanges the code for an `OAuthSession`.
 * 6. We use `session.fetchHandler()` — the same DPoP-bound fetch the
 *    production Agent uses — to write and read back an
 *    `app.bsky.feed.post` record.
 *
 * No external network calls: the OAuth client's `handleResolver` is
 * pinned to the test PDS URL, `allowHttp: true` is set, and the
 * `TestNetworkNoAppView` PDS uses an in-process PLC directory.
 */

import * as http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type EphemeralPds,
  createTestAccounts,
  createTestOAuthClient,
  startEphemeralPds,
  stopEphemeralPds,
  type TestAccountCreds,
} from '../helpers/pds'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'

/**
 * Tiny in-memory cookie jar keyed by cookie name. Sufficient because the
 * OAuth provider serves everything from a single origin and we only
 * follow a handful of hops.
 */
class CookieJar {
  private cookies = new Map<string, string>()
  ingest(setCookieHeader: string[] | null | undefined) {
    if (!setCookieHeader) return
    for (const raw of setCookieHeader) {
      const [pair] = raw.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // An empty value with max-age=0 means delete.
      if (value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }
  get(name: string): string | undefined {
    return this.cookies.get(name)
  }
}

type RawResponse = {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/**
 * Minimal HTTP client using `node:http` directly. We can't use the
 * global `fetch` here because undici filters "forbidden" request
 * headers (`sec-fetch-*`), and the PDS's OAuth provider requires them
 * to be set explicitly — exactly the headers a real browser sends on a
 * top-level navigation and on same-origin XHR. `node:http` has no such
 * filter. All traffic stays on localhost.
 */
function rawRequest(
  url: string,
  opts: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:') {
      reject(new Error(`rawRequest only supports http:, got ${parsed.protocol}`))
      return
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (opts.body != null) req.write(opts.body)
    req.end()
  })
}

function getSetCookies(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers['set-cookie']
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

/**
 * Drive the OAuth authorization flow end-to-end against the in-process
 * PDS and return an `OAuthSession`. Returns both the session and the
 * user's DID for assertion convenience.
 */
async function completeOAuthFlow(
  client: NodeOAuthClient,
  handle: string,
  password: string,
): Promise<{ session: Awaited<ReturnType<NodeOAuthClient['restore']>> }> {
  // 1. Kick off authorization (PAR). This already talks to the PDS.
  const authorizeUrl = await client.authorize(handle, {
    scope: 'atproto transition:generic',
  })
  const origin = new URL(authorizeUrl).origin

  const jar = new CookieJar()

  // 2. GET the authorize page so the PDS sets csrf + device cookies.
  //    Emulate a browser doing a top-level navigation.
  const pageRes = await rawRequest(authorizeUrl.toString(), {
    method: 'GET',
    headers: {
      accept: 'text/html',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'none',
      'user-agent': 'smellgate-integration-test',
    },
  })
  jar.ingest(getSetCookies(pageRes.headers))
  if (pageRes.status !== 200) {
    throw new Error(
      `Unexpected authorize page status ${pageRes.status}: ${pageRes.body}`,
    )
  }
  const csrf = jar.get('csrf-token')
  if (!csrf) throw new Error('PDS did not set csrf-token cookie')

  // Headers that the provider API accepts as a "same-origin" request.
  const apiHeaders = (): Record<string, string> => ({
    accept: 'application/json',
    'content-type': 'application/json',
    cookie: jar.header(),
    'x-csrf-token': csrf,
    origin,
    referer: authorizeUrl.toString(),
    'sec-fetch-mode': 'same-origin',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-dest': 'empty',
    'user-agent': 'smellgate-integration-test',
  })

  const apiUrl = (endpoint: string) =>
    `${origin}/@atproto/oauth-provider/~api${endpoint}`

  // 3. POST /sign-in
  const signInRes = await rawRequest(apiUrl('/sign-in'), {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      locale: 'en',
      username: handle,
      password,
      remember: true,
    }),
  })
  jar.ingest(getSetCookies(signInRes.headers))
  if (signInRes.status >= 400) {
    throw new Error(`sign-in failed (${signInRes.status}): ${signInRes.body}`)
  }
  const signInBody = JSON.parse(signInRes.body) as {
    account: { sub: string }
    consentRequired?: boolean
  }

  // 4. POST /consent
  const consentRes = await rawRequest(apiUrl('/consent'), {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ sub: signInBody.account.sub }),
  })
  jar.ingest(getSetCookies(consentRes.headers))
  if (consentRes.status >= 400) {
    throw new Error(`consent failed (${consentRes.status}): ${consentRes.body}`)
  }
  const { url: consentRedirectUrl } = JSON.parse(consentRes.body) as {
    url: string
  }

  // 5. GET the redirect URL without following redirects, so we can
  //    capture the loopback `redirect_uri?code=...` Location.
  const redirectRes = await rawRequest(consentRedirectUrl, {
    method: 'GET',
    headers: {
      cookie: jar.header(),
      accept: 'text/html',
      origin,
      // The `/oauth/authorize/redirect` endpoint requires a referrer
      // whose pathname is `/oauth/authorize` — i.e., the
      // authorization page that spawned this redirect.
      referer: authorizeUrl.toString(),
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'smellgate-integration-test',
    },
  })
  const location = redirectRes.headers['location']
  if (!location || Array.isArray(location)) {
    throw new Error(
      `redirect step returned ${redirectRes.status} with no usable Location: ${redirectRes.body}`,
    )
  }
  const callbackUrl = new URL(location)
  if (!callbackUrl.searchParams.get('code')) {
    throw new Error(`redirect Location missing code: ${location}`)
  }

  // 6. Exchange the code for a session via the real OAuth client.
  const { session } = await client.callback(callbackUrl.searchParams)
  return { session }
}

describe('OAuth against in-process PDS', () => {
  let pds: EphemeralPds
  let accounts: TestAccountCreds[]

  beforeAll(async () => {
    pds = await startEphemeralPds()
    accounts = await createTestAccounts(pds)
  }, 120_000)

  afterAll(async () => {
    if (pds) await stopEphemeralPds(pds)
  })

  it('completes the full authorization-code flow and can write + read a record', async () => {
    const alice = accounts.find((a) => a.shortName === 'alice')
    if (!alice) throw new Error('alice not seeded')

    const client = createTestOAuthClient(pds)
    const { session } = await completeOAuthFlow(
      client,
      alice.handle,
      alice.password,
    )

    // The session must be bound to the seeded DID — this proves the
    // OAuth code path ran end-to-end and didn't e.g. silently reuse a
    // SeedClient JWT.
    expect(session.did).toBe(alice.did)

    // Write a real record via the DPoP-bound fetch.
    const createBody = {
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: 'hello from smellgate oauth integration test',
        createdAt: new Date().toISOString(),
      },
    }
    const createRes = await session.fetchHandler(
      '/xrpc/com.atproto.repo.createRecord',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      },
    )
    expect(createRes.ok).toBe(true)
    const created = (await createRes.json()) as { uri: string; cid: string }
    expect(created.uri).toMatch(
      new RegExp(`^at://${alice.did}/app\\.bsky\\.feed\\.post/`),
    )

    // Read it back.
    const rkey = created.uri.split('/').pop()!
    const getUrl =
      `/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(alice.did)}` +
      `&collection=app.bsky.feed.post` +
      `&rkey=${encodeURIComponent(rkey)}`
    const getRes = await session.fetchHandler(getUrl, { method: 'GET' })
    expect(getRes.ok).toBe(true)
    const fetched = (await getRes.json()) as {
      uri: string
      value: { text: string }
    }
    expect(fetched.uri).toBe(created.uri)
    expect(fetched.value.text).toBe(
      'hello from smellgate oauth integration test',
    )
  }, 60_000)
})
