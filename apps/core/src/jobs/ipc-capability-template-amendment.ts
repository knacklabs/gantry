import type { CapabilityTemplateAmendmentRepository } from '../domain/ports/capability-template-amendments.js';
import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import { parseBashCommand } from '../shared/bash-command-parser.js';
import { canonicalCapabilityTemplateAmendment, redactObservedArgv,
} from '../shared/capability-template-amendment.js';
import { isCapabilityTemplateProposalWidening } from '../shared/capability-template-widening.js';
import {
  semanticCapabilityFromToolCatalogItem,
  validateLocalCliCommandTemplate,
} from '../shared/semantic-capabilities.js';
import { stableSha256Json } from '../shared/stable-hash.js';

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
    };

export async function recordCapabilityTemplateAmendment(input: {
  appId: string;
  agentId: string;
  requestedBy: string;
  jobId?: string | null;
  conversationJid?: string | null;
  threadId?: string | null;
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
    now: input.now,
  });
  if (claim.created) {
    return {
      ok: true,
      code: 'capability_amendment_proposal_recorded',
      message: 'Capability template amendment proposal recorded for review.',
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

function parseProposalPayload(payload: Record<string, unknown>):
  | {
      ok: true;
      capabilityId: string;
      proposedTemplates: string[];
      observedArgv: string[];
    }
  | { ok: false; error: string; code: 'invalid_request' } {
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
