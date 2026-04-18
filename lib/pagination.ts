/**
 * Pure pagination helpers for `?page=N` query-string pagination
 * (issue #122: the `/perfumes` browse-all page).
 *
 * Kept in its own module so the bounds logic can be unit-tested
 * without spinning up a database. The `/perfumes` route composes this
 * with `getRecentPerfumes({ limit, offset })` + `countPerfumes()` from
 * `lib/db/smellgate-queries.ts`.
 */

export interface PageParams {
  /** 1-based page number. Clamped to `[1, totalPages]`. */
  page: number;
  /** 0-based SQL offset for this page. */
  offset: number;
  /** `LIMIT` clause value (always `pageSize`). */
  limit: number;
  /** Total number of pages for the current `total` + `pageSize`. Always >= 1. */
  totalPages: number;
}

/**
 * Parse a user-supplied page value (query string, may be a string,
 * array, or missing) into a 1-based integer. Returns 1 for anything
 * that can't be parsed to a positive integer. Array values pick the
 * first entry — mirrors how `searchParams` behaves when the same key
 * appears multiple times.
 */
export function parsePageParam(
  raw: string | string[] | undefined,
): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === null) return 1;
  // Use parseInt rather than Number() so trailing garbage ("2abc")
  // parses to 2 rather than NaN. This matches how most query-string
  // pagination in the wild behaves; "?page=2&foo" type noise stays
  // working even if a link-copying user mangles the URL.
  const n = Number.parseInt(String(first), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * Compute the clamped page number, SQL offset, and total page count
 * for a paginated collection. The requested page is clamped to
 * `[1, max(1, ceil(total / pageSize))]` — if the user asks for
 * `?page=9999` against a 30-row cache we render the last real page
 * instead of an empty grid.
 *
 * An empty collection (`total === 0`) returns `totalPages === 1` and
 * `offset === 0` so the caller can render an empty-state card rather
 * than 404ing.
 */
export function resolvePage(
  requestedPage: number,
  total: number,
  pageSize: number,
): PageParams {
  if (pageSize <= 0) {
    throw new Error(`pageSize must be positive, got ${pageSize}`);
  }
  const safeTotal = Math.max(0, Math.floor(total));
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(requestedPage)), totalPages);
  return {
    page: clamped,
    offset: (clamped - 1) * pageSize,
    limit: pageSize,
    totalPages,
  };
}
