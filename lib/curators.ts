/**
 * Curator-DID identity check.
 *
 * Per docs/lexicons.md, `com.smellgate.perfume` and
 * `com.smellgate.perfumeSubmissionResolution` are curator-only record types:
 * only a configured curator account is allowed to author them. The read layer
 * (Phase 2) will use `isCurator()` to refuse to index such records from
 * non-curator DIDs.
 *
 * The curator DID list is read from `SMELLGATE_CURATOR_DIDS` at module load
 * time, as a comma-separated list. Empty or unset means "no curators"
 * (safe default — nobody can publish curator-only records).
 *
 * Misconfiguration is loud: any entry that doesn't look like a DID throws at
 * module load. We'd rather crash at startup than silently let a non-curator
 * through.
 */

const ENV_VAR = "SMELLGATE_CURATOR_DIDS";

function parseCuratorDids(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  const parts = trimmed.split(",").map((p) => p.trim());
  const dids: string[] = [];
  for (const part of parts) {
    if (part === "") {
      throw new Error(
        `${ENV_VAR}: empty entry in comma-separated list (check for stray commas)`,
      );
    }
    if (/\s/.test(part)) {
      throw new Error(
        `${ENV_VAR}: entry contains whitespace: ${JSON.stringify(part)}`,
      );
    }
    if (!part.startsWith("did:")) {
      throw new Error(
        `${ENV_VAR}: entry does not look like a DID (missing "did:" prefix): ${JSON.stringify(part)}`,
      );
    }
    // A DID must have at least one character after `did:<method>:`.
    // Enforce the shape `did:<method>:<id>` where method and id are non-empty.
    const rest = part.slice("did:".length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx <= 0 || colonIdx === rest.length - 1) {
      throw new Error(
        `${ENV_VAR}: entry is not a well-formed DID: ${JSON.stringify(part)}`,
      );
    }
    dids.push(part);
  }
  return dids;
}

const CURATOR_DIDS: readonly string[] = Object.freeze(
  parseCuratorDids(process.env[ENV_VAR]),
);

/**
 * Returns the configured curator DIDs, frozen. Intended for tests and for
 * the read layer that may need to log / inspect the list.
 */
export function getCuratorDids(): string[] {
  return [...CURATOR_DIDS];
}

/**
 * Returns true iff `did` is in the configured curator list. Exact string
 * match — callers are expected to pass the author DID of a record as-is.
 */
export function isCurator(did: string): boolean {
  return CURATOR_DIDS.includes(did);
}

// Exported for tests only. Not part of the stable API.
export const __test__ = {
  parseCuratorDids,
  ENV_VAR,
};
