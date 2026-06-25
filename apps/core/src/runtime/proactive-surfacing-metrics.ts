import { createHash } from 'node:crypto';

export type ProactiveSurfacingOutcome =
  | 'surfaced'
  | 'accepted'
  | 'dismissed'
  | 'opted_out'
  | 'skipped_error'
  | 'opt_in_unavailable';

export interface ProactiveSurfacingMetricCandidate {
  signature?: string | null;
  status?: string;
}

export interface ProactiveSurfacingMetricPayload {
  subjectHash: string;
  outcome: ProactiveSurfacingOutcome;
  candidateSignature?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function outcomeForPatternCandidateStatus(
  status: string | undefined,
): ProactiveSurfacingOutcome {
  if (status === 'accepted') return 'accepted';
  if (status === 'dismissed') return 'dismissed';
  return 'surfaced';
}

export function buildProactiveSurfacingMetricPayloads(input: {
  subjectId: string;
  candidates: ProactiveSurfacingMetricCandidate[];
  outcome: ProactiveSurfacingOutcome;
}): ProactiveSurfacingMetricPayload[] {
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
