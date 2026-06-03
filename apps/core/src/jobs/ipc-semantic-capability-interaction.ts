import { toTrimmedString } from './ipc-shared.js';

export interface SemanticCapabilityReview {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export function semanticCapabilityInteraction(
  review: SemanticCapabilityReview,
  requestId: string,
) {
  if (review.toolName !== 'request_permission') return undefined;
  const capabilityId = toTrimmedString(review.toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  const toolNames = sanitizedStringList([
    review.toolInput.toolName,
    ...(Array.isArray(review.toolInput.toolNames)
      ? review.toolInput.toolNames
      : []),
  ]);
  if (toolNames.length > 0) return undefined;
  const displayName =
    toTrimmedString(review.toolInput.capabilityDisplayName, { maxLen: 200 }) ||
    capabilityId;
  return {
    id: requestId,
    title: `Allow ${displayName}?`,
    details: semanticCapabilityInteractionDetails(review.toolInput),
    requestContext: {
      requestId,
      capabilityId,
      capabilityDisplayName: displayName,
      toolName: review.toolName,
      capabilityType: String(review.toolInput.credentialSource || 'semantic'),
    },
  };
}

function semanticCapabilityInteractionDetails(
  toolInput: Record<string, unknown>,
) {
  // Note: `capabilityId` is intentionally omitted (internal dotted id, redundant
  // with the title display name), and `accountLabel` is omitted here because the
  // prompt renderer already shows the Account line from toolInput.accountLabel —
  // listing it again here duplicated it.
  return [
    detailFromToolInput(toolInput, 'Risk', 'risk', 80),
    detailFromToolInput(toolInput, 'Allows', 'can', 1000),
    detailFromToolInput(toolInput, 'Does not allow', 'cannot', 1000),
    networkHostsDetail(toolInput.networkHosts),
  ].filter((detail): detail is { label: string; value: string } =>
    Boolean(detail),
  );
}

function networkHostsDetail(
  value: unknown,
): { label: string; value: string } | undefined {
  if (!Array.isArray(value)) return undefined;
  const hosts = [
    ...new Set(
      value
        .map((host) => toTrimmedString(host, { maxLen: 120 }))
        .filter((host): host is string => Boolean(host)),
    ),
  ];
  if (hosts.length === 0) return undefined;
  return { label: 'Network', value: hosts.join(', ') };
}

function detailFromToolInput(
  toolInput: Record<string, unknown>,
  label: string,
  key: string,
  maxLen: number,
): { label: string; value: string } | undefined {
  const value = toTrimmedString(toolInput[key], { maxLen });
  return value ? { label, value } : undefined;
}

function sanitizedStringList(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .slice(0, 50)
        .map((item) => toTrimmedString(item, { maxLen: 512 }))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}
