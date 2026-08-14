export interface NamedTaskRoot {
  id?: string;
  name: string;
}

export interface TaskRootIdentity {
  fileId?: string;
  name: string;
}

/**
 * Build a provider-independent filename fingerprint. Cloud providers and host
 * filesystems may replace, remove, normalize or widen any punctuation—not just
 * the set forbidden by Windows—so identity is based on Unicode letters and
 * numbers. A fingerprint is only accepted when it identifies one candidate.
 */
function createTaskRootNameFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Match by stable CloudDrive ID first, then progressively safer name forms. */
export function findMatchingTaskRoot<T extends NamedTaskRoot>(
  entries: T[],
  task: string | TaskRootIdentity,
): T | undefined {
  const identity = typeof task === "string" ? { name: task } : task;
  if (identity.fileId) {
    const idMatches = entries.filter((entry) => entry.id === identity.fileId);
    if (idMatches.length === 1) return idMatches[0];
  }

  const exact = entries.find((entry) => entry.name === identity.name);
  if (exact) return exact;
  const caseInsensitive = entries.filter(
    (entry) => entry.name.localeCompare(identity.name, undefined, { sensitivity: "base" }) === 0,
  );
  if (caseInsensitive.length === 1) return caseInsensitive[0];
  const fingerprint = createTaskRootNameFingerprint(identity.name);
  if (!fingerprint) return undefined;
  const compatible = entries.filter((entry) => createTaskRootNameFingerprint(entry.name) === fingerprint);
  return compatible.length === 1 ? compatible[0] : undefined;
}
