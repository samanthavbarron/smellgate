/**
 * Unit test for the `TAP_COLLECTION_FILTERS` wildcard in tap/fly.toml.
 *
 * Tap's filter syntax allows wildcards only at NSID period breaks
 * (`app.smellgate.*` matches `app.smellgate.perfume` but not
 * `app.smellgateextra.foo`). If a new record type is added under
 * `app.smellgate.*` in the future, the wildcard still covers it — no
 * filter update required. But if a record type is ever added OUTSIDE
 * that prefix (say `app.smellgatex.*` or a co-branded NSID), the
 * filter would silently drop it at the Tap layer and the dispatcher
 * in `lib/tap/smellgate.ts` would never see those events.
 *
 * This test is a tripwire: it walks every NSID the dispatcher
 * recognizes and asserts each matches the wildcard pattern embedded
 * in `tap/fly.toml`. If someone extends `SMELLGATE_COLLECTIONS` to a
 * new NSID outside `app.smellgate.*`, this test will fail loudly and
 * force an explicit decision about the filter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SMELLGATE_COLLECTION_LIST } from "../../lib/tap/smellgate";

// ---------------------------------------------------------------------------
// Minimal Tap-style wildcard matcher. Matches the Go binary's semantics
// as described in the indigo/cmd/tap README: wildcards at period
// breaks only. `a.b.*` matches `a.b.c` but NOT `a.bc` or `a.b.c.d`.
//
// We don't import a wildcard library because the rule is trivial and
// the Tap binary's actual matcher isn't exposed to JS. Implementing
// it inline here (and proving it behaves correctly against a set of
// positive + negative cases below) is simpler than mocking the Go
// binary.
// ---------------------------------------------------------------------------
function matchesTapFilter(nsid: string, filter: string): boolean {
  const nsidParts = nsid.split(".");
  const filterParts = filter.split(".");
  if (nsidParts.length !== filterParts.length) return false;
  for (let i = 0; i < filterParts.length; i += 1) {
    if (filterParts[i] === "*") continue;
    if (filterParts[i] !== nsidParts[i]) return false;
  }
  return true;
}

function extractFilterFromTomlLine(toml: string): string {
  // Simple parse: find the TAP_COLLECTION_FILTERS line and extract the
  // double-quoted value. Avoids pulling a TOML lib just for one field.
  const match = toml.match(/^\s*TAP_COLLECTION_FILTERS\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(
      "TAP_COLLECTION_FILTERS not found in tap/fly.toml — did the key get renamed?",
    );
  }
  return match[1];
}

describe("Tap collection filter (tap/fly.toml)", () => {
  const flyToml = fs.readFileSync(
    path.resolve(__dirname, "../../tap/fly.toml"),
    "utf-8",
  );
  const filterValue = extractFilterFromTomlLine(flyToml);

  it("matches every NSID the dispatcher recognizes", () => {
    // `app.smellgate.*` is the expected v1 filter. A future commit
    // could change it to a comma-separated list — this test still
    // works because we split on `,` below.
    const filters = filterValue.split(",").map((s) => s.trim());
    const unmatched = SMELLGATE_COLLECTION_LIST.filter(
      (nsid) => !filters.some((f) => matchesTapFilter(nsid, f)),
    );
    expect(unmatched).toEqual([]);
  });

  it("does NOT match unrelated NSIDs (sanity check on the matcher)", () => {
    const filters = filterValue.split(",").map((s) => s.trim());
    for (const nonMatch of [
      "app.bsky.feed.post",
      "app.smellgateextra.foo", // no period before `extra` — must not match
      "app.smellgate.perfume.comment", // too many segments
      "xyz.statusphere.status",
    ]) {
      const anyMatches = filters.some((f) => matchesTapFilter(nonMatch, f));
      expect(
        anyMatches,
        `Expected ${nonMatch} not to match any of ${JSON.stringify(filters)}`,
      ).toBe(false);
    }
  });

  it("matches exactly one of the filter patterns per known NSID (no double-counting)", () => {
    // Belt-and-braces: if someone adds overlapping filters like
    // `app.smellgate.*,app.smellgate.perfume` we want to know, because
    // Tap's behavior on overlaps isn't documented and we shouldn't
    // depend on it.
    const filters = filterValue.split(",").map((s) => s.trim());
    for (const nsid of SMELLGATE_COLLECTION_LIST) {
      const matchCount = filters.reduce(
        (acc, f) => acc + (matchesTapFilter(nsid, f) ? 1 : 0),
        0,
      );
      expect(matchCount, `NSID ${nsid} matched ${matchCount} filter patterns`).toBe(
        1,
      );
    }
  });
});
