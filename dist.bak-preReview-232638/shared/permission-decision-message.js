export function formatPermissionDeniedMessage(decision, reason) {
    const provenance = [];
    if (decision.decidedBy) {
        provenance.push(`decided by: ${decision.decidedBy}`);
    }
    if (decision.risk_level) {
        provenance.push(`risk: ${decision.risk_level}${decision.risk_category ? `/${decision.risk_category}` : ''}`);
    }
    const provenanceSuffix = provenance.length
        ? ` (${provenance.join('; ')})`
        : '';
    return `Permission denied${provenanceSuffix}: ${reason}`;
}
