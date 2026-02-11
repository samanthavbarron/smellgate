



# Building Statusphere: Custom Records with AT Protocol

Build a status-setting app using custom Lexicons and real-time sync.

**What you'll build:** Users pick an emoji status and see a live feed of everyone's statuses.

**Prerequisites:** Complete the [next-oauth tutorial](../next-oauth/TUTORIAL.md) first. This tutorial builds on that foundation.

---

## Part 1: Setup

### 1.1 Clone or Copy

Start from a completed next-oauth app, or copy the files over to a new project.

### 1.2 Install Additional Dependencies

```bash
pnpm add @atproto/common-web @atproto/lex @atproto/syntax @atproto/tap
```

**What these do:**
- `@atproto/common-web` - Basic AT Protocol utilities including DID document parsing
- `@atproto/lex` - Lexicon (schema) generation and validation
- `@atproto/syntax` - AT Protocol URI parsing
- `@atproto/tap` - Client library for TAP real-time sync

### 1.3 Install the Lexicon CLI Tool

```bash
npm install -g @atproto/lex
```

The Lexicon CLI tool can be run using the `lex` command, however this command might conflict with other binaries installed on your system. If that happens, you can also run the CLI using `ts-lex`.

---

## Part 2: Lexicons (Data Schema)

Lexicons define the schema for records in AT Protocol.

### 2.1 Install the Statusphere lexicon

```bash
ts-lex install xyz.statusphere.status
```

Note the downloaded lexicon file at `lib/lexicons/xyz.statusphere.status.json`.

### 2.2 Generate TypeScript Code

Add to `package.json` scripts for building the lexicon definitions into Typescript code:

```json
{
  "scripts": {
    "build:lex": "ts-lex build --importExt=\"\" --out=./lib/lexicons --override",
    "build": "pnpm build:lex && next build"
  }
}
```

Run:

```bash
pnpm build:lex
```

This generates TypeScript in `lib/lexicons/` with validators and types.

The recommendation is to check the Lexicon schema files into git but not generated code into git.

### 2.3 Update OAuth Scope

We're going to be working with records in the `xyz.statusphere.status` collection for our users, so let's update the `SCOPE` constant in `lib/auth/client.ts` to request access to this collection:

```typescript
export const SCOPE = "atproto repo:xyz.statusphere.status";
```

---

## Part 3: Database Schema

Add tables for statusphere-specific data.

### 3.1 Update Database Schema

Update `lib/db/index.ts` to add the new tables:

```typescript
export interface DatabaseSchema {
  auth_state: AuthStateTable;
  auth_session: AuthSessionTable;
  account: AccountTable;   // New
  status: StatusTable;     // New
}

// ... existing auth tables ...

export interface AccountTable {
  did: string;
  handle: string;
  active: 0 | 1;
}

export interface StatusTable {
  uri: string;
  authorDid: string;
  status: string;
  createdAt: string;
  indexedAt: string;
  current: 0 | 1;
}
```

### 3.2 Add Migration

We're going to need tables to store information about our users and their statuses.

If you're building on top of the OAuth tutorial and have already deployed/migrated your database, you'll want to put these in a new migration called "002".

```typescript
const migrations: Record<string, Migration> = {
  "001": {
    async up(db: Kysely<unknown>) {
      // ... existing auth tables ...

      await db.schema
        .createTable("account")
        .addColumn("did", "text", (col) => col.primaryKey())
        .addColumn("handle", "text", (col) => col.notNull())
        .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
        .execute();

      await db.schema
        .createTable("status")
        .addColumn("uri", "text", (col) => col.primaryKey())
        .addColumn("authorDid", "text", (col) => col.notNull())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("indexedAt", "text", (col) => col.notNull())
        .addColumn("current", "integer", (col) => col.notNull().defaultTo(0))
        .execute();

      await db.schema
        .createIndex("status_current_idx")
        .on("status")
        .columns(["current", "indexedAt"])
        .execute();
    },
    async down(db: Kysely<unknown>) {
      await db.schema.dropTable("status").execute();
      await db.schema.dropTable("account").execute();
      await db.schema.dropTable("auth_session").execute();
      await db.schema.dropTable("auth_state").execute();
    },
  },
};
```

### 3.3 Run Migrations

```bash
pnpm migrate
```

---

## Part 4: Status Submission

Now let's build the feature that lets users set their status. The record will be written to the user's PDS (Personal Data Server).

### 4.1 Status API Route

Create `app/api/status/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { Client } from "@atproto/lex";
import { getOAuthClient, getSession } from "@/lib/auth";
import * as xyz from "@/lib/lexicons/xyz";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { status } = await request.json();

  if (!status || typeof status !== "string") {
    return NextResponse.json({ error: "Status is required" }, { status: 400 });
  }

  const client = await getOAuthClient();
  const oauthSession = await client.restore(session.did);
  const lexClient = new Client(oauthSession);

  const createdAt = new Date().toISOString();
  const res = await lexClient.create(xyz.statusphere.status, {
    status,
    createdAt,
  });

  return NextResponse.json({
    success: true,
    uri: res.uri,
  });
}
```

**What's happening:**
- Verify user is logged in
- Create a lex `Client` with their OAuth session
- Use generated lexicon to create a record on their PDS
- The record now exists in the user's repository

### 4.2 Status Picker Component

Create `components/StatusPicker.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const EMOJIS = ["👍", "👎", "💙", "🔥", "😆", "😢", "🤔", "😴", "🎉", "🤩", "😭", "🥳", "😤", "💀", "✨", "👀", "🙏", "📚", "💻", "🍕", "🌴"];

interface StatusPickerProps {
  currentStatus?: string | null;
}

export function StatusPicker({ currentStatus }: StatusPickerProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(currentStatus ?? null);
  const [loading, setLoading] = useState(false);

  async function handleSelect(emoji: string) {
    setLoading(true);
    setSelected(emoji);

    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: emoji }),
      });

      if (!res.ok) {
        throw new Error("Failed to update status");
      }

      router.refresh();
    } catch (err) {
      console.error("Failed to update status:", err);
      setSelected(currentStatus ?? null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
        Set your status
      </p>
      <div className="flex flex-wrap gap-2">
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            onClick={() => handleSelect(emoji)}
            disabled={loading}
            className={`text-2xl p-2 rounded-lg transition-all
              ${selected === emoji
                ? "bg-blue-100 dark:bg-blue-900 ring-2 ring-blue-500"
                : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }
              disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
```

### 4.3 Update Home Page with Picker

Update `app/page.tsx` to add the status picker:

```typescript
import { getSession } from "@/lib/auth";
import { LoginForm } from "@/components/LoginForm";
import { LogoutButton } from "@/components/LogoutButton";
import { StatusPicker } from "@/components/StatusPicker";

export default async function Home() {
  const session = await getSession();

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <main className="w-full max-w-md mx-auto p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            Statusphere
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Set your status on the Atmosphere
          </p>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6">
          {session ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Signed in
                </p>
                <LogoutButton />
              </div>
              <StatusPicker />
            </div>
          ) : (
            <LoginForm />
          )}
        </div>
      </main>
    </div>
  );
}
```

### Checkpoint: Test Status Submission

```bash
pnpm dev
```

1. Log in at http://127.0.0.1:3000
2. Click an emoji to set your status
3. The status record is published on your PDS, check https://pdsls.dev and look up your account to see the record stored in your repo

At this point, the status is written to the network but we can't see it in the app yet. We need to receive updates from Tap to populate our local database.

---

## Part 5: Real-time Sync with TAP

TAP (Taxon Appliance Protocol) provides real-time updates when users create, update, or delete records. We'll use it to sync status records into our local database.

### 5.1 TAP Client

Create `lib/tap/index.ts`:

```typescript
import { Tap } from "@atproto/tap";

const TAP_URL = process.env.TAP_URL || "http://localhost:2480";

let _tap: Tap | null = null;

export const getTap = (): Tap => {
  if (!_tap) {
    _tap = new Tap(TAP_URL);
  }
  return _tap;
};
```

### 5.2 Add Database Queries

Create `lib/db/queries.ts` with the queries we need for handling TAP events:

```typescript
import { getDb, AccountTable, StatusTable, DatabaseSchema } from ".";
import { AtUri } from "@atproto/syntax";
import { Transaction } from "kysely";

export async function getAccountStatus(did: string) {
  const db = getDb();
  const status = await db
    .selectFrom("status")
    .selectAll()
    .where("authorDid", "=", did)
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst();
  return status ?? null;
}

export async function insertStatus(data: StatusTable) {
  getDb()
    .transaction()
    .execute(async (tx) => {
      await tx
        .insertInto("status")
        .values(data)
        .onConflict((oc) =>
          oc.column("uri").doUpdateSet({
            status: data.status,
            createdAt: data.createdAt,
            indexedAt: data.indexedAt,
          }),
        )
        .execute();
      setCurrStatus(tx, data.authorDid);
    });
}

export async function deleteStatus(uri: AtUri) {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await tx.deleteFrom("status").where("uri", "=", uri.toString()).execute();
      await setCurrStatus(tx, uri.hostname);
    });
}

export async function upsertAccount(data: AccountTable) {
  await getDb()
    .insertInto("account")
    .values(data)
    .onConflict((oc) =>
      oc.column("did").doUpdateSet({
        handle: data.handle,
        active: data.active,
      }),
    )
    .execute();
}

export async function deleteAccount(did: string) {
  await getDb().deleteFrom("account").where("did", "=", did).execute();
  await getDb().deleteFrom("status").where("authorDid", "=", did).execute();
}

// Helper to update which status is "current" for a user (inside a transaction)
async function setCurrStatus(tx: Transaction<DatabaseSchema>, did: string) {
  // Clear current flag for all user's statuses
  await tx
    .updateTable("status")
    .set({ current: 0 })
    .where("authorDid", "=", did)
    .where("current", "=", 1)
    .execute();
  // Set the most recent status as current
  await tx
    .updateTable("status")
    .set({ current: 1 })
    .where("uri", "=", (qb) =>
      qb
        .selectFrom("status")
        .select("uri")
        .where("authorDid", "=", did)
        .orderBy("createdAt", "desc")
        .limit(1),
    )
    .execute();
}
```

The `setCurrStatus` helper ensures only the most recent status per user has `current = 1`. This is used by `getRecentStatuses` and `getTopStatuses` later to show only each user's latest status.

### 5.3 Webhook Handler

Tap will deliver all relevant events through a webhook.

Create `app/api/webhook/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { parseTapEvent, assureAdminAuth } from "@atproto/tap";
import { AtUri } from "@atproto/syntax";
import {
  upsertAccount,
  insertStatus,
  deleteStatus,
  deleteAccount,
} from "@/lib/db/queries";
import * as xyz from "@/lib/lexicons/xyz";

const TAP_ADMIN_PASSWORD = process.env.TAP_ADMIN_PASSWORD;

export async function POST(request: NextRequest) {
  // Verify request is from our TAP server
  if (TAP_ADMIN_PASSWORD) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      assureAdminAuth(TAP_ADMIN_PASSWORD, authHeader);
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await request.json();
  const evt = parseTapEvent(body);

  // Handle account/identity changes
  if (evt.type === "identity") {
    if (evt.status === "deleted") {
      await deleteAccount(evt.did);
    } else {
      await upsertAccount({
        did: evt.did,
        handle: evt.handle,
        active: evt.isActive ? 1 : 0,
      });
    }
  }

  // Handle status record changes
  if (evt.type === "record") {
    const uri = AtUri.make(evt.did, evt.collection, evt.rkey);

    if (evt.action === "create" || evt.action === "update") {
      let record: xyz.statusphere.status.Main;
      try {
        record = xyz.statusphere.status.$parse(evt.record);
      } catch {
        return NextResponse.json({ success: false });
      }

      await insertStatus({
        uri: uri.toString(),
        authorDid: evt.did,
        status: record.status,
        createdAt: record.createdAt,
        indexedAt: new Date().toISOString(),
        current: 1,
      });
    } else if (evt.action === "delete") {
      await deleteStatus(uri);
    }
  }

  return NextResponse.json({ success: true });
}
```

**What's happening:**
- Tap sends webhook events when records change anywhere on the network
- We validate the request using a shared secret
- For `identity` events, we update our account cache
- For `record` events, we insert/update/delete statuses in our local DB

### 5.4 Display Current Status

Update `app/page.tsx` to fetch and pass the user's current status to the picker:

```typescript
import { getAccountStatus } from "@/lib/db/queries";

// In Home component:
const accountStatus = session ? await getAccountStatus(session.did) : null;

// Pass to StatusPicker:
<StatusPicker currentStatus={accountStatus?.status} />
```

Now the StatusPicker will highlight the user's current status when the page loads.

### Checkpoint: Test the Data Flow

```bash
# Run Tap from indigo repo root
go run ./cmd/tap run --webhook-url=http://localhost:3000/api/webhook --collection-filters=xyz.statusphere.status

# Run your app in another terminal
pnpm dev

# Add your repo to Tap for tracking (replacing the DID with yours)
curl -H 'Content-Type: application/json' -d '{"dids":["DID"]}' http://localhost:2480/repos/add
```

Now test the full flow:

1. Set a status by clicking an emoji
2. TAP receives the record from the network and sends a webhook
3. The webhook saves it to your local database
4. Refresh the page - your status is highlighted in the picker!

This is the canonical AT Protocol data flow: records are written to the user's PDS, then synced to your app via TAP.

---

## Part 6: Display User Handle

Let's show the logged-in user's handle in the UI. We'll add a query to look up handles and update the home page.

### 6.1 Add Handle Query

Add these imports to the top of `lib/db/queries.ts`:

```typescript
import { getHandle } from "@atproto/common-web";
import { getTap } from "@/lib/tap";
```

Then add the query function:

```typescript
export async function getAccountHandle(did: string): Promise<string | null> {
  const db = getDb();
  // if we've tracked to the account through Tap and gotten their account info, we'll load from there
  const account = await db
    .selectFrom("account")
    .select("handle")
    .where("did", "=", did)
    .executeTakeFirst();
  if (account) return account.handle;
  // otherwise we'll resolve the accounts DID through Tap which provides identity caching
  try {
    const didDoc = await getTap().resolveDid(did);
    if (!didDoc) return null;
    return getHandle(didDoc) ?? null;
  } catch {
    return null;
  }
}
```

This first checks our local database cache, then falls back to resolving the DID document via TAP if needed.

### 6.2 Update Home Page with Handle

Update `app/page.tsx` to fetch and display the user's handle.

Add the import:

```typescript
import { getAccountStatus, getAccountHandle } from "@/lib/db/queries";
```

Fetch the handle alongside the account status:

```typescript
const [accountStatus, accountHandle] = await Promise.all([
  session ? getAccountStatus(session.did) : null,
  session ? getAccountHandle(session.did) : null,
]);
```

Update the "Signed in" text to show the handle:

```typescript
<p className="text-sm text-zinc-500 dark:text-zinc-400">
  Signed in as @{accountHandle ?? session.did}
</p>
```

Now logged-in users will see "Signed in as @theirhandle" instead of just "Signed in".

---

## Part 7: Display Status Feed

Tap will scrape statuses from across the network. Now let's display popular and recent statuses.

### 7.1 Add Feed Queries

Add these queries to `lib/db/queries.ts`:

```typescript
export async function getRecentStatuses(limit = 5) {
  const db = getDb();
  return db
    .selectFrom("status")
    .innerJoin("account", "status.authorDid", "account.did")
    .selectAll()
    .orderBy("createdAt", "desc")
    .limit(limit)
    .execute();
}

export async function getTopStatuses(limit = 10) {
  const db = getDb();
  return db
    .selectFrom("status")
    .select(["status", db.fn.count("uri").as("count")])
    .where("current", "=", 1)
    .groupBy("status")
    .orderBy("count", "desc")
    .limit(limit)
    .execute();
}
```

### 7.2 Update Home Page with Feed

Update `app/page.tsx` to display the full feed with top statuses, handles, and timestamps:

```typescript
import { getSession } from "@/lib/auth/session";
import {
  getAccountStatus,
  getRecentStatuses,
  getTopStatuses,
  getAccountHandle,
} from "@/lib/db/queries";
import { LoginForm } from "@/components/LoginForm";
import { LogoutButton } from "@/components/LogoutButton";
import { StatusPicker } from "@/components/StatusPicker";

export default async function Home() {
  const session = await getSession();
  const [statuses, topStatuses, accountStatus, accountHandle] =
    await Promise.all([
      getRecentStatuses(),
      getTopStatuses(),
      session ? getAccountStatus(session.did) : null,
      session ? getAccountHandle(session.did) : null,
    ]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <main className="w-full max-w-md mx-auto p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
            Statusphere
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Set your status on the Atmosphere
          </p>
        </div>

        {session ? (
          <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Signed in as @{accountHandle ?? session.did}
              </p>
              <LogoutButton />
            </div>
            <StatusPicker currentStatus={accountStatus?.status} />
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6 mb-6">
            <LoginForm />
          </div>
        )}

        {topStatuses.length > 0 && (
          <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6 mb-6">
            <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">
              Top Statuses
            </h3>
            <div className="flex flex-wrap gap-2">
              {topStatuses.map((s) => (
                <span
                  key={s.status}
                  className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-sm"
                >
                  <span className="text-lg">{s.status}</span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {String(s.count)}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6">
          <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-3">
            Recent
          </h3>
          {statuses.length === 0 ? (
            <p className="text-zinc-500 dark:text-zinc-400 text-sm">
              No statuses yet. Be the first!
            </p>
          ) : (
            <ul className="space-y-3">
              {statuses.map((s) => (
                <li key={s.uri} className="flex items-center gap-3">
                  <span className="text-2xl">{s.status}</span>
                  <span className="text-zinc-600 dark:text-zinc-400 text-sm">
                    @{s.handle}
                  </span>
                  <span className="text-zinc-400 dark:text-zinc-500 text-xs ml-auto">
                    {timeAgo(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function timeAgo(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
```

### Checkpoint: Full Network Indexing

So far we've only been tracking individual repos we manually add. To see statuses from across the entire network, run TAP with the `--signal-collection` flag:

```bash
go run ./cmd/tap run \
  --webhook-url=http://localhost:3000/api/webhook \
  --collection-filters=xyz.statusphere.status \
  --signal-collection=xyz.statusphere.status
```

This tells TAP to automatically discover and track any repo that has records in the `xyz.statusphere.status` collection. Now your feed will populate with statuses from everyone on the network who has set one! Load up the webpage and watch them stream in as Tap syncs the network.

---

## Part 8: Optimistic Writes (Enhancement)

You may notice there's a delay between setting a status and seeing it appear. That's because the status has to round-trip through the network: PDS → TAP → webhook → your DB.

For a snappier UX, we can write to our local database immediately after writing to the PDS. This is called an "optimistic write" - we optimistically assume TAP will deliver the same data shortly.

### 8.1 Update Status Route

Update `app/api/status/route.ts` to save locally after writing to the PDS.

Add the imports:

```typescript
import { insertStatus } from "@/lib/db/queries";
```

After the `lexClient.create()` call, add the optimistic writes:

```typescript
// Optimistic write: save locally for immediate display
await insertStatus({
  uri: res.uri,
  authorDid: session.did,
  status,
  createdAt,
  indexedAt: createdAt,
  current: 1,
});
```

Now when you set a status, it appears immediately - no waiting for the TAP round-trip.
