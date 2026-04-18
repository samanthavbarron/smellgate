/**
 * Unit tests for the pure helpers that back the curator duplicate-picker
 * typeahead (issue #139). These are pure string / shape helpers — no
 * DOM, no React, no `@testing-library/react` (PR #144 declined adding
 * it). The component-level behavior is covered by the integration test
 * that hits the `/api/smellgate/curator/search` endpoint end-to-end.
 */

import { describe, expect, it } from "vitest";
import {
  buildCandidateQuery,
  formatCandidateRow,
} from "../../components/curator/candidate-format";

describe("formatCandidateRow", () => {
  it("formats name and house with an em-dash when no creator/year", () => {
    expect(
      formatCandidateRow({
        name: "Vespertine",
        house: "Oriza",
        creator: null,
        releaseYear: null,
      }),
    ).toBe("Vespertine \u2014 Oriza");
  });

  it("includes creator and year in parens when both are present", () => {
    expect(
      formatCandidateRow({
        name: "Terre d'Hermès",
        house: "Hermès",
        creator: "Jean-Claude Ellena",
        releaseYear: 2006,
      }),
    ).toBe("Terre d'Hermès \u2014 Hermès (Jean-Claude Ellena, 2006)");
  });

  it("includes only creator when year is null", () => {
    expect(
      formatCandidateRow({
        name: "X",
        house: "Y",
        creator: "Ellena",
        releaseYear: null,
      }),
    ).toBe("X \u2014 Y (Ellena)");
  });

  it("includes only year when creator is null", () => {
    expect(
      formatCandidateRow({
        name: "X",
        house: "Y",
        creator: null,
        releaseYear: 2011,
      }),
    ).toBe("X \u2014 Y (2011)");
  });

  it("treats an empty-string creator as absent", () => {
    expect(
      formatCandidateRow({
        name: "X",
        house: "Y",
        creator: "",
        releaseYear: 2011,
      }),
    ).toBe("X \u2014 Y (2011)");
  });
});

describe("buildCandidateQuery", () => {
  it("returns the trimmed name when name is non-empty", () => {
    expect(buildCandidateQuery({ name: "  Vespertine  ", house: "Oriza" })).toBe(
      "Vespertine",
    );
  });

  it("falls back to house when name is empty", () => {
    expect(buildCandidateQuery({ name: "   ", house: "Oriza" })).toBe("Oriza");
  });

  it("returns null when both name and house are empty/whitespace", () => {
    expect(buildCandidateQuery({ name: "", house: "" })).toBeNull();
    expect(buildCandidateQuery({ name: "  ", house: " \t " })).toBeNull();
  });

  it("does not concatenate name and house (substring LIKE wouldn't match)", () => {
    // Sentinel: this behavior is load-bearing — the underlying
    // `searchPerfumes` does `%q%` and `%Vespertine Oriza%` would never
    // match a row where name is "Vespertine" and house is "Oriza". We
    // deliberately return only the name.
    expect(
      buildCandidateQuery({ name: "Vespertine", house: "Oriza" }),
    ).not.toContain("Oriza");
  });
});
