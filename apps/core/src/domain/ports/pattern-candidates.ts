import type {
  PatternCandidate,
  PatternCandidateStatus,
  PatternProposalStatus,
} from '@gantry/contracts';

/** The (app, agent, subject) scope a candidate belongs to. */
export interface PatternCandidateSubject {
  appId: string;
  agentId: string;
  folder: string;
  subjectType: string;
  subjectId: string;
}

/** A lifecycle transition: surfacing it, or a live user decision. */
export interface PatternCandidateTransition {
  candidateStatus: PatternCandidateStatus;
  /** Only set when moving to `accepted` (proposal_requested) — else left untouched. */
  proposalStatus?: PatternProposalStatus | null;
  /** Only set when moving to `snoozed` — else left untouched. */
  snoozedUntil?: string | null;
}

/**
 * Reader (the runner) + decision writer (the candidate decision service). The
 * detector/upsert writer is the dreaming pass, which writes via direct
 * `db` + schema (memory-layer convention) rather than this port.
 */
export interface PatternCandidateRepository {
  /** Read-only (the runner): top eligible (detected/suggested) candidates for a subject. */
  listEligible(input: {
    subject: PatternCandidateSubject;
    limit: number;
  }): Promise<PatternCandidate[]>;

  /** Read-only (the observer): top eligible candidates across an app. */
  listEligibleForApp?(input: {
    appId: string;
    limit: number;
  }): Promise<PatternCandidate[]>;

  getById(id: string): Promise<PatternCandidate | null>;

  /**
   * Writes a lifecycle transition: the runner marking a surfaced candidate
   * `suggested`, or the candidate decision service writing a live user choice
   * (`accepted` | `snoozed` | `dismissed`) with its proposal/snooze fields.
   */
  transition(input: {
    id: string;
    transition: PatternCandidateTransition;
    nowIso: string;
  }): Promise<PatternCandidate | null>;

  setProposalStatus(input: {
    id: string;
    proposalStatus: PatternProposalStatus;
    nowIso: string;
  }): Promise<PatternCandidate | null>;
}
