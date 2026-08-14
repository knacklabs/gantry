import {
  closeEgressGateway,
  ensureEgressGateway,
} from '../runtime/egress-gateway.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { jobSetupActionEventPayload } from '../domain/events/job-setup-action.js';
import type { JobToolDenial } from '../domain/events/job-tool-denial.js';
import {
  jobToolDenialIdempotencyKey,
  toolDenialEventPayload,
} from './execution-diagnostics.js';
import type { CapabilityTemplateAmendmentRepository } from '../domain/ports/capability-template-amendments.js';
import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import { permissionRunRestriction } from '../runtime/permission-decision-coordinator.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import { instructionSetupAction } from '../shared/job-setup-action.js';
import { semanticCapabilityFromToolCatalogItem } from '../shared/semantic-capabilities.js';
import { buildAsyncCommandEnv } from './async-command-sandbox-runner.js';
import { compileCapabilityTemplateMismatch } from './capability-template-compiler.js';
import {
  recordCapabilityTemplateAmendment,
  startCapabilityTemplateAmendmentReview,
} from './ipc-capability-template-amendment.js';
import {
  runStructuredLocalCliCapability,
  StructuredLocalCliInvocationError,
} from './structured-local-cli-invocation.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';

// S4-COMPILER deliberately lands dormant. S4-INTENT flips this only after the
// approve-amend-resume intent is durable, so a production mismatch cannot
// expose an approvable proposal across the D-0057 crash gap.
export const HOST_CAPABILITY_TEMPLATE_PROPOSALS_ACTIVE = false;

let getCapabilityTemplateAmendmentRepository:
  | (() => CapabilityTemplateAmendmentRepository)
  | undefined;

export function configureCapabilityTemplateMismatchHost(input: {
  getProposalRepository: () => CapabilityTemplateAmendmentRepository;
}): void {
  getCapabilityTemplateAmendmentRepository = input.getProposalRepository;
}

export async function compileAndRecordHostCapabilityTemplateMismatch(input: {
  appId: string;
  agentId: string;
  requestedBy: string;
  capabilityId: string;
  observedArgs: string[];
  jobId?: string | null;
  conversationJid?: string | null;
  threadId?: string | null;
  providerAccountId?: string | null;
  toolRepository: ToolCatalogRepository;
  proposalRepository: CapabilityTemplateAmendmentRepository;
  now: string;
}) {
  const tools = await input.toolRepository.listTools({
    appId: input.appId as never,
    statuses: ['active'],
  });
  // Compiler input is scoped to THE requested capability's catalog
  // templates by the plan ("the app's catalog templates for the
  // capability") - cross-capability prefix collisions are out of scope
  // for exactly-one, deliberately.
  const capability = tools
    .filter((tool) => tool.status === 'active')
    .map((tool) => semanticCapabilityFromToolCatalogItem(tool))
    .find((candidate) => candidate?.capabilityId === input.capabilityId);
  const localCliBindings = (capability?.implementationBindings ?? []).filter(
    (binding) => binding.kind === 'local_cli' && binding.executablePath,
  );
  // Exactly-one applies to the MATCHING template across the WHOLE
  // catalog: exactly one prefix match total, and it must be eligible - a
  // same-prefix ineligible template in a sibling binding makes the match
  // ambiguous (review R2/R3).
  const compilations = localCliBindings.map((binding) =>
    compileCapabilityTemplateMismatch({
      executablePath: binding.executablePath!,
      commandTemplates: binding.commandTemplates ?? [],
      observedArgs: input.observedArgs,
    }),
  );
  const totalPrefixMatches = compilations.reduce(
    (sum, candidate) => sum + candidate.prefixMatches,
    0,
  );
  const proposals = compilations.filter(
    (candidate): candidate is typeof candidate & { kind: 'proposal' } =>
      candidate.kind === 'proposal',
  );
  const compilation =
    totalPrefixMatches === 1 && proposals.length === 1 ? proposals[0]! : null;
  if (!compilation) {
    return {
      action: instructionSetupAction(
        `Ask an administrator to review the command template for capability "${input.capabilityId}".`,
      ),
    };
  }
  const result = await recordCapabilityTemplateAmendment({
    appId: input.appId,
    agentId: input.agentId,
    requestedBy: input.requestedBy,
    jobId: input.jobId,
    conversationJid: input.conversationJid,
    threadId: input.threadId,
    providerAccountId: input.providerAccountId,
    capabilityId: input.capabilityId,
    proposedTemplates: compilation.proposedTemplates,
    observedArgv: compilation.observedArgv,
    toolRepository: input.toolRepository,
    proposalRepository: input.proposalRepository,
    now: input.now,
  });
  if (!result.ok || !result.review) {
    return {
      action: instructionSetupAction(
        `Ask an administrator to review the command template for capability "${input.capabilityId}".`,
      ),
    };
  }
  return {
    action: {
      kind: 'fix_proposal' as const,
      proposalId: result.review.proposal.id,
    },
    review: result.review,
  };
}

const capabilityRunHandler: TaskHandler = async (context) => {
  const { data } = context;
  // Bound execution to the CALLER's absolute deadline (stamped by the runner
  // at request time and carried in the payload), minus a margin for the
  // response trip back — so an IPC dispatch delay before this handler starts
  // cannot let a command outlive the caller's wait and be double-applied on a
  // retry. Cap at a local max in case the payload deadline is missing or
  // (worker-forgeably) far in the future. The abort timer is armed with the
  // remaining budget and the pre-spawn check refuses to launch once spent.
  const localMaxDeadline = Date.now() + 118_000;
  const callerDeadline =
    typeof data.payload?.deadlineAt === 'number'
      ? data.payload.deadlineAt - 5_000
      : localMaxDeadline;
  const deadlineAt = Math.min(localMaxDeadline, callerDeadline);
  const { acceptData, reject } = createTaskResponder(
    context.sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const payload = data.payload;
  const capabilityId = toTrimmedString(payload?.capabilityId, { maxLen: 255 });
  const rawArgs = payload?.args;
  const args = Array.isArray(rawArgs)
    ? rawArgs.filter((arg): arg is string => typeof arg === 'string')
    : null;
  if (
    !capabilityId ||
    !args ||
    !Array.isArray(rawArgs) ||
    args.length !== rawArgs.length
  ) {
    reject(
      'capability_run requires capabilityId and a string args array.',
      'invalid_args',
    );
    return;
  }
  if (!data.appId || !data.agentId || !data.responseKeyId) {
    reject(
      'Capability invocation authority is incomplete.',
      'permission_denied',
    );
    return;
  }
  const restriction = permissionRunRestriction({
    sourceAgentFolder: context.sourceAgentFolder,
    responseKeyId: data.responseKeyId,
  });
  if (
    !restriction ||
    data.sourceRunKind !== restriction.runKind ||
    data.sourceJobId !== restriction.jobId ||
    data.sourceRunId !== restriction.runId
  ) {
    reject(
      'Capability invocation source could not be verified.',
      'permission_denied',
    );
    return;
  }
  if (!data.chatJid || !context.sourceAgentFolderJids.includes(data.chatJid)) {
    reject(
      'Capability invocation conversation is outside this run.',
      'permission_denied',
    );
    return;
  }
  const repository = context.deps.getToolRepository?.();
  const runnerSandboxProvider = context.deps.runnerSandboxProvider;
  if (!repository || !runnerSandboxProvider) {
    reject(
      'Capability execution is not available on this host.',
      'executor_unavailable',
    );
    return;
  }

  const gateway = await ensureEgressGateway({
    key: `capability-run:${context.sourceAgentFolder}:${data.taskId ?? 'unknown'}`,
    settings: context.deps.getEgressSettings?.() ?? { denylist: [] },
    principal: {
      appId: data.appId,
      agentId: data.agentId,
      conversationId: data.chatJid,
      threadId: data.authThreadId,
      runId: restriction.runId,
      jobId: restriction.jobId,
    },
    ...(context.deps.publishRuntimeEvent
      ? { publishRuntimeEvent: context.deps.publishRuntimeEvent }
      : {}),
  });
  // Arm the sandbox-abort timer with the budget remaining after setup. If
  // setup already consumed it (0), the pre-spawn abort check refuses to launch.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(),
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    const result = await runStructuredLocalCliCapability({
      repository,
      appId: data.appId,
      agentId: data.agentId,
      personId: restriction.memoryUserId,
      capabilityId,
      args,
      cwd: resolveWorkspaceFolderPath(context.sourceAgentFolder),
      env: buildAsyncCommandEnv(),
      runnerSandboxProvider,
      egressProxyUrl: gateway.proxyUrl,
      signal: deadline.signal,
      conversationId: data.chatJid,
      threadId: data.authThreadId,
      runId: restriction.runId,
      jobId: restriction.jobId,
    });
    acceptData('Capability command completed.', result);
  } catch (error) {
    if (error instanceof StructuredLocalCliInvocationError) {
      if (error.code === 'capability_template_mismatch') {
        // Proposal recording is DORMANT until S4-INTENT, but denial
        // OBSERVABILITY is not: the typed host-lane JOB_TOOL_DENIED event
        // always appends so finalization/readiness readers see the
        // mismatch (review R1). While dormant the action is instruction.
        let action = instructionSetupAction(
          `Ask an administrator to review the command template for capability "${capabilityId}".`,
        ) as Parameters<typeof jobSetupActionEventPayload>[0];
        if (HOST_CAPABILITY_TEMPLATE_PROPOSALS_ACTIVE) {
          const proposalRepository =
            getCapabilityTemplateAmendmentRepository?.();
          if (!proposalRepository) {
            reject(
              'Capability template amendment storage is unavailable on this host.',
              'preflight_failed',
            );
            return;
          }
          const outcome = await compileAndRecordHostCapabilityTemplateMismatch({
            appId: data.appId,
            agentId: data.agentId,
            requestedBy: context.sourceAgentFolder,
            capabilityId,
            observedArgs: args,
            jobId: restriction.jobId,
            conversationJid: data.chatJid,
            threadId: data.authThreadId,
            providerAccountId: data.providerAccountId,
            toolRepository: repository,
            proposalRepository,
            now: new Date().toISOString(),
          });
          action = outcome.action;
          if (outcome.review) {
            startCapabilityTemplateAmendmentReview({
              deps: context.deps,
              repository: proposalRepository,
              review: outcome.review,
              providerAccountId: data.providerAccountId,
            });
          }
        }
        if (
          restriction.runKind === 'scheduled' &&
          restriction.jobId &&
          restriction.runId &&
          context.deps.publishRuntimeEvent
        ) {
          const denial: JobToolDenial = {
            toolName: 'capability_run',
            reason: error.message,
            denialKind: 'capability_template_mismatch',
            provenanceLane: 'host',
            provenanceSeam: 'capability_run',
            action,
          };
          try {
            await context.deps.publishRuntimeEvent({
              appId: data.appId as never,
              agentId: data.agentId as never,
              runId: restriction.runId as never,
              jobId: restriction.jobId as never,
              conversationId: data.chatJid as never,
              threadId: data.authThreadId as never,
              eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
              actor: 'host',
              responseMode: 'none',
              payload: toolDenialEventPayload(denial, error.message),
              idempotencyKey: jobToolDenialIdempotencyKey(
                restriction.runId,
                denial,
              ),
            });
          } catch {
            // Observability only - a failed append must never replace the
            // deterministic mismatch response (review R3).
          }
        }
        // The RESPONSE is the transport for the action (the event is an
        // observational copy): interactive callers get the instruction or
        // proposal reference here (review R3).
        reject(error.message, error.code, [
          JSON.stringify({ action: jobSetupActionEventPayload(action) }),
        ]);
        return;
      }
      reject(error.message, error.code);
      return;
    }
    reject(
      error instanceof Error ? error.message : 'Capability execution failed.',
      'execution_failed',
    );
  } finally {
    clearTimeout(deadlineTimer);
    await closeEgressGateway(gateway);
  }
};

export const capabilityRunTaskHandlers: Record<string, TaskHandler> = {
  capability_run: capabilityRunHandler,
};
