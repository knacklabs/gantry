export function extractionResult(facts, status = facts.length > 0
    ? 'facts_extracted'
    : 'empty_qualified', zeroFactReason = facts.length === 0 ? 'no_qualifying_facts' : undefined) {
    return {
        facts,
        status,
        ...(zeroFactReason ? { zeroFactReason } : {}),
    };
}
