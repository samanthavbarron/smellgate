/**
 * Integration test for the `/api/*` JSON catch-all (#186).
 *
 * An unmatched `/api/*` path should return JSON 404, not fall through
 * to the HTML `not-found.tsx`. Any programmatic client (internal or
 * third-party) that mistypes an endpoint will choke if it gets HTML.
 */
import { describe, expect, it } from "vitest";

import * as route from "../../app/api/[...slug]/route";

describe("/api/* catch-all (#186)", () => {
  it("returns JSON {error:'Not Found'} with status 404 for GET", async () => {
    const res = await route.GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "Not Found" });
  });

  it("responds with JSON 404 for POST, PUT, PATCH, DELETE, HEAD, OPTIONS", async () => {
    for (const handler of [
      route.POST,
      route.PUT,
      route.PATCH,
      route.DELETE,
      route.HEAD,
      route.OPTIONS,
    ]) {
      const res = await handler();
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    }
  });
});
