// Whether a provider session row still carries a handle that can resume it.
export function hasProviderResumeHandle(value: {
  externalSessionId?: unknown;
  providerRef?: { value?: unknown } | null;
  metadata?: unknown;
}): boolean {
  return (
    hasNonEmptyString(value.externalSessionId) ||
    hasNonEmptyString(value.providerRef?.value) ||
    metadataContainsResumeHandle(value.metadata, 0)
  );
}

function metadataContainsResumeHandle(value: unknown, depth: number): boolean {
  if (depth > 4 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      metadataContainsResumeHandle(entry, depth + 1),
    );
  }
  if (typeof value !== 'object') return false;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /(externalSessionId|providerSessionId|latestProviderSessionId|newSessionId|sessionId|session_id|resume|artifact)/i.test(
        key,
      ) &&
      hasNonEmptyString(entry)
    ) {
      return true;
    }
    if (metadataContainsResumeHandle(entry, depth + 1)) {
      return true;
    }
  }
  return false;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
