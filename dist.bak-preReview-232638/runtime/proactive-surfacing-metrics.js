import { createHash } from 'node:crypto';
function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function outcomeForPatternCandidateStatus(status) {
    if (status === 'accepted')
        return 'accepted';
    if (status === 'dismissed')
        return 'dismissed';
    return 'surfaced';
}
export function buildProactiveSurfacingMetricPayloads(input) {
    // ponytail: PII-scrubbed by construction; raw subjects and labels never enter the payload.
    const subjectHash = sha256Hex(input.subjectId);
    const candidates = input.candidates.length ? input.candidates : [undefined];
    return candidates.map((candidate) => ({
        subjectHash,
        outcome: input.outcome,
        ...(candidate?.signature
            ? { candidateSignature: candidate.signature }
            : {}),
    }));
}
