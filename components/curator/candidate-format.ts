/**
 * Pure helpers for the curator duplicate-picker typeahead (issue #139).
 *
 * Split into its own module so the SubmissionCard component stays
 * focused on rendering + event wiring, and so the row-formatting logic
 * is unit-testable without `@testing-library/react` (PR #144 declined
 * adding it, so we keep testable logic out of the component).
 *
 * Shape: `CandidatePerfume` is a minimal structural slice over
 * `PerfumeWithNotes` — uri, name, house, creator, releaseYear. The
 * typeahead never needs notes / description / author, and trimming
 * the payload keeps the JSON wire format tight.
 */

export interface CandidatePerfume {
  uri: string;
  name: string;
  house: string;
  creator: string | null;
  releaseYear: number | null;
}

/**
 * Build the one-line label shown in the typeahead dropdown row.
 * Examples:
 *   formatCandidateRow({name: "Vespertine", house: "Oriza", creator: null, releaseYear: null})
 *     => "Vespertine — Oriza"
 *   formatCandidateRow({name: "Vespertine", house: "Oriza", creator: "Ellena", releaseYear: 2011})
 *     => "Vespertine — Oriza (Ellena, 2011)"
 *   formatCandidateRow({name: "X", house: "Y", creator: "Ellena", releaseYear: null})
 *     => "X — Y (Ellena)"
 *   formatCandidateRow({name: "X", house: "Y", creator: null, releaseYear: 2011})
 *     => "X — Y (2011)"
 */
export function formatCandidateRow(p: {
  name: string;
  house: string;
  creator: string | null;
  releaseYear: number | null;
}): string {
  const base = `${p.name} \u2014 ${p.house}`;
  const parenBits: string[] = [];
  if (p.creator && p.creator.length > 0) parenBits.push(p.creator);
  if (p.releaseYear !== null && p.releaseYear !== undefined) {
    parenBits.push(String(p.releaseYear));
  }
  if (parenBits.length === 0) return base;
  return `${base} (${parenBits.join(", ")})`;
}

/**
 * Compose the search query for a submission. Prefers the submission's
 * `name` (the primary identifier) and falls back to `house` if `name`
 * is empty. We deliberately do NOT concatenate name + house: the
 * underlying search is a `LIKE %q%` substring match, and `%name house%`
 * only matches rows where both words appear adjacently in the same
 * column — which is not how canonical perfume rows are shaped. Using
 * the name alone keeps the top-N dropdown's recall correct; the
 * curator then eyeballs the house in each row to pick the right one.
 *
 * Returns `null` when both fields are empty (or whitespace-only),
 * which tells the caller to skip the fetch entirely.
 *
 * The noisy-match case (name = "Rose") is a known limitation; the
 * dropdown is capped at 5 rows, ordered by `name ASC`, and each row
 * shows the house so the curator can visually disambiguate. A smarter
 * ranking is out of scope here.
 */
export function buildCandidateQuery(submission: {
  name: string;
  house: string;
}): string | null {
  const name = submission.name.trim();
  const house = submission.house.trim();
  if (name.length === 0 && house.length === 0) return null;
  if (name.length === 0) return house;
  return name;
}
