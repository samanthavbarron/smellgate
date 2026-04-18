/**
 * scripts/agent-as.ts — CLI for the multi-agent bug-bash setup (#106).
 *
 * Usage:
 *
 *   pnpm agent:as <handle> <action> [args...]
 *
 * Examples:
 *
 *   pnpm agent:as alice whoami
 *   pnpm agent:as alice home
 *   pnpm agent:as alice perfume at://did:plc:.../app.smellgate.perfume/abc
 *   pnpm agent:as alice shelf add at://... --bottle-size 50 --decant
 *   pnpm agent:as alice shelf list
 *   pnpm agent:as alice review write at://... --rating 4 --sillage 3 \
 *     --longevity 4 --body "great juice"
 *   pnpm agent:as alice description write at://... --body "smells like..."
 *   pnpm agent:as alice vote at://.../app.smellgate.description/... up
 *   pnpm agent:as alice comment at://.../app.smellgate.review/... \
 *     --body "agreed!"
 *   pnpm agent:as alice submit '{"name":"X","house":"Y","notes":["a","b"]}'
 *   pnpm agent:as alice submissions list
 *   pnpm agent:as curator curator pending
 *   pnpm agent:as curator curator approve at://...
 *   pnpm agent:as curator curator reject at://... --note "spam"
 *   pnpm agent:as curator curator duplicate at://... --canonical at://...
 *
 * How login works (this is the load-bearing bit):
 *
 *   1. Read `.smellgate-dev-env.json` to learn the dev network's PDS URL
 *      and the test account passwords.
 *   2. POST `/oauth/login {handle}` to the dev server. The dev server
 *      builds an authorization URL via its production OAuth client (now
 *      pointed at the dev PDS by the env-var gate in `lib/auth/client.ts`)
 *      and returns it.
 *   3. Drive the PDS sign-in + consent flow over plain `node:http` —
 *      same dance as `tests/integration/oauth-pds.test.ts`'s
 *      `completeOAuthFlow`. This yields the final loopback callback URL
 *      with `?code=...&state=...&iss=...`.
 *   4. GET that callback URL on the *dev server* (not the loopback host)
 *      so the dev server's `/oauth/callback` handler exchanges the code
 *      for a session, persists it in the server's `auth_session` table,
 *      and sets a `did` cookie. We capture the cookie.
 *   5. Persist the cookie + DID + handle to
 *      `.smellgate-agent-sessions/<handle>.json`. Subsequent invocations
 *      skip the OAuth dance and reuse the cookie. The cookie is only
 *      good as long as the same dev server's SQLite session is still
 *      alive — if the server is restarted with a clean DB, or the dev
 *      network restarts, you have to re-login.
 *
 * The agent CLI then makes plain `fetch()` calls to
 * `http://127.0.0.1:3000/api/smellgate/*` with the `did` cookie. Every
 * action exercises the same HTTP path a real browser would.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as http from "node:http";

const APP_URL = process.env.SMELLGATE_DEV_APP_URL ?? "http://127.0.0.1:3000";
const DEV_ENV_FILE = resolve(process.cwd(), ".smellgate-dev-env.json");
const SESSION_DIR = resolve(process.cwd(), ".smellgate-agent-sessions");

// ---------------------------------------------------------------------------
// Dev env file
// ---------------------------------------------------------------------------

type DevEnvFile = {
  pdsUrl: string;
  plcUrl: string;
  curator: { handle: string; did: string; password: string };
  accounts: { handle: string; did: string; password: string }[];
};

function loadDevEnv(): DevEnvFile {
  if (!existsSync(DEV_ENV_FILE)) {
    throw new Error(
      `Dev network file not found at ${DEV_ENV_FILE}. ` +
        `Did you start \`pnpm dev:network\`?`,
    );
  }
  return JSON.parse(readFileSync(DEV_ENV_FILE, "utf8"));
}

function lookupAccount(
  env: DevEnvFile,
  handleOrShort: string,
): { handle: string; did: string; password: string } {
  // Allow short names ("alice") as well as full handles ("alice.test")
  // and the curator alias ("curator").
  if (handleOrShort === "curator" || handleOrShort === env.curator.handle) {
    return env.curator;
  }
  for (const a of env.accounts) {
    if (a.handle === handleOrShort) return a;
    if (a.handle.split(".")[0] === handleOrShort) return a;
  }
  throw new Error(
    `Unknown handle "${handleOrShort}". Known: ${[
      env.curator.handle,
      ...env.accounts.map((a) => a.handle),
    ].join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Stored agent session
// ---------------------------------------------------------------------------

type StoredSession = {
  handle: string;
  did: string;
  cookie: string; // raw `did=...; ...` cookie string
};

function sessionPath(handle: string): string {
  return resolve(SESSION_DIR, `${handle}.json`);
}

function loadStoredSession(handle: string): StoredSession | null {
  const p = sessionPath(handle);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function saveStoredSession(s: StoredSession): void {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(sessionPath(s.handle), JSON.stringify(s, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Tiny HTTP client (mirrors the one in tests/integration/oauth-pds.test.ts)
// ---------------------------------------------------------------------------

class CookieJar {
  private cookies = new Map<string, string>();
  ingest(setCookieHeader: string[] | null | undefined): void {
    if (!setCookieHeader) return;
    for (const raw of setCookieHeader) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }
}

type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function rawRequest(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolveP, rejectP) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") {
      rejectP(
        new Error(`rawRequest only supports http:, got ${parsed.protocol}`),
      );
      return;
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolveP({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", rejectP);
      },
    );
    req.on("error", rejectP);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function getSetCookies(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// ---------------------------------------------------------------------------
// OAuth flow against the dev server
// ---------------------------------------------------------------------------

/**
 * Drive the OAuth flow end-to-end. Returns a `did` cookie string the
 * agent can use to authenticate subsequent requests to the dev server.
 *
 * Mirrors `completeOAuthFlow` from `tests/integration/oauth-pds.test.ts`,
 * but instead of running the OAuth client in-process, it asks the dev
 * server's `/oauth/login` and `/oauth/callback` endpoints to do it.
 * That way the session lands in the dev server's `auth_session` table
 * exactly the way a real browser login would.
 */
async function loginViaDevServer(
  account: { handle: string; did: string; password: string },
): Promise<StoredSession> {
  // 1. Ask the dev server to begin authorization.
  const loginRes = await rawRequest(`${APP_URL}/oauth/login`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "smellgate-agent-cli",
    },
    body: JSON.stringify({ handle: account.handle }),
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `dev-server /oauth/login failed (${loginRes.status}): ${loginRes.body}`,
    );
  }
  const { redirectUrl: authorizeUrl } = JSON.parse(loginRes.body) as {
    redirectUrl: string;
  };
  const origin = new URL(authorizeUrl).origin;

  const jar = new CookieJar();

  // 2. Open the authorize page (PDS) so we get csrf + device cookies.
  const pageRes = await rawRequest(authorizeUrl, {
    method: "GET",
    headers: {
      accept: "text/html",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "none",
      "user-agent": "smellgate-agent-cli",
    },
  });
  jar.ingest(getSetCookies(pageRes.headers));
  if (pageRes.status !== 200) {
    throw new Error(
      `authorize page status ${pageRes.status}: ${pageRes.body}`,
    );
  }
  const csrf = jar.get("csrf-token");
  if (!csrf) throw new Error("PDS did not set csrf-token cookie");

  const apiHeaders = (): Record<string, string> => ({
    accept: "application/json",
    "content-type": "application/json",
    cookie: jar.header(),
    "x-csrf-token": csrf,
    origin,
    referer: authorizeUrl,
    "sec-fetch-mode": "same-origin",
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty",
    "user-agent": "smellgate-agent-cli",
  });
  const apiUrl = (endpoint: string) =>
    `${origin}/@atproto/oauth-provider/~api${endpoint}`;

  // 3. POST /sign-in
  const signInRes = await rawRequest(apiUrl("/sign-in"), {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      locale: "en",
      username: account.handle,
      password: account.password,
      remember: true,
    }),
  });
  jar.ingest(getSetCookies(signInRes.headers));
  if (signInRes.status >= 400) {
    throw new Error(`sign-in failed (${signInRes.status}): ${signInRes.body}`);
  }
  const signInBody = JSON.parse(signInRes.body) as {
    account: { sub: string };
  };

  // 4. POST /consent
  const consentRes = await rawRequest(apiUrl("/consent"), {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({ sub: signInBody.account.sub }),
  });
  jar.ingest(getSetCookies(consentRes.headers));
  if (consentRes.status >= 400) {
    throw new Error(`consent failed (${consentRes.status}): ${consentRes.body}`);
  }
  const { url: consentRedirectUrl } = JSON.parse(consentRes.body) as {
    url: string;
  };

  // 5. Follow the redirect to extract the `?code=...` callback URL.
  const redirectRes = await rawRequest(consentRedirectUrl, {
    method: "GET",
    headers: {
      cookie: jar.header(),
      accept: "text/html",
      origin,
      referer: authorizeUrl,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "same-origin",
      "user-agent": "smellgate-agent-cli",
    },
  });
  const location = redirectRes.headers["location"];
  if (!location || Array.isArray(location)) {
    throw new Error(
      `redirect step returned ${redirectRes.status} with no Location: ${redirectRes.body}`,
    );
  }
  // The Location is the loopback callback like
  // `http://127.0.0.1:3000/oauth/callback?code=...`. Hit it on the dev
  // server (not the loopback host) so the server's callback handler
  // exchanges the code, persists the session, and sets the `did` cookie.
  const callbackUrl = new URL(location);
  const devCallbackUrl = `${APP_URL}${callbackUrl.pathname}${callbackUrl.search}`;

  const callbackRes = await rawRequest(devCallbackUrl, {
    method: "GET",
    headers: {
      accept: "text/html",
      "user-agent": "smellgate-agent-cli",
    },
  });
  // Successful callback redirects to "/". Errors redirect to "/?error=...".
  if (callbackRes.status >= 400) {
    throw new Error(
      `dev-server /oauth/callback failed (${callbackRes.status}): ${callbackRes.body}`,
    );
  }
  const callbackLocation = callbackRes.headers["location"];
  if (
    typeof callbackLocation === "string" &&
    callbackLocation.includes("error=")
  ) {
    throw new Error(`dev-server callback redirected to ${callbackLocation}`);
  }

  // Capture the `did` cookie the server set on us.
  const callbackJar = new CookieJar();
  callbackJar.ingest(getSetCookies(callbackRes.headers));
  const didCookie = callbackJar.get("did");
  if (!didCookie) {
    throw new Error(
      `dev-server callback did not set a did cookie. status=${callbackRes.status} location=${callbackLocation}`,
    );
  }

  return {
    handle: account.handle,
    did: account.did,
    cookie: `did=${didCookie}`,
  };
}

async function ensureSession(handle: string): Promise<StoredSession> {
  const env = loadDevEnv();
  const account = lookupAccount(env, handle);
  const stored = loadStoredSession(account.handle);
  if (stored && stored.did === account.did) {
    return stored;
  }
  if (stored && stored.did !== account.did) {
    console.error(
      `[agent] stored session DID mismatches dev network (stored=${stored.did}, current=${account.did}); re-logging in`,
    );
  }
  console.error(`[agent] logging in as ${account.handle}...`);
  const fresh = await loginViaDevServer(account);
  saveStoredSession(fresh);
  console.error(`[agent] logged in. session at ${sessionPath(account.handle)}`);
  return fresh;
}

// ---------------------------------------------------------------------------
// Authenticated requests against the dev server
// ---------------------------------------------------------------------------

async function authedFetch(
  session: StoredSession,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  const res = await rawRequest(`${APP_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      accept: "application/json,text/html",
      "content-type": "application/json",
      cookie: session.cookie,
      "user-agent": "smellgate-agent-cli",
    },
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: res.body };
}

function expectJson(
  res: { status: number; body: string },
  ctx: string,
): unknown {
  if (res.status >= 400) {
    throw new Error(`${ctx}: HTTP ${res.status}: ${res.body}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`${ctx}: not JSON: ${res.body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type Flags = {
  _: string[];
  named: Record<string, string | boolean>;
};

function parseFlags(args: string[]): Flags {
  const out: Flags = { _: [], named: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = args[i + 1];
      if (next == null || next.startsWith("--")) {
        out.named[name] = true;
      } else {
        out.named[name] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function num(flags: Flags, name: string, required = false): number | undefined {
  const v = flags.named[name];
  if (v === undefined) {
    if (required) throw new Error(`--${name} is required`);
    return undefined;
  }
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`--${name} must be a number, got ${v}`);
  return n;
}

function str(flags: Flags, name: string, required = false): string | undefined {
  const v = flags.named[name];
  if (v === undefined || v === true) {
    if (required) throw new Error(`--${name} is required`);
    return undefined;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Page summarizers (HTML scraping for the read-side actions)
// ---------------------------------------------------------------------------
//
// These parsers rely on `data-smellgate-*` markers emitted by the
// render paths: each card's outermost element gets a
// `data-smellgate-<kind>` attribute whose value is the record's AT-URI.
// Previously the CLI counted occurrences of `data-smellgate-review` /
// `-description`, but no page actually emitted those markers — see
// issue #117. Now we extract URIs and small summaries so the agent
// output is structurally meaningful, not just a zero-count.

// Walk an HTML string and yield each element tagged with the given
// `data-*` attribute. For each hit, we return the attribute value (the
// AT-URI) and the element's innerHTML up to its matching close tag.
// Not a real HTML parser — just bracket-matched slicing with same-tag
// nesting depth tracking. That's adequate for our server-rendered
// React cards, which don't nest the same marker inside themselves.
function* extractMarkedElements(
  html: string,
  attrName: string,
): Generator<{ uri: string; inner: string }> {
  // Attribute values are always double-quoted by React.
  const re = new RegExp(
    `<([a-zA-Z]+)(?=\\s)[^>]*\\s${attrName}="([^"]*)"[^>]*>`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    const tag = m[1];
    const uri = decodeHtml(m[2]);
    const start = m.index + m[0].length;
    const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g");
    const closeRe = new RegExp(`</${tag}>`, "g");
    let depth = 1;
    let cursor = start;
    let innerEnd = -1;
    while (depth > 0) {
      openRe.lastIndex = cursor;
      closeRe.lastIndex = cursor;
      const nextOpen = openRe.exec(html);
      const nextClose = closeRe.exec(html);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose.index + nextClose[0].length;
        if (depth === 0) {
          innerEnd = nextClose.index;
          break;
        }
      }
    }
    if (innerEnd >= 0) {
      yield { uri, inner: html.slice(start, innerEnd) };
    }
  }
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    );
}

// Strip tags and collapse whitespace to produce a plain-text snippet of
// a card's `body`. Truncate to 120 chars.
function snippet(inner: string, max = 120): string {
  const text = decodeHtml(inner.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function extractRating(inner: string): number | null {
  // Both ReviewCard variants render `{rating}/10` in their header.
  const m = /(\d+)\s*\/\s*10/.exec(
    decodeHtml(inner.replace(/<[^>]*>/g, " ")),
  );
  return m ? Number(m[1]) : null;
}

export type HomeSummary = {
  perfumes: string[];
  reviews: { uri: string; rating: number | null; snippet: string }[];
};

export type PerfumeSummary = {
  notes: string[];
  reviews: { uri: string; rating: number | null; snippet: string }[];
  descriptions: { uri: string; snippet: string }[];
};

export type ShelfSummary = {
  items: { uri: string; perfumeUri: string | null }[];
};

function summarizeHome(html: string): HomeSummary {
  const perfumes: string[] = [];
  for (const el of extractMarkedElements(html, "data-smellgate-perfume")) {
    perfumes.push(el.uri);
  }
  const reviews: HomeSummary["reviews"] = [];
  for (const el of extractMarkedElements(html, "data-smellgate-review")) {
    reviews.push({
      uri: el.uri,
      rating: extractRating(el.inner),
      snippet: snippet(el.inner),
    });
  }
  return { perfumes, reviews };
}

function summarizePerfume(html: string): PerfumeSummary {
  const notes: string[] = [];
  const noteRe = /href="\/tag\/note\/([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = noteRe.exec(html)) != null) {
    notes.push(decodeURIComponent(m[1]));
  }
  const reviews: PerfumeSummary["reviews"] = [];
  for (const el of extractMarkedElements(html, "data-smellgate-review")) {
    reviews.push({
      uri: el.uri,
      rating: extractRating(el.inner),
      snippet: snippet(el.inner),
    });
  }
  const descriptions: PerfumeSummary["descriptions"] = [];
  for (const el of extractMarkedElements(html, "data-smellgate-description")) {
    descriptions.push({ uri: el.uri, snippet: snippet(el.inner) });
  }
  return {
    notes: Array.from(new Set(notes)),
    reviews,
    descriptions,
  };
}

function summarizeShelf(html: string): ShelfSummary {
  const items: ShelfSummary["items"] = [];
  for (const el of extractMarkedElements(html, "data-smellgate-shelf-item")) {
    const firstPerfume = extractMarkedElements(
      el.inner,
      "data-smellgate-perfume",
    ).next();
    items.push({
      uri: el.uri,
      perfumeUri:
        !firstPerfume.done && firstPerfume.value
          ? firstPerfume.value.uri
          : null,
    });
  }
  return { items };
}

// Exposed for unit tests — these are pure functions over HTML strings.
export const __parsers = {
  extractMarkedElements,
  snippet,
  extractRating,
  summarizeHome,
  summarizePerfume,
  summarizeShelf,
};

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

async function runAction(
  session: StoredSession,
  args: string[],
): Promise<void> {
  const flags = parseFlags(args);
  const positional = flags._;
  const action = positional[0];

  switch (action) {
    case "whoami": {
      console.log(JSON.stringify({ handle: session.handle, did: session.did }));
      return;
    }
    case "home": {
      const res = await authedFetch(session, "/");
      if (res.status >= 400) throw new Error(`home: HTTP ${res.status}`);
      console.log(JSON.stringify(summarizeHome(res.body)));
      return;
    }
    case "perfume": {
      const uri = positional[1];
      if (!uri) throw new Error("perfume <uri> required");
      const res = await authedFetch(
        session,
        `/perfume/${encodeURIComponent(uri)}`,
      );
      if (res.status >= 400)
        throw new Error(`perfume: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      console.log(JSON.stringify(summarizePerfume(res.body)));
      return;
    }
    case "shelf": {
      const sub = positional[1];
      if (sub === "add") {
        const perfumeUri = positional[2];
        if (!perfumeUri) throw new Error("shelf add <perfume-uri> required");
        const body: Record<string, unknown> = { perfumeUri };
        const sz = num(flags, "bottle-size");
        if (sz !== undefined) body.bottleSizeMl = sz;
        if (flags.named["decant"] === true) body.isDecant = true;
        const res = await authedFetch(session, "/api/smellgate/shelf", {
          method: "POST",
          body,
        });
        console.log(JSON.stringify(expectJson(res, "shelf add")));
        return;
      }
      if (sub === "list") {
        const res = await authedFetch(session, "/profile/me/");
        if (res.status >= 400)
          throw new Error(`shelf list: HTTP ${res.status}`);
        console.log(JSON.stringify(summarizeShelf(res.body)));
        return;
      }
      throw new Error(`unknown shelf subcommand: ${sub}`);
    }
    case "review": {
      const sub = positional[1];
      if (sub !== "write")
        throw new Error(`unknown review subcommand: ${sub}`);
      const perfumeUri = positional[2];
      if (!perfumeUri) throw new Error("review write <perfume-uri> required");
      const body = {
        perfumeUri,
        rating: num(flags, "rating", true),
        sillage: num(flags, "sillage", true),
        longevity: num(flags, "longevity", true),
        body: str(flags, "body", true),
      };
      const res = await authedFetch(session, "/api/smellgate/review", {
        method: "POST",
        body,
      });
      console.log(JSON.stringify(expectJson(res, "review write")));
      return;
    }
    case "description": {
      const sub = positional[1];
      if (sub !== "write")
        throw new Error(`unknown description subcommand: ${sub}`);
      const perfumeUri = positional[2];
      if (!perfumeUri)
        throw new Error("description write <perfume-uri> required");
      const body = { perfumeUri, body: str(flags, "body", true) };
      const res = await authedFetch(session, "/api/smellgate/description", {
        method: "POST",
        body,
      });
      console.log(JSON.stringify(expectJson(res, "description write")));
      return;
    }
    case "vote": {
      const descriptionUri = positional[1];
      const dir = positional[2];
      if (!descriptionUri || (dir !== "up" && dir !== "down")) {
        throw new Error("vote <description-uri> up|down required");
      }
      const res = await authedFetch(session, "/api/smellgate/vote", {
        method: "POST",
        body: { descriptionUri, direction: dir },
      });
      console.log(JSON.stringify(expectJson(res, "vote")));
      return;
    }
    case "comment": {
      const reviewUri = positional[1];
      if (!reviewUri) throw new Error("comment <review-uri> required");
      const res = await authedFetch(session, "/api/smellgate/comment", {
        method: "POST",
        body: { reviewUri, body: str(flags, "body", true) },
      });
      console.log(JSON.stringify(expectJson(res, "comment")));
      return;
    }
    case "submissions": {
      const sub = positional[1];
      if (sub !== "list") {
        throw new Error(`unknown submissions subcommand: ${sub}`);
      }
      const res = await authedFetch(session, "/api/smellgate/me/submissions");
      console.log(JSON.stringify(expectJson(res, "submissions list")));
      return;
    }
    case "submit": {
      const json = positional[1];
      if (!json) throw new Error("submit '<json perfume data>' required");
      let body: unknown;
      try {
        body = JSON.parse(json);
      } catch {
        throw new Error(`submit: invalid JSON: ${json}`);
      }
      const res = await authedFetch(session, "/api/smellgate/submission", {
        method: "POST",
        body,
      });
      console.log(JSON.stringify(expectJson(res, "submit")));
      return;
    }
    case "curator": {
      const sub = positional[1];
      if (sub === "pending") {
        const res = await authedFetch(
          session,
          "/api/smellgate/curator/submissions",
        );
        console.log(JSON.stringify(expectJson(res, "curator pending")));
        return;
      }
      if (sub === "approve") {
        const submissionUri = positional[2];
        if (!submissionUri)
          throw new Error("curator approve <submission-uri> required");
        const res = await authedFetch(
          session,
          "/api/smellgate/curator/approve",
          { method: "POST", body: { submissionUri } },
        );
        console.log(JSON.stringify(expectJson(res, "curator approve")));
        return;
      }
      if (sub === "reject") {
        const submissionUri = positional[2];
        if (!submissionUri)
          throw new Error("curator reject <submission-uri> required");
        const note = str(flags, "note");
        const res = await authedFetch(
          session,
          "/api/smellgate/curator/reject",
          { method: "POST", body: { submissionUri, note } },
        );
        console.log(JSON.stringify(expectJson(res, "curator reject")));
        return;
      }
      if (sub === "duplicate") {
        const submissionUri = positional[2];
        if (!submissionUri)
          throw new Error("curator duplicate <submission-uri> required");
        const canonicalPerfumeUri = str(flags, "canonical", true)!;
        const res = await authedFetch(
          session,
          "/api/smellgate/curator/duplicate",
          {
            method: "POST",
            body: { submissionUri, canonicalPerfumeUri },
          },
        );
        console.log(JSON.stringify(expectJson(res, "curator duplicate")));
        return;
      }
      throw new Error(`unknown curator subcommand: ${sub}`);
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    "usage: pnpm agent:as <handle> <action> [args...]\n" +
      "actions: whoami | home | perfume <uri> | shelf add|list | review write |\n" +
      "         description write | vote | comment | submit | submissions list |\n" +
      "         curator pending|approve|reject|duplicate",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 2) usage();
  const handle = argv[0];
  const rest = argv.slice(1);
  const session = await ensureSession(handle);
  await runAction(session, rest);
}

// Only run when invoked directly (e.g. `pnpm agent:as ...`). Tests
// import this module for `__parsers` and must NOT trigger the OAuth
// flow.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(
      "[agent] error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
