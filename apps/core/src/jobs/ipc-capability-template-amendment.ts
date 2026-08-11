import type { CapabilityTemplateAmendmentRepository } from '../domain/ports/capability-template-amendments.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import type { IpcDeps } from '../runtime/ipc-domain-types.js';
import { parseBashCommand } from '../shared/bash-command-parser.js';
import {
  canonicalCapabilityTemplateAmendment,
  redactObservedArgv,
} from '../shared/capability-template-amendment.js';
import {
  classifyCapabilityTemplateProposal,
  isCapabilityTemplateProposalWidening,
  type CapabilityTemplateWideningKind,
} from '../shared/capability-template-widening.js';
import {
  semanticCapabilityFromToolCatalogItem,
  validateLocalCliCommandTemplate,
} from '../shared/semantic-capabilities.js';
import { stableSha256Json } from '../shared/stable-hash.js';
import { recheckPausedSetupJobsAfterRequestAccessGrant } from './request-access-job-recovery.js';

export type CapabilityTemplateAmendmentResult =
  | { ok: false; error: string; code: 'invalid_request' | 'preflight_failed' }
  | {
      ok: true;
      code:
        | 'capability_amendment_proposal_recorded'
        | 'capability_amendment_proposal_already_pending'
        | 'capability_amendment_proposal_already_approved'
        | 'capability_amendment_proposal_previously_denied';
      message: string;
      review?: {
        proposal: import('../domain/ports/capability-template-amendments.js').CapabilityTemplateAmendmentProposal;
        displayName: string;
        can: string;
        cannot: string;
        wideningKind: CapabilityTemplateWideningKind;
      };
    };

export async function recordCapabilityTemplateAmendment(input: {
  appId: string;
  agentId: string;
  requestedBy: string;
  jobId?: string | null;
  conversationJid?: string | null;
  threadId?: string | null;
  providerAccountId?: string | null;
  payload: Record<string, unknown>;
  toolRepository?: ToolCatalogRepository;
  proposalRepository?: CapabilityTemplateAmendmentRepository;
  now: string;
}): Promise<CapabilityTemplateAmendmentResult> {
  const parsed = parseProposalPayload(input.payload);
  if (!parsed.ok) return parsed;
  if (!input.toolRepository || !input.proposalRepository) {
    return {
      ok: false,
      code: 'preflight_failed',
      error:
        'Capability template amendment storage is unavailable on this host.',
    };
  }

  const tools = await input.toolRepository.listTools({
    appId: input.appId as never,
    statuses: ['active'],
  });
  const capability = tools
    .filter((tool) => tool.status === 'active')
    .map((tool) => semanticCapabilityFromToolCatalogItem(tool))
    .find((candidate) => candidate?.capabilityId === parsed.capabilityId);
  if (!capability || capability.credentialSource !== 'local_cli') {
    return {
      ok: false,
      code: 'invalid_request',
      error: `No active local CLI capability matches id "${parsed.capabilityId}".`,
    };
  }

  const localCliBindings = capability.implementationBindings.filter(
    (binding) => binding.kind === 'local_cli' && binding.executablePath,
  );
  const currentTemplates = [
    ...new Set(
      localCliBindings.flatMap((binding) => binding.commandTemplates ?? []),
    ),
  ];
  const reviewedSchemaHash = stableSha256Json(capability);
  for (const template of parsed.proposedTemplates) {
    const matchingBinding = localCliBindings.find((binding) => {
      const validation = validateLocalCliCommandTemplate(
        binding.executablePath!,
        template,
      );
      return validation.ok;
    });
    if (!matchingBinding) {
      return {
        ok: false,
        code: 'invalid_request',
        error:
          'Proposed templates must be valid single-command local CLI templates beginning with the catalog-pinned executable.',
      };
    }
    const command = parseBashCommand(template);
    if (
      !command.ok ||
      command.leaves.length !== 1 ||
      command.leaves[0]!.redirects.length > 0
    ) {
      return {
        ok: false,
        code: 'invalid_request',
        error:
          'Proposed templates must contain exactly one command leaf and no redirects.',
      };
    }
  }

  // Redact BEFORE canonicalization so the dedup key and the durable row agree
  // and no raw credential ever leaves this function.
  const canonical = canonicalCapabilityTemplateAmendment({
    capabilityId: parsed.capabilityId,
    proposedTemplates: parsed.proposedTemplates,
    observedArgv: redactObservedArgv(parsed.observedArgv),
  });
  if (!input.conversationJid) {
    return {
      ok: false,
      code: 'preflight_failed',
      error:
        'Capability template amendments need an authenticated conversation route for the review card.',
    };
  }
  const claim = await input.proposalRepository.claimPending({
    id: `capability-amendment-${globalThis.crypto.randomUUID()}`,
    appId: input.appId,
    agentId: input.agentId,
    capabilityId: parsed.capabilityId,
    canonicalKey: canonical.canonicalKey,
    currentTemplates,
    proposedTemplates: canonical.proposedTemplates,
    observedArgv: canonical.observedArgv,
    reviewedSchemaHash,
    widening: isCapabilityTemplateProposalWidening({
      currentTemplates,
      proposedTemplates: canonical.proposedTemplates,
    }),
    requestedBy: input.requestedBy,
    jobId: input.jobId ?? null,
    conversationJid: input.conversationJid ?? null,
    threadId: input.threadId ?? null,
    providerAccountId: input.providerAccountId ?? null,
    now: input.now,
  });
  // A fresh proposal AND an existing pending one both carry the review
  // payload: a pending row whose card delivery failed earlier is redispatched
  // on the next identical mismatch, and the durable-interaction layer dedupes
  // duplicate prompts by requestId (the proposal id).
  if (claim.created || claim.proposal.status === 'pending') {
    return {
      ok: true,
      code: claim.created
        ? 'capability_amendment_proposal_recorded'
        : 'capability_amendment_proposal_already_pending',
      message: claim.created
        ? 'Capability template amendment proposal recorded for review.'
        : 'Capability template amendment proposal already pending review.',
      review: {
        proposal: claim.proposal,
        displayName: capability.displayName,
        can: capability.can,
        cannot: capability.cannot,
        wideningKind: classifyCapabilityTemplateProposal({
          currentTemplates,
          proposedTemplates: canonical.proposedTemplates,
        }),
      },
    };
  }
  if (claim.proposal.status === 'denied') {
    return {
      ok: true,
      code: 'capability_amendment_proposal_previously_denied',
      message:
        'This capability template amendment proposal was already denied and will not be raised again.',
    };
  }
  if (claim.proposal.status === 'approved') {
    return {
      ok: true,
      code: 'capability_amendment_proposal_already_approved',
      message:
        'This capability template amendment proposal was already approved.',
    };
  }
  return {
    ok: true,
    code: 'capability_amendment_proposal_already_pending',
    message:
      'This capability template amendment proposal is already waiting for review.',
  };
}

export function startCapabilityTemplateAmendmentReview(input: {
  deps: IpcDeps;
  repository: CapabilityTemplateAmendmentRepository;
  review: NonNullable<
    Extract<CapabilityTemplateAmendmentResult, { ok: true }>['review']
  >;
  providerAccountId?: string;
}): void {
  // Infrastructure failures (card delivery, recovery, receipts) must NEVER
  // write a durable denial: 'denied' is a human decision and terminally
  // dedupes the pair. The proposal stays pending; the next mismatch claim
  // re-dispatches the card and the durable-interaction layer dedupes actual
  // duplicate prompts by requestId.
  void completeCapabilityTemplateAmendmentReview(input).catch((err) => {
    logger.warn(
      { proposalId: input.review.proposal.id, err },
      'capability template amendment review failed; proposal stays pending for retry',
    );
  });
}

async function completeCapabilityTemplateAmendmentReview(input: {
  deps: IpcDeps;
  repository: CapabilityTemplateAmendmentRepository;
  review: NonNullable<
    Extract<CapabilityTemplateAmendmentResult, { ok: true }>['review']
  >;
  providerAccountId?: string;
}): Promise<void> {
  const { proposal } = input.review;
  if (!proposal.conversationJid) {
    throw new Error('Capability amendment approval route is missing.');
  }
  const requestId = proposal.id;
  const decision = await input.deps.requestPermissionApproval({
    requestId,
    appId: proposal.appId,
    agentId: proposal.agentId,
    sourceAgentFolder: proposal.requestedBy,
    targetJid: proposal.conversationJid,
    threadId: proposal.threadId ?? undefined,
    providerAccountId: proposal.providerAccountId ?? undefined,
    jobId: proposal.jobId ?? undefined,
    requestFamily: 'review',
    decisionPolicy: 'same_channel',
    decisionOptions: ['allow_once', 'cancel'],
    toolName: 'capability_template_amendment',
    displayName: input.review.displayName,
    title: `Fix how ${input.review.displayName} runs`,
    description: 'Only configured approvers can decide this fix.',
    toolInput: {
      diffPreview: capabilityTemplateTechnicalDiff(proposal),
    },
    interaction: {
      id: requestId,
      title: `Fix how ${input.review.displayName} runs`,
      body: capabilityTemplateCardBody(input.review),
    },
  });
  const decidedAt = new Date().toISOString();
  if (
    decision.approved &&
    (!decision.decidedBy || decision.decidedBy.startsWith('system'))
  ) {
    // An authorization-bearing mutation must be attributable to a configured
    // human approver; an anonymous approve is an infrastructure outcome.
    logger.warn(
      { proposalId: proposal.id },
      'capability template amendment approved without an authenticated approver; proposal stays pending',
    );
    return;
  }
  if (!decision.approved) {
    // Only an authenticated human rejection is terminal (0122). Timeouts and
    // system cancellations leave the proposal pending: the next mismatch
    // re-dispatches the card, and the interaction layer dedupes by requestId.
    if (!decision.decidedBy || decision.decidedBy.startsWith('system')) {
      logger.warn(
        { proposalId: proposal.id, reason: decision.reason },
        'capability template amendment not decided; proposal stays pending for retry',
      );
      return;
    }
    await input.repository.markDecision({
      id: proposal.id,
      status: 'denied',
      decidedBy: decision.decidedBy,
      decisionReason: decision.reason ?? 'Denied by approver.',
      now: decidedAt,
    });
    await input.deps.sendMessage(
      proposal.conversationJid,
      `Denied the fix for ${input.review.displayName}. Nothing changed.`,
      amendmentRouteOptions(proposal, proposal.providerAccountId ?? undefined),
    );
    return;
  }

  const amended =
    await input.repository.amendSemanticCapabilityCommandTemplates({
      proposalId: proposal.id,
      appId: proposal.appId,
      capabilityId: proposal.capabilityId,
      expectedReviewedSchemaHash: proposal.reviewedSchemaHash,
      proposedTemplates: proposal.proposedTemplates,
      approvedBy: decision.decidedBy!,
      approvedAt: decidedAt,
    });
  if (amended.status === 'stale') {
    await input.repository.markDecision({
      id: proposal.id,
      status: 'denied',
      decidedBy: 'system:superseded',
      decisionReason: 'Capability definition changed before approval.',
      now: decidedAt,
    });
    await input.deps.sendMessage(
      proposal.conversationJid,
      `The fix for ${input.review.displayName} was not applied because its reviewed setup changed. Nothing changed.`,
      amendmentRouteOptions(proposal, proposal.providerAccountId ?? undefined),
    );
    return;
  }
  if (amended.status === 'not_pending') return;

  // ponytail: recovery after the catalog commit is best-effort — a durable
  // approved-proposal outbox is the upgrade path if a post-commit crash ever
  // strands a paused job in practice; today the human 'resume job' guided
  // action and the next grant-recovery event both re-run this recheck.
  const recovery = await recheckPausedSetupJobsAfterRequestAccessGrant({
    deps: input.deps,
    appId: proposal.appId as never,
    sourceAgentFolder: proposal.requestedBy,
    targetJid: proposal.conversationJid,
    // Proposals dedupe app-wide: recover EVERY paused job blocked on this
    // capability, not only the first claimer's.
    jobId: undefined,
    recoveringPermissionRequestId: proposal.id,
  });
  const resumed = recovery?.queued.length
    ? ` Job resumed: ${recovery.queued
        .map((job) => job.name || job.jobId)
        .join(', ')}.`
    : '';
  await input.deps.sendMessage(
    proposal.conversationJid,
    `Approved the fix for ${input.review.displayName}.${resumed}`,
    amendmentRouteOptions(proposal, proposal.providerAccountId ?? undefined),
  );
}

function capabilityTemplateCardBody(input: {
  displayName: string;
  can: string;
  cannot: string;
  wideningKind: CapabilityTemplateWideningKind;
}): string {
  const warning =
    input.wideningKind === 'added_inputs'
      ? "This also lets the command take an extra input it couldn't before."
      : input.wideningKind === 'expanded'
        ? 'This broadens how the command may be used. Review the technical details before approving.'
        : null;
  return [
    warning,
    `The approved way of using ${input.displayName} did not fit what the job needed, so it stopped.`,
    `Approving corrects the allowed command shape. What I can do stays the same: ${input.can}. What I still cannot do: ${input.cannot}.`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n\n');
}

function capabilityTemplateTechnicalDiff(
  proposal: import('../domain/ports/capability-template-amendments.js').CapabilityTemplateAmendmentProposal,
): string {
  return [
    '--- current-command-templates',
    '+++ proposed-command-templates',
    ...proposal.currentTemplates.map((template) => `-${template}`),
    ...proposal.proposedTemplates.map((template) => `+${template}`),
    '',
    `Observed argv: ${JSON.stringify(proposal.observedArgv)}`,
  ].join('\n');
}

function amendmentRouteOptions(
  proposal: import('../domain/ports/capability-template-amendments.js').CapabilityTemplateAmendmentProposal,
  providerAccountId?: string,
): { threadId?: string; providerAccountId?: string } | undefined {
  return proposal.threadId || providerAccountId
    ? {
        ...(proposal.threadId ? { threadId: proposal.threadId } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
      }
    : undefined;
}

function parseProposalPayload(payload: Record<string, unknown>):
  | {
      ok: true;
      capabilityId: string;
      proposedTemplates: string[];
      observedArgv: string[];
    }
  | { ok: false; error: string; code: 'invalid_request' } {
  if (
    [
      'executablePath',
      'executableHash',
      'executableVersion',
      'version',
      'currentTemplates',
      'reviewedSchemaHash',
    ].some((field) => Object.prototype.hasOwnProperty.call(payload, field))
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      error:
        'Capability template amendment proposals cannot amend or copy catalog-owned executable identity, version, current templates, or schema hash.',
    };
  }
  if (
    payload.capabilityRequestSource !== 'request_access' ||
    payload.capabilityProposalKind !== 'capability_template_amendment'
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      error:
        'Capability template amendments must use request_access target.kind=capability_template_amendment.',
    };
  }
  const capabilityId =
    typeof payload.capabilityId === 'string' ? payload.capabilityId.trim() : '';
  const proposedTemplates = Array.isArray(payload.proposedTemplates)
    ? payload.proposedTemplates
    : [];
  const observedArgv = Array.isArray(payload.observedArgv)
    ? payload.observedArgv
    : [];
  if (
    !capabilityId ||
    proposedTemplates.length < 1 ||
    proposedTemplates.length > 8 ||
    proposedTemplates.some(
      (value) =>
        typeof value !== 'string' || !value.trim() || value.length > 2048,
    ) ||
    observedArgv.length > 128 ||
    observedArgv.some(
      (value) => typeof value !== 'string' || value.length > 8192,
    )
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      error:
        'Capability template amendments require capabilityId, 1..8 proposedTemplates, and a string observedArgv array.',
    };
  }
  return {
    ok: true,
    capabilityId,
    proposedTemplates: proposedTemplates as string[],
    observedArgv: observedArgv as string[],
  };
}

/**
 * Full IPC branch for an amendment proposal: preflight the approval surface,
 * record the proposal, dispatch the review card for fresh proposals, respond.
 * Lives here (not in ipc-admin-handlers) so the handler stays a thin router.
 */
export async function handleCapabilityTemplateAmendmentRequest(input: {
  payload: Parameters<typeof recordCapabilityTemplateAmendment>[0]['payload'];
  appId: string;
  agentId: string;
  sourceAgentFolder: string;
  jobId?: string | null;
  conversationJid?: string | null;
  threadId?: string | null;
  providerAccountId?: string | null;
  toolRepository: Parameters<
    typeof recordCapabilityTemplateAmendment
  >[0]['toolRepository'];
  proposalRepository: Parameters<
    typeof recordCapabilityTemplateAmendment
  >[0]['proposalRepository'];
  deps: Parameters<typeof startCapabilityTemplateAmendmentReview>[0]['deps'];
  approvalSurfaceReady: boolean;
  now: string;
  accept: (message: string, code: string) => void;
  reject: (message: string, code: string) => void;
}): Promise<void> {
  if (!input.approvalSurfaceReady) {
    input.reject(
      'Capability template amendments require a configured approval surface.',
      'preflight_failed',
    );
    return;
  }
  const result = await recordCapabilityTemplateAmendment({
    appId: input.appId,
    agentId: input.agentId,
    requestedBy: input.sourceAgentFolder,
    jobId: input.jobId ?? null,
    conversationJid: input.conversationJid ?? null,
    threadId: input.threadId ?? null,
    providerAccountId: input.providerAccountId ?? null,
    payload: input.payload,
    toolRepository: input.toolRepository,
    proposalRepository: input.proposalRepository,
    now: input.now,
  });
  if (!result.ok) {
    input.reject(result.error, result.code);
    return;
  }
  if (result.review && input.proposalRepository) {
    startCapabilityTemplateAmendmentReview({
      deps: input.deps,
      repository: input.proposalRepository,
      review: result.review,
      providerAccountId: input.providerAccountId ?? undefined,
    });
  }
  input.accept(result.message, result.code);
}
