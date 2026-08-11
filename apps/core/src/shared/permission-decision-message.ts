interface PermissionDecisionMessageMetadata {
  decidedBy?: string;
  risk_level?: string;
  risk_category?: string;
}

export function formatPermissionDeniedMessage(
  decision: PermissionDecisionMessageMetadata,
  reason: string,
): string {
  const provenance: string[] = [];
  if (decision.decidedBy) {
    provenance.push(`decided by: ${decision.decidedBy}`);
  }
  if (decision.risk_level) {
    provenance.push(
      `risk: ${decision.risk_level}${
        decision.risk_category ? `/${decision.risk_category}` : ''
      }`,
    );
  }
  const provenanceSuffix = provenance.length
    ? ` (${provenance.join('; ')})`
    : '';
  return `Permission denied${provenanceSuffix}: ${permissionDenialReason(reason)}`;
}

function permissionDenialReason(reason: string): string {
  if (/did not match an approved pattern/i.test(reason)) {
    return 'The attempted command did not match an approved pattern.';
  }
  if (/not granted/i.test(reason)) {
    return 'Access for this tool was not granted.';
  }
  return reason;
}
