export const DIRECTORY_LIMITS = {
  lsDefaultEntries: 500,
  lsMaxEntries: 5_000,
  findDefaultResults: 1_000,
  findMaxResults: 10_000,
  maxNodes: 5_000,
  maxBytes: 50 * 1024,
  maxDepth: 20,
} as const;

export const GREP_LIMITS = {
  defaultMatches: 100,
  maxMatches: 10_000,
  maxContextLines: 20,
  maxBytes: 50 * 1024,
  maxLineChars: 500,
} as const;

export const READ_FILE_LIMITS = {
  defaultLines: 2_000,
  maxLines: 2_000,
  maxBytes: 50 * 1024,
} as const;
