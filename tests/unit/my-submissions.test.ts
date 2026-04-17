/**
 * Unit tests for the pure helpers in `lib/server/smellgate-actions.ts`
 * that don't need a PDS or a SQLite database — specifically the
 * `groupSubmissionsByState` grouping used by both the
 * `/profile/me/submissions` page and the `/api/smellgate/me/submissions`
 * JSON endpoint. Issue #131.
 *
 * Integration coverage for the full `listMySubmissionsAction` against
 * a real PDS + cache lives in
 * `tests/integration/server-actions.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  groupSubmissionsByState,
  type MySubmissionItem,
} from "@/lib/server/smellgate-actions";

function makeItem(
  overrides: Partial<MySubmissionItem> & Pick<MySubmissionItem, "state">,
): MySubmissionItem {
  const base: MySubmissionItem = {
    uri: `at://did:plc:test/com.smellgate.perfumeSubmission/${Math.random()
      .toString(36)
      .slice(2, 10)}`,
    state: overrides.state,
    name: "Test",
    house: "House",
    notes: ["note"],
    createdAt: "2026-04-01T00:00:00Z",
  };
  return { ...base, ...overrides };
}

describe("groupSubmissionsByState", () => {
  it("returns empty buckets for every state when input is empty", () => {
    const out = groupSubmissionsByState([]);
    expect(out).toEqual({
      pending: [],
      approved: [],
      rejected: [],
      duplicate: [],
    });
  });

  it("partitions items into their declared state", () => {
    const items: MySubmissionItem[] = [
      makeItem({ state: "pending", name: "a" }),
      makeItem({ state: "approved", name: "b" }),
      makeItem({ state: "rejected", name: "c" }),
      makeItem({ state: "duplicate", name: "d" }),
      makeItem({ state: "pending", name: "e" }),
    ];
    const out = groupSubmissionsByState(items);
    expect(out.pending.map((i) => i.name)).toEqual(["a", "e"]);
    expect(out.approved.map((i) => i.name)).toEqual(["b"]);
    expect(out.rejected.map((i) => i.name)).toEqual(["c"]);
    expect(out.duplicate.map((i) => i.name)).toEqual(["d"]);
  });

  it("preserves input order within each state bucket", () => {
    const items: MySubmissionItem[] = [
      makeItem({ state: "pending", name: "first" }),
      makeItem({ state: "pending", name: "second" }),
      makeItem({ state: "pending", name: "third" }),
    ];
    const out = groupSubmissionsByState(items);
    expect(out.pending.map((i) => i.name)).toEqual(["first", "second", "third"]);
  });
});
