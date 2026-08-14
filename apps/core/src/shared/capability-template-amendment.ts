import { stableSha256Json } from './stable-hash.js';

export function canonicalCapabilityTemplateAmendment(input: {
  capabilityId: string;
  proposedTemplates: readonly string[];
  observedArgv: readonly string[];
}): {
  proposedTemplates: string[];
  observedArgv: string[];
  canonicalKey: string;
} {
  const proposedTemplates = [
    ...new Set(input.proposedTemplates.map((template) => template.trim())),
  ].sort();
  const observedArgv = [...input.observedArgv];
  return {
    proposedTemplates,
    observedArgv,
    // Identity = (capability, canonical proposed templates) - the argv is
    // ONE redacted observability sample, not part of the dedup key
    // (decision 0122; the old argv-bearing keys are retired by migration).
    canonicalKey: stableSha256Json({
      capabilityId: input.capabilityId.trim(),
      proposedTemplates,
    }),
  };
}

const SENSITIVE_ARGV_PATTERN =
  /(token|secret|password|passwd|api[_-]?key|credential|bearer|authorization)/i;
// Long opaque blobs (keys, JWTs, signed URLs) that carry entropy, not shape.
const OPAQUE_ARGV_PATTERN = /^[A-Za-z0-9+/_.=-]{64,}$/;

/**
 * Argv is review EVIDENCE, not an executable payload — it must never carry
 * credentials into durable storage or review surfaces. Values are redacted
 * conservatively: a flag with a sensitive name keeps the flag, loses the
 * value; a freestanding sensitive-looking or long opaque token is masked
 * whole. Shape (arity, flag names, subcommands) is preserved for review.
 */
export function redactObservedArgv(argv: readonly string[]): string[] {
  return argv.map((token, index, all) => {
    // URL-like values: the query string is where credentials ride
    // (access_token=, signature=, X-Amz-*) — drop it whole, keep the shape.
    if (token.includes('://')) {
      let url = token;
      // Userinfo (postgres://user:pass@host, https://user:token@host).
      const scheme = url.indexOf('://');
      const at = url.indexOf('@', scheme + 3);
      const firstSlash = url.indexOf('/', scheme + 3);
      if (at !== -1 && (firstSlash === -1 || at < firstSlash)) {
        url = `${url.slice(0, scheme + 3)}<redacted>@${url.slice(at + 1)}`;
      }
      const q = url.indexOf('?');
      const h = url.indexOf('#');
      const cut = q === -1 ? h : h === -1 ? q : Math.min(q, h);
      return cut === -1 ? url : `${url.slice(0, cut)}?<redacted>`;
    }
    // Header-style values ("Authorization: Bearer x", "Bearer x").
    if (/\b(authorization|bearer)\b/i.test(token) && /[:\s]/.test(token)) {
      return '<redacted>';
    }
    const eq = token.indexOf('=');
    if (token.startsWith('-') && eq > 0) {
      const name = token.slice(0, eq);
      const value = token.slice(eq + 1);
      return SENSITIVE_ARGV_PATTERN.test(name) ||
        /^[^\s@]+@[^\s@]+$/.test(value)
        ? `${name}=<redacted>`
        : OPAQUE_ARGV_PATTERN.test(value)
          ? `${name}=<redacted>`
          : token;
    }
    if (!token.startsWith('-') && eq > 0) {
      const name = token.slice(0, eq);
      if (
        SENSITIVE_ARGV_PATTERN.test(name) ||
        OPAQUE_ARGV_PATTERN.test(token.slice(eq + 1))
      ) {
        return `${name}=<redacted>`;
      }
    }
    const previous = index > 0 ? all[index - 1] : undefined;
    // Regardless of a leading dash: the value slot after --account is a
    // value, and an @-bearing one is an account identity (review R4).
    if (previous === '--account' && /@/.test(token)) {
      return '<redacted>';
    }
    if (
      previous?.startsWith('-') &&
      SENSITIVE_ARGV_PATTERN.test(previous) &&
      !token.startsWith('-')
    ) {
      return '<redacted>';
    }
    if (!token.startsWith('-') && OPAQUE_ARGV_PATTERN.test(token)) {
      return '<redacted>';
    }
    if (!token.startsWith('-') && /^[^\s@]+@[^\s@]+$/.test(token)) {
      return '<redacted>';
    }
    return token;
  });
}

export type CapabilityTemplateApprovalIntentStatus =
  | 'pending'
  | 'completed'
  | 'superseded';

export type CapabilityTemplateApprovalIntentTargetStatus =
  | 'pending'
  | 'resumed'
  | 'superseded';

export interface ClaimedCapabilityTemplateApprovalIntent {
  id: string;
  appId: string;
  proposalId: string;
  capabilityId: string;
  claimToken: string;
  attemptCount: number;
  targets: Array<{
    jobId: string;
    expectedSetupFingerprint: string;
  }>;
}

export interface CapabilityTemplateApprovalIntentRepository {
  claimDueApprovalIntents(input: {
    claimerId: string;
    now: string;
    leaseExpiresAt: string;
    limit: number;
  }): Promise<ClaimedCapabilityTemplateApprovalIntent[]>;
  renewApprovalIntentClaim?(input: {
    intentId: string;
    claimToken: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean>;
  settleApprovalIntentClaim(input: {
    intentId: string;
    claimToken: string;
    outcomes: Array<{
      jobId: string;
      status: Exclude<CapabilityTemplateApprovalIntentTargetStatus, 'pending'>;
    }>;
    now: string;
    nextAttemptAt: string;
    error?: string;
  }): Promise<'completed' | 'pending' | 'superseded'>;
}
