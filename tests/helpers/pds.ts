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
 * Test code should depend on the deterministic handle/password convention
 * here so the same accounts are available across runs.
 */

import { TestNetworkNoAppView } from '@atproto/dev-env'

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

export type EphemeralPds = {
  /** Base URL of the in-process PDS, e.g. `http://localhost:2583`. */
  url: string
  /** Underlying network handle (PDS + PLC). */
  network: TestNetworkNoAppView
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
  return { url: network.pds.url, network }
}

/** Stop and dispose the PDS + PLC. Safe to call once. */
export async function stopEphemeralPds(pds: EphemeralPds): Promise<void> {
  await pds.network.close()
}

/**
 * Create N test accounts on the given PDS. Handles, passwords, and emails
 * are deterministic so test assertions can hard-code them.
 */
export async function createTestAccounts(
  pds: EphemeralPds,
  specs: readonly TestAccountSpec[] = DEFAULT_TEST_ACCOUNTS,
): Promise<TestAccountCreds[]> {
  const seedClient = pds.network.getSeedClient()
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
