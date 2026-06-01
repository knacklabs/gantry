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
  return [
    detailFromToolInput(toolInput, 'Capability', 'capabilityId', 160),
    detailFromToolInput(toolInput, 'Risk', 'risk', 80),
    detailFromToolInput(toolInput, 'Account', 'accountLabel', 200),
    detailFromToolInput(toolInput, 'Allows', 'can', 1000),
    detailFromToolInput(toolInput, 'Does not allow', 'cannot', 1000),
  ].filter((detail): detail is { label: string; value: string } =>
    Boolean(detail),
  );
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
