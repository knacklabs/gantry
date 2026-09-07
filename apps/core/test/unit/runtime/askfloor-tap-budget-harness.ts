import fs from 'node:fs';

import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  replayPersistedPermissionDecisionForRequest,
} from '@core/application/interactions/pending-interaction-durability.js';
import { runDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';
import {
  parsePermissionRememberContext,
  type PermissionRememberPromptFacts,
} from '@core/application/permissions/human-decision-learning.js';
import type {
  PermissionDecisionMemoryRepository,
  PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';
import type {
  PendingInteraction,
  PermissionPromptGroup,
} from '@core/domain/ports/worker-coordination.js';
import type {
  PermissionApprovalDecision,
  PermissionCallbackClaim,
  PermissionRememberCode,
} from '@core/domain/types.js';
import type { PermissionDecisionSource } from '@core/domain/types.js';
import type { RailProvenance } from '@core/domain/permission-lane.js';
import type { PermissionMode } from '@core/shared/permission-mode.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import {
  learnPermissionRememberSettlement,
  persistPermissionRememberPromptContext,
} from '@core/runtime/permission-remember-settlement.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { unregisterPermissionRunRestriction } from '@core/runtime/permission-decision-coordinator.js';
import { permissionDecisionResult } from '../channels/permission-approval-result-helpers.js';

export interface TapBudgetFixture {
  permissionMode: PermissionMode;
  hostJobId?: string;
  workspaceRoot: string;
  command?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  attachmentOpenIds?: { wellFormed: boolean; count: number };
  trustedRoots: string[];
  classifierVerdict: {
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    risk_category?:
      | 'destructive'
      | 'privileged'
      | 'secret'
      | 'network'
      | 'filesystem'
      | 'benign';
    reason: string;
  };
  classifierConsult?: () => Promise<
    TapBudgetFixture['classifierVerdict'] & { latencyMs: number }
  >;
}

export async function assertLlmConsultNotInvoked(): Promise<never> {
  throw new Error('Expected the LLM classifier consult not to be invoked.');
}

export async function replayPermissionRequest(
  fixture: TapBudgetFixture,
): Promise<{
  taps: number;
  decidedBy: PermissionApprovalDecision['decidedBy'];
  source: PermissionDecisionSource;
  railProvenance: RailProvenance | null;
}> {
  fs.mkdirSync(fixture.workspaceRoot, { recursive: true });
  let taps = 0;
  const responseKeyId = fixture.hostJobId
    ? `tap-budget-${fixture.hostJobId}`
    : undefined;
  if (responseKeyId) {
    registerWorkerPermissionRunRestriction({
      sourceAgentFolder: 'main_agent',
      responseKeyId,
      hideAuthorityTools: false,
      runKind: 'scheduled',
      jobId: fixture.hostJobId!,
      runId: `run-${fixture.hostJobId}`,
    });
  }
  let decision: PermissionApprovalDecision;
  try {
    decision = await resolvePermissionIpcDecision({
      request: {
        requestId: `tap-budget-${fixture.command ?? fixture.toolName}`,
        ...(responseKeyId
          ? { responseKeyId, targetJid: 'tap-budget:conversation' }
          : {}),
        sourceAgentFolder: 'main_agent',
        toolName: fixture.toolName ?? 'RunCommand',
        toolInput: fixture.toolInput ?? { command: fixture.command },
        ...(fixture.attachmentOpenIds
          ? { attachmentOpenIds: fixture.attachmentOpenIds }
          : {}),
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () =>
          responseKeyId
            ? ({
                'tap-budget:conversation': {
                  name: 'tap budget',
                  folder: 'main_agent',
                  trigger: '@gantry',
                  added_at: '2026-09-04',
                  agentConfig: { permissionMode: fixture.permissionMode },
                },
              } as never)
            : {},
        requestPermissionApproval: async () => {
          taps += 1;
          return permissionDecisionResult({
            approved: false,
            mode: 'cancel',
            decidedBy: 'owner',
            source: 'user',
          });
        },
        classifierConsult:
          fixture.classifierConsult ??
          (async () => ({
            ...fixture.classifierVerdict,
            latencyMs: 1,
          })),
        publishRuntimeEvent: async () => undefined,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: { permissionMode: fixture.permissionMode },
          },
          permissions: {
            autoMode: {},
            trustedRoots: fixture.trustedRoots,
          },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });
  } finally {
    if (responseKeyId) {
      unregisterPermissionRunRestriction({
        sourceAgentFolder: 'main_agent',
        responseKeyId,
      });
    }
  }
  if (!decision.source) {
    throw new Error('Replay decision is missing canonical provenance.');
  }
  return {
    taps,
    decidedBy: decision.decidedBy,
    source: decision.source,
    railProvenance: decision.railProvenance ?? null,
  };
}

export const TAP_BUDGET_WORKSPACE_ROOT =
  resolveWorkspaceFolderPath('main_agent');

export async function replayRememberedExactAllow(): Promise<{
  taps: number[];
  claimedCodes: PermissionRememberCode[];
  applications: PermissionApprovalDecision['mode'][];
  activeRows: number;
}> {
  const rows: PermissionDecisionMemoryRow[] = [];
  const decisionMemory = inMemoryDecisionMemory(rows);
  const durability = inMemoryPermissionDurability();
  const claimedCodes: PermissionRememberCode[] = [];
  const applications: PermissionApprovalDecision['mode'][] = [];
  const taps: number[] = [];
  configurePendingInteractionDurability({
    repository: durability.repository as never,
  });
  try {
    for (let run = 0; run < 2; run += 1) {
      let runTaps = 0;
      const decision = await resolvePermissionIpcDecision({
        request: {
          requestId: `s2-remember-${run}`,
          appId: 'default',
          sourceAgentFolder: 'main_agent',
          personId: 'person-one',
          toolName: 'RunCommand',
          toolInput: {
            command: `cd ${TAP_BUDGET_WORKSPACE_ROOT} && ls && git log`,
          },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: () => ({}),
          requestPermissionApproval: async (
            request,
            facts?: PermissionRememberPromptFacts,
          ) => {
            runTaps += 1;
            const interaction = await runDurablePermissionInteraction({
              request,
              sourceAgentFolder: 'main_agent',
              beforePrompt: async () => {
                if (!facts) throw new Error('Missing remember prompt facts');
                await persistPermissionRememberPromptContext({
                  request,
                  sourceAgentFolder: 'main_agent',
                  facts,
                  personId: 'person-one',
                });
              },
              prompt: async () => {
                await bindPendingPermissionInteractionMessage({
                  request,
                  decisionOptions: ['remember_allow_exact'],
                });
                const claimed = await claimPermissionInteractionCallback({
                  scope: {
                    appId: 'default',
                    sourceAgentFolder: 'main_agent',
                    interactionId: request.requestId,
                  },
                  mode: 'remember_allow_exact',
                  approverRef: 'person-one',
                  matchKind: 'individual',
                });
                if (claimed.status !== 'claimed') {
                  throw new Error('S2 permission claim failed');
                }
                claimedCodes.push(claimed.persistedClaim.intent.mode);
                const recovered =
                  await replayPersistedPermissionDecisionForRequest({
                    appId: 'default',
                    sourceAgentFolder: 'main_agent',
                    requestId: request.requestId,
                  });
                if (!recovered) throw new Error('S2 decision recovery failed');
                return permissionDecisionResult(recovered);
              },
              afterDecision: async (current) => {
                await learnPermissionRememberSettlement({
                  claim: current.permissionCallbackClaim,
                  repository: decisionMemory,
                  warn: () => undefined,
                });
              },
            });
            if (interaction.kind !== 'decision' || !interaction.resolved) {
              throw new Error('S2 durable interaction did not resolve');
            }
            applications.push(interaction.decision.mode);
            return permissionDecisionResult(interaction.decision);
          },
          classifierConsult: async () => ({
            risk_level: 'high',
            reason: 'Remember this exact command.',
            latencyMs: 1,
          }),
          publishRuntimeEvent: async () => undefined,
          getPermissionDecisionMemoryRepository: () => decisionMemory,
          getPermissionRuntimeSettings: () => ({
            agents: { main_agent: { permissionMode: 'auto' } },
            permissions: {
              autoMode: {},
              trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
            },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      });
      if (!decision.approved) throw new Error('S2 permission was not allowed');
      taps.push(runTaps);
    }
  } finally {
    configurePendingInteractionDurability(null);
  }
  return { taps, claimedCodes, applications, activeRows: rows.length };
}

export function inMemoryDecisionMemory(
  rows: PermissionDecisionMemoryRow[],
): PermissionDecisionMemoryRepository {
  return {
    getClassifierVerdict: async () => null,
    putClassifierVerdict: async () => undefined,
    put: async () => undefined,
    get: async () => null,
    list: async () => [],
    revoke: async () => false,
    putHumanDecision: async (input) => {
      const current = rows.find(
        (row) =>
          row.appId === input.appId &&
          row.agentFolder === input.agentFolder &&
          row.actingPersonId === input.actingPersonId &&
          row.scope === input.scope &&
          row.scopeKey === input.scopeKey,
      );
      if (current) return { id: current.id, status: 'refreshed' };
      rows.push({
        id: input.id,
        appId: input.appId,
        agentFolder: input.agentFolder,
        kind: 'human_decision',
        lookupIdentity: input.scopeKey,
        decision: input.outcome,
        outcome: input.outcome,
        scope: input.scope,
        scopeKey: input.scopeKey,
        actingPersonId: input.actingPersonId,
        actingPersonLabel: input.actingPersonLabel,
        reason: input.reason,
        principal: input.canonicalTool,
        effectHash: input.effectHash,
        effectSchemaVersion: input.effectSchemaVersion,
        railVersion: input.railVersion,
        provenance: input.provenance,
        createdAt: input.nowIso,
      });
      return { id: input.id, status: 'inserted' };
    },
    listHumanDecisions: async (input) =>
      rows.filter(
        (row) =>
          row.appId === input.appId &&
          row.agentFolder === input.agentFolder &&
          row.actingPersonId === input.actingPersonId,
      ),
    findHumanDecision: async (input) =>
      input.candidates
        .map((candidate) =>
          rows.find(
            (row) =>
              row.appId === input.appId &&
              row.agentFolder === input.agentFolder &&
              row.actingPersonId === input.actingPersonId &&
              row.scope === candidate.scope &&
              row.scopeKey === candidate.scopeKey &&
              row.railVersion === input.railVersion,
          ),
        )
        .find(Boolean) ?? null,
    revokeById: async () => 'not_found',
    countExactAllowsByTool: async () => ({}),
  };
}

export function inMemoryPermissionDurability(): {
  repository: Record<string, unknown>;
  applications: Record<string, unknown>[];
  member: () => PendingInteraction | null;
} {
  const members: PendingInteraction[] = [];
  let group: PermissionPromptGroup | null = null;
  const applications: Record<string, unknown>[] = [];
  return {
    applications,
    member: () => members[0] ?? null,
    repository: {
      createPendingInteraction: async (input: any) => {
        const member = {
          ...input,
          runId: input.runId ?? null,
          sourceAgentFolder: input.sourceAgentFolder ?? null,
          requestId: input.requestId ?? null,
          runLeaseToken: input.runLeaseToken ?? null,
          runLeaseFencingVersion: input.runLeaseFencingVersion ?? null,
          envelopeId: null,
          memberIndex: null,
          status: 'pending',
          approverRef: null,
          resolution: null,
          createdAt: '2026-09-07T00:00:00.000Z',
          resolvedAt: null,
        };
        members.push(member);
        return member;
      },
      updatePendingInteractionPayload: async (input: any) => {
        const member = members.find(
          (candidate) => candidate.idempotencyKey === input.idempotencyKey,
        );
        if (!member) return false;
        const payload = input.update(member.payload);
        if (!payload) return false;
        member.payload = payload;
        return true;
      },
      bindPendingPermissionPrompt: async (input: any) => {
        const boundMembers = input.members.map((candidate: any) =>
          members.find(
            (member) => member.idempotencyKey === candidate.idempotencyKey,
          ),
        );
        if (
          !boundMembers.every((member): member is PendingInteraction =>
            Boolean(member),
          )
        )
          return null;
        if (input.matchKind === 'batch') {
          for (const member of boundMembers) {
            const context = parsePermissionRememberContext(
              member.payload.rememberContext,
            );
            if (context) {
              member.payload = {
                ...member.payload,
                rememberContext: { ...context, eligible: false },
              };
            }
          }
        }
        group = {
          prompt: {
            ...input,
            parentEnvelopeId: null,
            memberCount: boundMembers.length,
            fullView: input.fullView ?? null,
            externalPromptProvider: input.externalPromptProvider ?? null,
            externalPromptConversationId:
              input.externalPromptConversationId ?? null,
            externalPromptMessageId: input.externalPromptMessageId ?? null,
            externalPromptThreadId: input.externalPromptThreadId ?? null,
            claim: null,
            settlementState: 'open',
            settledAt: null,
            createdAt: '2026-09-07T00:00:00.000Z',
            updatedAt: '2026-09-07T00:00:00.000Z',
          },
          members: boundMembers,
        };
        return group;
      },
      claimPendingPermissionCallback: async (input: {
        claim: PermissionCallbackClaim;
      }) => {
        if (!group || group.prompt.claim) return null;
        group.prompt.claim = input.claim;
        group.prompt.settlementState = 'claimed';
        return group;
      },
      findPendingPermissionPrompt: async () => group,
      findPendingPermissionPromptByMember: async () => group,
      getActiveRunLease: async (input: { runId: string }) =>
        members[0]?.runId === input.runId && members[0].runLeaseToken
          ? {
              runId: input.runId,
              jobId: null,
              workerInstanceId: 'worker-one',
              leaseToken: members[0].runLeaseToken,
              fencingVersion: members[0].runLeaseFencingVersion ?? 1,
              status: 'active',
              claimedAt: '2026-09-07T00:00:00.000Z',
              expiresAt: '2026-09-08T00:00:00.000Z',
              heartbeatAt: '2026-09-07T00:00:00.000Z',
            }
          : null,
      createTransientGrant: async (input: Record<string, unknown>) => {
        applications.push(input);
        return true;
      },
      resolvePendingInteraction: async (input: any) => {
        if (!members[0] || !group) return false;
        members[0].status = input.status;
        members[0].resolution = input.resolution;
        group.prompt.settlementState = 'settled';
        return true;
      },
      releasePendingPermissionCallback: async () => true,
      settlePendingPermissionCallback: async () => true,
    },
  };
}
