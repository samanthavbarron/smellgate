/**
 * Unit tests for `lib/pagination.ts` — the bounds / parsing helpers
 * used by the `/perfumes` browse-all page (issue #122).
 *
 * Pure functions, no database, no Next runtime. The goal is to pin
 * down every edge case the route relies on: garbage `?page` input,
 * `?page=0`, out-of-range `?page=9999`, empty catalog, last-page
 * arithmetic.
 */

import { describe, expect, it } from "vitest";
import { parsePageParam, resolvePage } from "../../lib/pagination";

describe("parsePageParam", () => {
  it("returns 1 when the value is missing", () => {
    expect(parsePageParam(undefined)).toBe(1);
  });

  it("returns 1 for a non-numeric value", () => {
    expect(parsePageParam("abc")).toBe(1);
  });

  it("returns 1 for zero or negative values", () => {
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-4")).toBe(1);
  });

  it("parses a positive integer", () => {
    expect(parsePageParam("3")).toBe(3);
  });

  it("tolerates trailing garbage after the integer prefix", () => {
    expect(parsePageParam("2abc")).toBe(2);
  });

  it("uses the first entry when searchParams gives an array", () => {
    expect(parsePageParam(["4", "99"])).toBe(4);
  });

  it("returns 1 for an empty string", () => {
    expect(parsePageParam("")).toBe(1);
  });
});

describe("resolvePage", () => {
  const SIZE = 24;

  it("page 1 of a full single-page catalog", () => {
    const r = resolvePage(1, 10, SIZE);
    expect(r).toEqual({ page: 1, offset: 0, limit: SIZE, totalPages: 1 });
  });

  it("page 1 of a catalog exactly equal to pageSize", () => {
    const r = resolvePage(1, SIZE, SIZE);
    expect(r).toEqual({ page: 1, offset: 0, limit: SIZE, totalPages: 1 });
  });

  it("computes a second page when total > pageSize", () => {
    const r = resolvePage(2, 30, SIZE);
    expect(r).toEqual({ page: 2, offset: 24, limit: SIZE, totalPages: 2 });
  });

  it("clamps out-of-range requests to the last page", () => {
    // 75 rows / 24 per page = 4 pages (25% of a final page).
    const r = resolvePage(9999, 75, SIZE);
    expect(r.page).toBe(4);
    expect(r.totalPages).toBe(4);
    expect(r.offset).toBe(72);
  });

  it("clamps a zero page to 1", () => {
    const r = resolvePage(0, 30, SIZE);
    expect(r.page).toBe(1);
    expect(r.offset).toBe(0);
  });

  it("returns a single empty page when the catalog is empty", () => {
    const r = resolvePage(1, 0, SIZE);
    expect(r).toEqual({ page: 1, offset: 0, limit: SIZE, totalPages: 1 });
  });

  it("does not let an out-of-range request on an empty catalog escape the clamp", () => {
    const r = resolvePage(9, 0, SIZE);
    expect(r.page).toBe(1);
    expect(r.totalPages).toBe(1);
    expect(r.offset).toBe(0);
  });

  it("rounds up on a partial final page", () => {
    // 25 rows, 24 per page → pages 1 (24 rows) + 2 (1 row).
    const r = resolvePage(2, 25, SIZE);
    expect(r.totalPages).toBe(2);
    expect(r.page).toBe(2);
    expect(r.offset).toBe(24);
  });

  it("throws for a non-positive pageSize — caller bug", () => {
    expect(() => resolvePage(1, 10, 0)).toThrow();
    expect(() => resolvePage(1, 10, -5)).toThrow();
  });
});
