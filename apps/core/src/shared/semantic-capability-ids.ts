export const SEMANTIC_CAPABILITY_RULE_PREFIX = 'capability:';

const SEMANTIC_CAPABILITY_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function semanticCapabilityRule(capabilityId: string): string {
  return `${SEMANTIC_CAPABILITY_RULE_PREFIX}${capabilityId.trim()}`;
}

export function parseSemanticCapabilityRule(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SEMANTIC_CAPABILITY_RULE_PREFIX)) return undefined;
  const capabilityId = trimmed.slice(SEMANTIC_CAPABILITY_RULE_PREFIX.length);
  return isValidSemanticCapabilityId(capabilityId) ? capabilityId : undefined;
}

export function isSemanticCapabilityRule(value: string): boolean {
  return parseSemanticCapabilityRule(value) !== undefined;
}

export function isValidSemanticCapabilityId(value: string): boolean {
  return SEMANTIC_CAPABILITY_ID_RE.test(value.trim());
}

export function semanticCapabilityIdValidationReason(
  capabilityId: string,
): string | undefined {
  if (isValidSemanticCapabilityId(capabilityId)) return undefined;
  return 'Capability id must use lowercase dot-separated words such as google.sheets.write.';
}
