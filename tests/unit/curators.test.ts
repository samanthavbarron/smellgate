import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These tests exercise `lib/curators.ts` in two ways:
 *
 * 1. The pure `parseCuratorDids` helper (exported under `__test__`) — this is
 *    where the real logic lives, so most edge-case coverage lives here. No
 *    env manipulation needed.
 *
 * 2. The module-level behaviour (`isCurator`, `getCuratorDids`) which reads
 *    `SMELLGATE_CURATOR_DIDS` once at module load. For those tests we use
 *    Vitest's built-in `vi.stubEnv` (which transparently edits `process.env`
 *    and auto-restores on `vi.unstubAllEnvs`) combined with `vi.resetModules`
 *    + dynamic `import()` so the module re-runs its top-level env read. No
 *    module mocks — `lib/curators.ts` is imported for real.
 */

const ENV = "SMELLGATE_CURATOR_DIDS";

// Dynamic import so each test sees a fresh module-load of lib/curators.ts
// with whatever env state the test has set.
async function loadCurators() {
  vi.resetModules();
  return await import("../../lib/curators");
}

describe("parseCuratorDids (pure)", () => {
  let parse: (raw: string | undefined) => string[];

  beforeEach(async () => {
    // Use a known-good env so module load succeeds, then grab the helper.
    vi.stubEnv(ENV, "");
    const mod = await loadCurators();
    parse = mod.__test__.parseCuratorDids;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns [] for undefined", () => {
    expect(parse(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parse("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(parse("   ")).toEqual([]);
  });

  it("parses a single DID", () => {
    expect(parse("did:plc:abc123")).toEqual(["did:plc:abc123"]);
  });

  it("parses multiple comma-separated DIDs", () => {
    expect(parse("did:plc:aaa,did:plc:bbb,did:web:example.com")).toEqual([
      "did:plc:aaa",
      "did:plc:bbb",
      "did:web:example.com",
    ]);
  });

  it("tolerates whitespace around commas", () => {
    expect(parse("  did:plc:aaa ,  did:plc:bbb  ")).toEqual([
      "did:plc:aaa",
      "did:plc:bbb",
    ]);
  });

  it("throws on an empty entry (stray comma)", () => {
    expect(() => parse("did:plc:aaa,,did:plc:bbb")).toThrow(/empty entry/);
    expect(() => parse(",did:plc:aaa")).toThrow(/empty entry/);
    expect(() => parse("did:plc:aaa,")).toThrow(/empty entry/);
  });

  it("throws on an entry without did: prefix", () => {
    expect(() => parse("plc:abc")).toThrow(/did:/);
    expect(() => parse("did:plc:aaa,notadid")).toThrow(/did:/);
  });

  it("throws on entries with inner whitespace", () => {
    // After the outer trim, inner whitespace is still disallowed.
    expect(() => parse("did:plc:a b")).toThrow(/whitespace/);
    expect(() => parse("did:plc:\tabc")).toThrow(/whitespace/);
  });

  it("throws on malformed DIDs (missing method or id)", () => {
    expect(() => parse("did:")).toThrow(/well-formed DID/);
    expect(() => parse("did:plc")).toThrow(/well-formed DID/);
    expect(() => parse("did:plc:")).toThrow(/well-formed DID/);
    expect(() => parse("did::abc")).toThrow(/well-formed DID/);
  });

  it("rejects plausible non-DID strings", () => {
    expect(() => parse("alice@example.com")).toThrow();
    expect(() => parse("https://example.com")).toThrow();
    expect(() => parse("@handle.bsky.social")).toThrow();
  });
});

describe("isCurator / getCuratorDids (module load)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unset env → empty list, nobody is a curator", async () => {
    vi.stubEnv(ENV, "");
    const { isCurator, getCuratorDids } = await loadCurators();
    expect(getCuratorDids()).toEqual([]);
    expect(isCurator("did:plc:anyone")).toBe(false);
    expect(isCurator("")).toBe(false);
  });

  it("single DID configured → only that DID is a curator", async () => {
    vi.stubEnv(ENV, "did:plc:curator1");
    const { isCurator, getCuratorDids } = await loadCurators();
    expect(getCuratorDids()).toEqual(["did:plc:curator1"]);
    expect(isCurator("did:plc:curator1")).toBe(true);
    expect(isCurator("did:plc:curator2")).toBe(false);
    expect(isCurator("did:plc:CURATOR1")).toBe(false); // case-sensitive
  });

  it("multiple DIDs (with surrounding whitespace) all count as curators", async () => {
    vi.stubEnv(ENV, " did:plc:aaa , did:plc:bbb ,did:web:example.com ");
    const { isCurator, getCuratorDids } = await loadCurators();
    expect(getCuratorDids()).toEqual([
      "did:plc:aaa",
      "did:plc:bbb",
      "did:web:example.com",
    ]);
    expect(isCurator("did:plc:aaa")).toBe(true);
    expect(isCurator("did:plc:bbb")).toBe(true);
    expect(isCurator("did:web:example.com")).toBe(true);
    expect(isCurator("did:plc:ccc")).toBe(false);
  });

  it("invalid config throws at module load (missing did: prefix)", async () => {
    vi.stubEnv(ENV, "did:plc:ok,not-a-did");
    await expect(loadCurators()).rejects.toThrow(/SMELLGATE_CURATOR_DIDS/);
  });

  it("invalid config throws at module load (inner whitespace)", async () => {
    vi.stubEnv(ENV, "did:plc:has space");
    await expect(loadCurators()).rejects.toThrow(/whitespace/);
  });

  it("invalid config throws at module load (empty entry from stray comma)", async () => {
    vi.stubEnv(ENV, "did:plc:aaa,,did:plc:bbb");
    await expect(loadCurators()).rejects.toThrow(/empty entry/);
  });

  it("getCuratorDids returns a fresh copy callers cannot mutate", async () => {
    vi.stubEnv(ENV, "did:plc:aaa");
    const { getCuratorDids, isCurator } = await loadCurators();
    const list = getCuratorDids();
    list.push("did:plc:injected");
    expect(isCurator("did:plc:injected")).toBe(false);
    expect(getCuratorDids()).toEqual(["did:plc:aaa"]);
  });
});
