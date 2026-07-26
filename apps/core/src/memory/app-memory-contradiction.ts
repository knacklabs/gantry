import type {
  MemoryContradiction,
  MemoryContradictionNomination,
  MemoryLifecycleProposal,
} from './memory-types.js';

const ALLOWED_CONFLICT_TYPES = new Set<MemoryContradiction['type']>([
  'same_key_value_disagreement',
  'llm_claim_conflict',
]);

/** A pair of claims is only a contradiction if they disagree on substance. */
export function normalizeClaim(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

type SideRef = {
  id: string;
  kind: string;
  key: string;
  value: string;
  evidenceIds: string[];
};

/**
 * Host-side gate every contradiction must pass before a review is created.
 * Subject boundary, evidence scope, and canonical grounding are enforced
 * downstream by validateMemoryReviewProposal; this checks the pair itself.
 */
export function validateContradiction(contradiction: MemoryContradiction): {
  ok: boolean;
  reason: string;
} {
  const { type, active, incoming, proposedCanonical } = contradiction;
  if (!ALLOWED_CONFLICT_TYPES.has(type)) {
    return { ok: false, reason: 'unsupported contradiction type' };
  }
  if (!active.itemId || !incoming.candidateId) {
    return {
      ok: false,
      reason: 'contradiction missing active item or candidate',
    };
  }
  if (!active.evidenceIds.length || !incoming.evidenceIds.length) {
    return {
      ok: false,
      reason: 'contradiction is missing evidence on one side',
    };
  }
  if (
    !proposedCanonical.evidenceIds.length ||
    !proposedCanonical.value.trim()
  ) {
    return {
      ok: false,
      reason: 'proposed canonical claim is empty or ungrounded',
    };
  }
  if (normalizeClaim(active.value) === normalizeClaim(incoming.value)) {
    return { ok: false, reason: 'contradiction sides are not distinct claims' };
  }
  return { ok: true, reason: 'contradiction passed host validation' };
}

/**
 * Deterministic same-key/different-value contradiction built entirely from
 * host rows. The incoming (staged) claim is treated as the correction, so the
 * proposed canonical is grounded in the incoming evidence.
 */
export function buildDeterministicContradiction(input: {
  active: SideRef;
  candidate: SideRef;
  reason: string;
}): MemoryContradiction | null {
  const { active, candidate } = input;
  if (!active.evidenceIds.length || !candidate.evidenceIds.length) return null;
  if (normalizeClaim(active.value) === normalizeClaim(candidate.value))
    return null;
  return {
    type: 'same_key_value_disagreement',
    active: {
      itemId: active.id,
      kind: active.kind,
      key: active.key,
      value: active.value,
      evidenceIds: active.evidenceIds,
    },
    incoming: {
      candidateId: candidate.id,
      kind: candidate.kind,
      key: candidate.key,
      value: candidate.value,
      evidenceIds: candidate.evidenceIds,
    },
    proposedCanonical: {
      kind: candidate.kind,
      key: candidate.key,
      value: candidate.value,
      reason: input.reason,
      evidenceIds: candidate.evidenceIds,
    },
  };
}

/**
 * Resolve an LLM nomination into a validated contradiction using only the
 * active items and candidates the host supplied. Any reference to an item the
 * host did not provide, or a side with no in-scope evidence, is rejected.
 */
export function resolveContradictionNomination(input: {
  nomination: MemoryContradictionNomination;
  proposal: MemoryLifecycleProposal;
  activeById: Map<string, SideRef>;
  candidateById: Map<string, SideRef>;
}):
  | { ok: true; contradiction: MemoryContradiction }
  | { ok: false; reason: string } {
  const { nomination, proposal, activeById, candidateById } = input;
  const active = activeById.get(nomination.activeItemId);
  if (!active) {
    return {
      ok: false,
      reason: 'contradiction references an active item the host did not supply',
    };
  }
  const candidate = candidateById.get(nomination.incomingCandidateId);
  if (!candidate) {
    return {
      ok: false,
      reason: 'contradiction references a candidate the host did not supply',
    };
  }
  const activeEvidence = nomination.activeEvidenceIds.filter((id) =>
    active.evidenceIds.includes(id),
  );
  const incomingEvidence = nomination.incomingEvidenceIds.filter((id) =>
    candidate.evidenceIds.includes(id),
  );
  const proposedEvidence = proposal.evidenceIds.length
    ? proposal.evidenceIds
    : incomingEvidence;
  const contradiction: MemoryContradiction = {
    type: nomination.conflictType,
    active: {
      itemId: active.id,
      kind: active.kind,
      key: active.key,
      value: active.value,
      evidenceIds: activeEvidence,
    },
    incoming: {
      candidateId: candidate.id,
      kind: candidate.kind,
      key: candidate.key,
      value: candidate.value,
      evidenceIds: incomingEvidence,
    },
    proposedCanonical: {
      kind: proposal.kind ?? candidate.kind,
      key: proposal.key ?? candidate.key,
      value: proposal.value ?? candidate.value,
      reason: proposal.reason,
      evidenceIds: proposedEvidence,
    },
  };
  const check = validateContradiction(contradiction);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, contradiction };
}
