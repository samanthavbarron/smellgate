/**
 * In-process ephemeral PDS for integration tests.
 *
 * Wraps `@atproto/dev-env`'s `TestNetworkNoAppView`, which spins up a
 * fresh PDS *and* a local PLC directory inside the current Node process —
 * no docker, no external network calls. Each call to `startEphemeralPds`
 * gets brand-new state on a brand-new port; `stopEphemeralPds` tears it
 * down. Lifecycle is explicit on purpose: callers (e.g. a Vitest
 * `globalSetup`) decide when to start/stop. There is no module-level
 * singleton.
 *
 * Public surface (#20): integration tests see only a small, intentional
 * API — `url`, the helper functions in this module, and nothing else.
 * The `TestNetworkNoAppView` handle is kept in a module-private
 * WeakMap keyed on the returned `EphemeralPds`, so tests cannot reach
 * into the full `@atproto/dev-env` surface area (which would couple
 * them to dev-env internals and defeat the point of the helper).
 *
 * Test code should depend on the deterministic handle/password convention
 * here so the same accounts are available across runs.
 */

import { TestNetworkNoAppView } from '@atproto/dev-env'
import {
  NodeOAuthClient,
  buildAtprotoLoopbackClientMetadata,
  type NodeSavedSession,
  type NodeSavedState,
} from '@atproto/oauth-client-node'

/** Default deterministic test accounts. Stable across runs. */
export const DEFAULT_TEST_ACCOUNTS = [
  { shortName: 'alice', handle: 'alice.test', password: 'alice-pw' },
  { shortName: 'bob', handle: 'bob.test', password: 'bob-pw' },
] as const

export type TestAccountSpec = {
  shortName: string
  handle: string
  password: string
}

/** Credentials returned to test code. Mirrors `SeedClient` account shape. */
export type TestAccountCreds = {
  shortName: string
  did: string
  handle: string
  email: string
  password: string
  accessJwt: string
  refreshJwt: string
}

/**
 * Public handle returned to tests. Intentionally narrow: only the PDS
 * base URL is exposed. Everything else — the underlying
 * `TestNetworkNoAppView`, the PLC directory URL, the seed client —
 * is kept module-private (see `networkFor` below) so tests can only
 * use the thin helpers exported from this file.
 */
export type EphemeralPds = {
  /** Base URL of the in-process PDS, e.g. `http://localhost:2583`. */
  readonly url: string
}

/**
 * Module-private map from the returned `EphemeralPds` handle to its
 * underlying `TestNetworkNoAppView`. WeakMap so a dropped handle is
 * garbage-collectable without an explicit `delete`.
 *
 * This replaces the former `pds.network` public field. Code inside
 * this module uses `networkFor(pds)` to reach the full dev-env
 * surface; code outside this module cannot.
 */
const NETWORK_BY_PDS = new WeakMap<EphemeralPds, TestNetworkNoAppView>()

function networkFor(pds: EphemeralPds): TestNetworkNoAppView {
  const network = NETWORK_BY_PDS.get(pds)
  if (!network) {
    throw new Error(
      'EphemeralPds has no associated network — was it created by startEphemeralPds()?',
    )
  }
  return network
}

/**
 * Start a fresh in-process PDS + PLC. Resolves once the PDS is accepting
 * requests — `TestNetworkNoAppView.create()` only returns after the
 * underlying servers are listening, so no extra health-check loop is
 * needed. If startup hangs, the caller's test-runner timeout (or the
 * optional `timeoutMs` here) will surface it instead of a fixed sleep.
 */
export async function startEphemeralPds(
  opts: { timeoutMs?: number } = {},
): Promise<EphemeralPds> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const network = await withTimeout(
    TestNetworkNoAppView.create({}),
    timeoutMs,
    `PDS failed to start within ${timeoutMs}ms`,
  )
  const handle: EphemeralPds = { url: network.pds.url }
  NETWORK_BY_PDS.set(handle, network)
  return handle
}

/** Stop and dispose the PDS + PLC. Safe to call once. */
export async function stopEphemeralPds(pds: EphemeralPds): Promise<void> {
  const network = NETWORK_BY_PDS.get(pds)
  if (!network) return
  NETWORK_BY_PDS.delete(pds)
  await network.close()
}

/**
 * Create N test accounts on the given PDS. Handles, passwords, and emails
 * are deterministic so test assertions can hard-code them.
 */
export async function createTestAccounts(
  pds: EphemeralPds,
  specs: readonly TestAccountSpec[] = DEFAULT_TEST_ACCOUNTS,
): Promise<TestAccountCreds[]> {
  const seedClient = networkFor(pds).getSeedClient()
  const out: TestAccountCreds[] = []
  for (const spec of specs) {
    const acct = await seedClient.createAccount(spec.shortName, {
      handle: spec.handle,
      email: `${spec.shortName}@test.invalid`,
      password: spec.password,
    })
    out.push({
      shortName: spec.shortName,
      did: acct.did,
      handle: acct.handle,
      email: acct.email,
      password: acct.password,
      accessJwt: acct.accessJwt,
      refreshJwt: acct.refreshJwt,
    })
  }
  return out
}

/**
 * Build a {@link NodeOAuthClient} wired to an ephemeral test PDS.
 *
 * Mirrors the loopback-client branch of the production OAuth setup in
 * `lib/auth/client.ts`: loopback `client_id`, no keyset,
 * `token_endpoint_auth_method: 'none'`. Differences from production:
 *
 * - `allowHttp: true` so the client will talk to the http-only test PDS.
 * - `handleResolver` forced to the test PDS URL so `alice.test` resolves
 *   against the in-process server instead of DNS / `bsky.social`.
 * - Scope is `atproto transition:generic` (broad write access) since
 *   smellgate lexicons don't exist yet and the integration test writes a
 *   stock `app.bsky.feed.post`. Production uses a narrower `repo:*` scope.
 *
 * State and session stores are in-memory `Map`s — tests don't need
 * persistence across runs.
 *
 * @param pds - handle returned by {@link startEphemeralPds}
 * @param opts.scope - override scope (defaults to `atproto transition:generic`)
 * @param opts.redirectUri - override redirect URI (defaults to
 *   `http://127.0.0.1/` — valid loopback form, never actually dereferenced
 *   because the test reads the `code` from the redirect Location header)
 */
export function createTestOAuthClient(
  pds: EphemeralPds,
  opts: {
    scope?: `atproto${string}` | `atproto ${string}`
    redirectUri?: `http://127.0.0.1${string}` | `http://[::1]${string}`
  } = {},
): NodeOAuthClient {
  const scope = opts.scope ?? 'atproto transition:generic'
  const redirectUri = opts.redirectUri ?? 'http://127.0.0.1/'
  const clientMetadata = buildAtprotoLoopbackClientMetadata({
    scope,
    redirect_uris: [redirectUri],
  })
  const stateStore = new Map<string, NodeSavedState>()
  const sessionStore = new Map<string, NodeSavedSession>()
  return new NodeOAuthClient({
    clientMetadata,
    allowHttp: true,
    handleResolver: pds.url,
    // Resolve DIDs against the in-process PLC directory, not the public
    // `plc.directory`. Without this the OAuth client would try to hit
    // the network during authorization and fail.
    plcDirectoryUrl: networkFor(pds).plc.url,
    stateStore: {
      async get(key) {
        return stateStore.get(key)
      },
      async set(key, value) {
        stateStore.set(key, value)
      },
      async del(key) {
        stateStore.delete(key)
      },
    },
    sessionStore: {
      async get(key) {
        return sessionStore.get(key)
      },
      async set(key, value) {
        sessionStore.set(key, value)
      },
      async del(key) {
        sessionStore.delete(key)
      },
    },
  })
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
