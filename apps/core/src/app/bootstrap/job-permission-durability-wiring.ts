import { uptime } from 'node:os';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  canonicalJobPermissionNeedIdentity,
  JobPermissionDurabilityService,
  type JobPermissionRevalidationResult,
} from '../../application/interactions/job-permission-durability.js';
import { resolveAgentToolRuntimePolicyFromSnapshot } from '../../application/agents/agent-tool-runtime-rules.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { evaluatePermissionDeterministicRails } from '../../domain/permission-deterministic-rails.js';
import {
  applyPermissionInteractionDecision,
  resolvePendingInteractionRecordOutcome,
} from '../../application/interactions/pending-interaction-durability.js';
import { persistentRules } from '../../domain/permission-decision.js';
import type {
  JobPermissionDurabilityRepository,
  JobPermissionNeedRecord,
  JobPermissionWaiter,
} from '../../domain/ports/job-permission-durability.js';
import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import {
  acquireRunSlotForPermissionWake,
  releaseRunSlotForPermissionWait,
} from '../../jobs/concurrency.js';
import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import { writeResolvedInteractionResponse } from '../../runtime/interaction-resolution-response.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import { jobPermissionOutcomeForResponse } from '../../shared/unprojected-access.js';
import { parseSemanticCapabilityRule } from '../../shared/semantic-capability-ids.js';
import { evaluateProtectedCapabilityToolUse } from '../../shared/tool-execution-policy-service.js';
import {
  evaluateYoloModeDenylist,
  type YoloModeSettings,
  yoloModeDenylistDenyReason,
} from '../../shared/yolo-mode-policy.js';
import type { ChannelWiring } from './channel-wiring-types.js';

interface JobPermissionCardTarget {
  appId: string;
  conversationId: string;
  threadId: string | null;
  agentId: string | null;
}

interface JobPermissionDurabilityWiringDeps {
  repository: WorkerCoordinationRepository & JobPermissionDurabilityRepository;
  opsRepository: RuntimeJobRepository;
  channelWiring: Pick<ChannelWiring, 'isControlApproverAllowed'>;
  getPermissionRuntimeSettings(): {
    agents: Record<
      string,
      | {
          accessPreset?: 'full' | 'locked';
          capabilities?: Array<{ id: string }>;
        }
      | null
      | undefined
    >;
    permissions: {
      trustedRoots?: string[];
      yoloMode?: YoloModeSettings;
    };
  };
  getToolRepository(): ToolCatalogRepository | undefined;
  getSkillRepository(): SkillCatalogRepository | undefined;
  resolveCardTarget(
    request: PermissionApprovalRequest,
  ): JobPermissionCardTarget;
  enqueueRunAgain(input: {
    idempotencyKey: string;
    jobId: string;
    priorRunId: string;
  }): Promise<void>;
  now?: () => string;
  monotonicMs?: () => number;
  hostBootId?: () => string;
}

export function createJobPermissionDurabilityWiring(
  deps: JobPermissionDurabilityWiringDeps,
): JobPermissionDurabilityService & {
  attachRequest(input: {
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
  }): Promise<boolean>;
} {
  const now = deps.now ?? (() => new Date().toISOString());
  const service = new JobPermissionDurabilityService(
    deps.repository,
    {
      authorizeActor: async (input) => {
        const job = await deps.opsRepository.getJobById(input.jobId);
        const conversationJid = input.conversationJid?.trim();
        const actorRef = input.actorRef.trim();
        if (
          !job ||
          !conversationJid ||
          !actorRef ||
          job.execution_context?.conversationJid !== conversationJid
        ) {
          return false;
        }
        return deps.channelWiring.isControlApproverAllowed({
          conversationJid,
          ...(input.providerAccountId
            ? { providerAccountId: input.providerAccountId }
            : {}),
          ...(job.execution_context.threadId
            ? { threadId: job.execution_context.threadId }
            : {}),
          userId: actorRef,
          sourceAgentFolder: job.workspace_key,
          decisionPolicy: 'same_channel',
        });
      },
      releaseSlot: async ({ runId, leaseToken, fencingVersion }) =>
        (await activeLeaseMatches(deps.repository, {
          runId,
          leaseToken,
          fencingVersion,
        })) && releaseRunSlotForPermissionWait({ runId }),
      acquireSlot: async ({ runId, leaseToken, fencingVersion }) =>
        (await activeLeaseMatches(deps.repository, {
          runId,
          leaseToken,
          fencingVersion,
        })) && acquireRunSlotForPermissionWake({ runId }),
      isRunAlive: async ({ runId, leaseToken, fencingVersion }) => {
        const lease = await deps.repository.getActiveRunLease({ runId });
        return Boolean(
          lease &&
          lease.leaseToken === leaseToken &&
          lease.fencingVersion === fencingVersion,
        );
      },
      revalidate: async (input) => {
        const request = await requestForNeed(deps.repository, input);
        if (!request) {
          return {
            kind: 'cancelled',
            reason:
              'The current permission request is unavailable for policy revalidation.',
          };
        }
        return revalidateJobPermissionCurrentPolicy({
          request,
          renderedGrantAtoms: input.renderedGrantAtoms,
          settings: deps.getPermissionRuntimeSettings(),
          toolRepository: deps.getToolRepository(),
          skillRepository: deps.getSkillRepository(),
        });
      },
      persistGrant: async (input) => {
        const request = await requestForNeed(deps.repository, input);
        if (!request)
          throw new Error('Approved permission request is missing.');
        const approvedAtoms = persistentRules(request);
        if (!sameStrings(approvedAtoms, input.grantAtoms)) {
          throw new Error(
            'Approved permission scope no longer matches the card.',
          );
        }
        const applied = await applyPermissionInteractionDecision({
          request,
          sourceAgentFolder: request.sourceAgentFolder,
          decision: persistentDecision(request, input.decidedBy),
          appId: request.appId,
          runId: request.runId,
          runLeaseToken: request.runLeaseToken,
          runLeaseFencingVersion: request.runLeaseFencingVersion,
          toolName: request.toolName,
          requestId: request.requestId,
          ipcDir: await ipcDirForRequest(deps.repository, request),
        });
        if (!applied) {
          throw new Error('Approved permission grant could not be applied.');
        }
      },
      deliverWaiterResponse: (input) =>
        deliverWaiterResponse(deps.repository, input),
      enqueueRunAgain: (input) =>
        deps.enqueueRunAgain({
          idempotencyKey: input.idempotencyKey,
          jobId: input.jobId,
          priorRunId: input.priorRunId,
        }),
    },
    {
      now,
      monotonicMs: deps.monotonicMs ?? (() => uptime() * 1_000),
      hostBootId:
        deps.hostBootId ??
        (() => process.env.GANTRY_HOST_BOOT_ID ?? 'current-host-boot'),
    },
    { maxRows: 10, maxGrantAtomsPerRow: 20 },
    logger,
  ) as JobPermissionDurabilityService & {
    attachRequest(input: {
      request: PermissionApprovalRequest;
      sourceAgentFolder: string;
    }): Promise<boolean>;
  };

  service.attachRequest = async ({ request, sourceAgentFolder }) => {
    if (
      !request.jobId ||
      !request.runId ||
      !request.runLeaseToken ||
      !request.runLeaseFencingVersion ||
      !request.targetJid
    ) {
      return false;
    }
    const grantAtoms = persistentRules(request);
    if (grantAtoms.length === 0) return false;
    const target = deps.resolveCardTarget(request);
    const outcome = await service.attachNeed({
      appId: target.appId,
      jobId: request.jobId,
      sourceAgentFolder,
      conversationId: target.conversationId,
      threadId: target.threadId,
      agentId: target.agentId,
      canonicalIdentity: canonicalJobPermissionNeedIdentity(grantAtoms),
      displayLabel:
        request.displayName?.trim() ||
        request.title?.trim() ||
        request.toolName,
      renderedGrantAtoms: grantAtoms,
      requestSnapshot: durableGrantRequestSnapshot(request),
      waiter: {
        id: `job-permission-waiter:${request.requestId}`,
        requestId: request.requestId,
        runId: request.runId,
        runLeaseToken: request.runLeaseToken,
        runLeaseFencingVersion: request.runLeaseFencingVersion,
      },
    });
    if (outcome.status !== 'asking') {
      const timestamp = now();
      await deliverWaiterResponse(deps.repository, {
        appId: target.appId,
        sourceAgentFolder,
        waiter: {
          id: `job-permission-waiter:${request.requestId}`,
          requestId: request.requestId,
          responseId: `job-permission-short-circuit:${request.requestId}`,
          runId: request.runId,
          runLeaseToken: request.runLeaseToken,
          runLeaseFencingVersion: request.runLeaseFencingVersion,
          state: 'response_pending',
          slotReleased: false,
          responseDeliveredAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        response:
          outcome.status === 'applied'
            ? { kind: 'approved', grantAtoms }
            : outcome.status === 'denied'
              ? { kind: 'denied', reason: outcome.reason }
              : { kind: 'setup_required', reason: outcome.reason },
      });
    }
    return true;
  };
  return service;
}

export async function revalidateJobPermissionCurrentPolicy(input: {
  request: PermissionApprovalRequest;
  renderedGrantAtoms: readonly string[];
  settings: ReturnType<
    JobPermissionDurabilityWiringDeps['getPermissionRuntimeSettings']
  >;
  toolRepository: ToolCatalogRepository | undefined;
  skillRepository: SkillCatalogRepository | undefined;
}): Promise<JobPermissionRevalidationResult> {
  const cancelled = (reason: string): JobPermissionRevalidationResult => ({
    kind: 'cancelled',
    reason,
  });
  const agentSettings = input.settings.agents[input.request.sourceAgentFolder];
  if (agentSettings?.accessPreset === 'locked') {
    return cancelled('The agent is now locked and cannot accept a grant.');
  }
  const toolInput =
    input.request.classifierToolInput ?? input.request.toolInput;
  const protectedCapability = evaluateProtectedCapabilityToolUse(
    input.request.toolName,
    toolInput,
  );
  if (protectedCapability) {
    return cancelled(protectedCapability.reason);
  }
  const yoloMatch = evaluateYoloModeDenylist({
    settings: input.settings.permissions.yoloMode,
    toolName: input.request.toolName,
    toolInput,
  });
  if (yoloMatch) {
    return cancelled(yoloModeDenylistDenyReason(yoloMatch));
  }
  const appId = input.request.appId ?? 'default';
  const agentId =
    input.request.agentId ?? agentIdForFolder(input.request.sourceAgentFolder);
  const semanticCapabilityIds = input.renderedGrantAtoms
    .map(parseSemanticCapabilityRule)
    .filter((id): id is string => Boolean(id));
  let semanticCapabilityDefinitions =
    input.request.semanticCapabilityDefinitions;
  if (semanticCapabilityIds.length > 0) {
    if (!input.toolRepository) {
      return cancelled('The current capability policy is unavailable.');
    }
    const currentPolicy = await Promise.all([
      input.toolRepository.listTools({
        appId: appId as never,
        statuses: ['active'],
      }),
      input.skillRepository?.listEnabledSkillsForAgent({
        appId: appId as never,
        agentId: agentId as never,
      }),
    ])
      .then(([tools, activeSkills]) =>
        resolveAgentToolRuntimePolicyFromSnapshot({
          appId,
          errorSubject: 'Current capability',
          selectedToolDefinitionsByBinding: tools,
          activeSkillDefinitions: activeSkills,
        }),
      )
      .catch(() => null);
    if (!currentPolicy) {
      return cancelled(
        'The current capability policy could not be revalidated.',
      );
    }
    semanticCapabilityDefinitions = Object.fromEntries(
      currentPolicy.semanticCapabilities.map((capability) => [
        capability.capabilityId,
        capability,
      ]),
    );
    const changedCapability = semanticCapabilityIds.find(
      (capabilityId) =>
        canonicalJson(
          input.request.semanticCapabilityDefinitions?.[capabilityId],
        ) !== canonicalJson(semanticCapabilityDefinitions?.[capabilityId]),
    );
    if (changedCapability) {
      return cancelled(
        `Reviewed capability ${changedCapability} changed after the card was rendered.`,
      );
    }
  }
  const currentRequest: PermissionApprovalRequest = {
    ...input.request,
    semanticCapabilityDefinitions,
  };
  const railDecision = evaluatePermissionDeterministicRails({
    request: currentRequest,
    approvedCapabilityIds:
      agentSettings?.capabilities?.map(({ id }) => id) ?? [],
    workspaceRoot: resolveWorkspaceFolderPath(currentRequest.sourceAgentFolder),
    trustedRoots: input.settings.permissions.trustedRoots ?? [],
  });
  if (railDecision?.railOutcome === 'deny') {
    return cancelled(
      railDecision.reason ?? 'Current permission policy denied.',
    );
  }
  const grantAtoms = persistentRules(currentRequest);
  if (grantAtoms.length === 0) {
    return cancelled('The approved scope is no longer grantable.');
  }
  return grantAtoms.every((atom) => input.renderedGrantAtoms.includes(atom))
    ? { kind: 'approved', grantAtoms }
    : {
        kind: 'reask',
        grantAtoms,
        reason: 'Permission scope changed and must be shown again.',
      };
}

async function activeLeaseMatches(
  repository: WorkerCoordinationRepository,
  input: { runId: string; leaseToken: string; fencingVersion: number },
): Promise<boolean> {
  const lease = await repository.getActiveRunLease({ runId: input.runId });
  return Boolean(
    lease &&
    lease.leaseToken === input.leaseToken &&
    lease.fencingVersion === input.fencingVersion,
  );
}

function persistentDecision(
  request: PermissionApprovalRequest,
  decidedBy: string,
) {
  return {
    approved: true,
    mode: 'allow_persistent_rule' as const,
    decidedBy,
    source: 'human_persistent' as const,
    repeatableForFutureRuns: true,
    updatedPermissions: request.suggestions,
    decisionClassification: 'user_permanent' as const,
  };
}

function durableGrantRequestSnapshot(
  request: PermissionApprovalRequest,
): PermissionApprovalRequest {
  return {
    requestId: request.requestId,
    sourceAgentFolder: request.sourceAgentFolder,
    toolName: request.toolName,
    ...(request.appId ? { appId: request.appId } : {}),
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.personId ? { personId: request.personId } : {}),
    ...(request.runHandle ? { runHandle: request.runHandle } : {}),
    ...(request.jobId ? { jobId: request.jobId } : {}),
    ...(request.setupFingerprint
      ? { setupFingerprint: request.setupFingerprint }
      : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.targetJid ? { targetJid: request.targetJid } : {}),
    ...(request.threadId ? { threadId: request.threadId } : {}),
    ...(request.toolInput
      ? { toolInput: structuredClone(request.toolInput) }
      : {}),
    ...(request.classifierToolInput
      ? { classifierToolInput: structuredClone(request.classifierToolInput) }
      : request.toolInput
        ? { classifierToolInput: structuredClone(request.toolInput) }
        : {}),
    ...(request.toolInputSanitized
      ? { toolInputSanitized: request.toolInputSanitized }
      : {}),
    ...(request.toolInputSanitizedPaths
      ? { toolInputSanitizedPaths: [...request.toolInputSanitizedPaths] }
      : {}),
    ...(request.semanticCapabilityDefinitions
      ? {
          semanticCapabilityDefinitions: structuredClone(
            request.semanticCapabilityDefinitions,
          ),
        }
      : {}),
    ...(request.suggestions
      ? { suggestions: structuredClone(request.suggestions) }
      : {}),
  };
}

async function requestForNeed(
  repository: WorkerCoordinationRepository,
  input: { appId: string; jobId: string; needId: string },
): Promise<PermissionApprovalRequest | null> {
  const state = await (
    repository as WorkerCoordinationRepository &
      JobPermissionDurabilityRepository
  ).getJobPermissionState({ appId: input.appId, jobId: input.jobId });
  const need = state?.needs.find((candidate) => candidate.id === input.needId);
  for (const waiter of need?.waiters ?? []) {
    const pending = await repository.findPendingInteractionByRequest({
      appId: input.appId,
      kind: 'permission',
      sourceAgentFolder: need!.sourceAgentFolder,
      requestId: waiter.requestId,
    });
    const request = permissionRequest(pending?.payload.request);
    if (request) return request;
  }
  for (const snapshot of need?.requestSnapshots ?? []) {
    const request = permissionRequest(snapshot.request);
    if (request) return request;
  }
  return null;
}

async function ipcDirForRequest(
  repository: WorkerCoordinationRepository,
  request: PermissionApprovalRequest,
): Promise<string | undefined> {
  const pending = await repository.findPendingInteractionByRequest({
    appId: request.appId ?? 'default',
    kind: 'permission',
    sourceAgentFolder: request.sourceAgentFolder,
    requestId: request.requestId,
  });
  const base = stringValue(pending?.callbackRoute?.ipcBaseDir);
  return base ? `${base}/${request.sourceAgentFolder}` : undefined;
}

async function deliverWaiterResponse(
  repository: WorkerCoordinationRepository,
  input: {
    appId: string;
    sourceAgentFolder: string;
    waiter: JobPermissionWaiter;
    response:
      | { kind: 'approved'; grantAtoms: readonly string[] }
      | { kind: 'denied'; reason: string }
      | { kind: 'policy_changed'; reason: string }
      | { kind: 'setup_required'; reason: string };
  },
): Promise<void> {
  const pending = await repository.findPendingInteractionByRequest({
    appId: input.appId,
    kind: 'permission',
    sourceAgentFolder: input.sourceAgentFolder,
    requestId: input.waiter.requestId,
  });
  if (!pending) {
    throw new Error('Pending job permission waiter is unavailable.');
  }
  const request = permissionRequest(pending.payload.request);
  if (!request) throw new Error('Pending job permission request is malformed.');
  const approved = input.response.kind === 'approved';
  const responseReason =
    input.response.kind === 'approved' ? null : input.response.reason;
  const permissionOutcome = jobPermissionOutcomeForResponse({
    request,
    responseKind: input.response.kind,
  });
  const decision = approved
    ? {
        ...persistentDecision(request, 'job_permission_reconciler'),
        reason: null,
        updatedPermissions: request.suggestions ?? null,
      }
    : {
        approved: false,
        mode: 'cancel' as const,
        decidedBy: 'job_permission_reconciler',
        reason: responseReason,
        updatedPermissions: null,
        ...(input.response.kind === 'denied'
          ? { decisionClassification: 'user_reject' as const }
          : {}),
      };
  const resolution = {
    approved,
    mode: decision.mode,
    reason: decision.reason,
    updatedPermissions: decision.updatedPermissions,
    ...('decisionClassification' in decision
      ? { decisionClassification: decision.decisionClassification }
      : {}),
    jobPermissionOutcome: permissionOutcome.outcome,
    ...(permissionOutcome.unprojectedAccessIdentity
      ? {
          unprojectedAccessIdentity:
            permissionOutcome.unprojectedAccessIdentity,
        }
      : {}),
  };
  const wrote = writeResolvedInteractionResponse({
    kind: 'permission',
    requestId: request.requestId,
    sourceAgentFolder: request.sourceAgentFolder,
    status: approved ? 'resolved' : 'cancelled',
    resolution,
    approverRef: decision.decidedBy,
    callbackRoute: pending.callbackRoute,
  });
  if (!wrote)
    throw new Error('Signed permission response could not be written.');
  const outcome = await resolvePendingInteractionRecordOutcome({
    kind: 'permission',
    sourceAgentFolder: request.sourceAgentFolder,
    requestId: request.requestId,
    appId: request.appId,
    runId: request.runId,
    status: approved ? 'resolved' : 'cancelled',
    resolution,
    approverRef: decision.decidedBy,
  });
  if (outcome !== 'resolved') {
    throw new Error(`Permission response settlement ${outcome}.`);
  }
}

function permissionRequest(value: unknown): PermissionApprovalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Partial<PermissionApprovalRequest>;
  return typeof request.requestId === 'string' &&
    typeof request.sourceAgentFolder === 'string' &&
    typeof request.toolName === 'string'
    ? (structuredClone(request) as PermissionApprovalRequest)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}
