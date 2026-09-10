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
import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import type { PermissionClassifierFailureCode } from '@core/runtime/permission-classifier.js';
import type { PermissionMode } from '@core/shared/permission-mode.js';
import type { YoloModeSettings } from '@core/shared/yolo-mode-policy.js';
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
  targetJid?: string;
  workspaceRoot: string;
  command?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  attachmentOpenIds?: { wellFormed: boolean; count: number };
  trustedRoots: string[];
  yoloMode?: YoloModeSettings;
  classifierVerdict: {
    status?: PermissionClassifierStatus;
    failureCode?: PermissionClassifierFailureCode;
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
  sendMessage?: (
    jid: string,
    text: string,
    options?: { threadId?: string; providerAccountId?: string },
  ) => Promise<void>;
  publishRuntimeEvent?: (() => Promise<void>) | false;
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
  decisionReason?: string;
  sendMessage: NonNullable<TapBudgetFixture['sendMessage']>;
  publishRuntimeEvent: NonNullable<TapBudgetFixture['publishRuntimeEvent']>;
}> {
  fs.mkdirSync(fixture.workspaceRoot, { recursive: true });
  let taps = 0;
  let decisionReason: string | undefined;
  const sendMessage = fixture.sendMessage ?? (async () => undefined);
  const publishRuntimeEvent =
    fixture.publishRuntimeEvent === false
      ? undefined
      : (fixture.publishRuntimeEvent ?? (async () => undefined));
  const responseKeyId = fixture.hostJobId
    ? `tap-budget-${fixture.hostJobId}`
    : undefined;
  const targetJid = fixture.targetJid ?? 'tap-budget:conversation';
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
          ? { responseKeyId, targetJid }
          : fixture.targetJid
            ? { targetJid }
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
                [targetJid]: {
                  name: 'tap budget',
                  folder: 'main_agent',
                  trigger: '@gantry',
                  added_at: '2026-09-04',
                  agentConfig: { permissionMode: fixture.permissionMode },
                },
              } as never)
            : {},
        requestPermissionApproval: async (request) => {
          taps += 1;
          decisionReason = request.decisionReason;
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
            status:
              fixture.classifierVerdict.status ??
              PermissionClassifierStatus.Answered,
            ...fixture.classifierVerdict,
            latencyMs: 1,
          })),
        sendMessage,
        publishRuntimeEvent,
        getPermissionRuntimeSettings: () => ({
          agents: {
            main_agent: { permissionMode: fixture.permissionMode },
          },
          permissions: {
            autoMode: {},
            trustedRoots: fixture.trustedRoots,
            ...(fixture.yoloMode ? { yoloMode: fixture.yoloMode } : {}),
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
  return Object.defineProperties(
    {
      taps,
      decidedBy: decision.decidedBy,
      source: decision.source,
      railProvenance: decision.railProvenance ?? null,
    },
    {
      sendMessage: { value: sendMessage },
      publishRuntimeEvent: {
        value: publishRuntimeEvent ?? (async () => undefined),
      },
      decisionReason: { value: decisionReason },
    },
  );
}

export const TAP_BUDGET_WORKSPACE_ROOT =
  resolveWorkspaceFolderPath('main_agent');

interface ExactMemoryReplay {
  taps: number[];
  claimedCodes: PermissionRememberCode[];
  applications: PermissionApprovalDecision['mode'][];
  decisions: PermissionApprovalDecision[];
  rows: PermissionDecisionMemoryRow[];
}

async function replayExactMemorySequence(
  scenario: string,
  steps: Array<{ command: string; rememberCode?: PermissionRememberCode }>,
  options: {
    classifierConsult?: () => Promise<
      TapBudgetFixture['classifierVerdict'] & { latencyMs: number }
    >;
    sendMessage?: TapBudgetFixture['sendMessage'];
  } = {},
): Promise<ExactMemoryReplay> {
  const rows: PermissionDecisionMemoryRow[] = [];
  const decisionMemory = inMemoryDecisionMemory(rows);
  const durability = inMemoryPermissionDurability();
  const claimedCodes: PermissionRememberCode[] = [];
  const applications: PermissionApprovalDecision['mode'][] = [];
  const decisions: PermissionApprovalDecision[] = [];
  const taps: number[] = [];
  configurePendingInteractionDurability({
    repository: durability.repository as never,
  });
  try {
    for (const [run, step] of steps.entries()) {
      let runTaps = 0;
      const rememberCode = step.rememberCode;
      const decision = await resolvePermissionIpcDecision({
        request: {
          requestId: `${scenario}-remember-${run}`,
          appId: 'default',
          targetJid: 'tap-budget:conversation',
          sourceAgentFolder: 'main_agent',
          personId: 'person-one',
          toolName: 'RunCommand',
          toolInput: { command: step.command },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: () => ({}),
          requestPermissionApproval: async (
            request,
            facts?: PermissionRememberPromptFacts,
          ) => {
            runTaps += 1;
            if (!rememberCode) {
              throw new Error(`${scenario} unexpectedly requested approval`);
            }
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
                  decisionOptions: [rememberCode],
                });
                const claimed = await claimPermissionInteractionCallback({
                  scope: {
                    appId: 'default',
                    sourceAgentFolder: 'main_agent',
                    interactionId: request.requestId,
                  },
                  mode: rememberCode,
                  approverRef: 'person-one',
                  matchKind: 'individual',
                });
                if (claimed.status !== 'claimed') {
                  throw new Error(`${scenario} permission claim failed`);
                }
                claimedCodes.push(claimed.persistedClaim.intent.mode);
                const recovered =
                  await replayPersistedPermissionDecisionForRequest({
                    appId: 'default',
                    sourceAgentFolder: 'main_agent',
                    requestId: request.requestId,
                  });
                if (!recovered) {
                  throw new Error(`${scenario} decision recovery failed`);
                }
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
              throw new Error(
                `${scenario} durable interaction did not resolve`,
              );
            }
            applications.push(interaction.decision.mode);
            return permissionDecisionResult(interaction.decision);
          },
          classifierConsult:
            options.classifierConsult ??
            (async () => ({
              status: PermissionClassifierStatus.Answered,
              risk_level: 'high',
              reason: 'Remember this exact command.',
              latencyMs: 1,
            })),
          sendMessage: options.sendMessage ?? (async () => undefined),
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
      decisions.push(decision);
      taps.push(runTaps);
    }
  } finally {
    configurePendingInteractionDurability(null);
  }
  return { taps, claimedCodes, applications, decisions, rows };
}

export async function replayRememberedExactAllow(
  options?: Parameters<typeof replayExactMemorySequence>[2],
): Promise<{
  taps: number[];
  claimedCodes: PermissionRememberCode[];
  applications: PermissionApprovalDecision['mode'][];
  activeRows: number;
}> {
  const command = `cd ${TAP_BUDGET_WORKSPACE_ROOT} && ls && git log`;
  const replay = await replayExactMemorySequence(
    's2',
    [{ command, rememberCode: 'remember_allow_exact' }, { command }],
    options,
  );
  if (replay.decisions.some((decision) => !decision.approved)) {
    throw new Error('S2 permission was not allowed');
  }
  return {
    taps: replay.taps,
    claimedCodes: replay.claimedCodes,
    applications: replay.applications,
    activeRows: replay.rows.length,
  };
}

export function replayDestructiveExactMemory(
  options?: Parameters<typeof replayExactMemorySequence>[2],
): Promise<ExactMemoryReplay> {
  return replayExactMemorySequence(
    's4',
    [
      { command: 'rm -rf build', rememberCode: 'remember_allow_exact' },
      { command: 'rm -rf build' },
      { command: 'rm -rf dist', rememberCode: 'remember_deny_exact' },
      { command: 'rm -rf dist' },
    ],
    options,
  );
}

export async function replayRememberedJobProjection(
  options: {
    classifierConsult?: () => Promise<
      TapBudgetFixture['classifierVerdict'] & { latencyMs: number }
    >;
  } = {},
): Promise<{
  chatTaps: number;
  jobTaps: number[];
  railBumpTaps: number;
  revoked: 'applied' | 'already_revoked' | 'not_found';
  decisions: PermissionApprovalDecision[];
  railBumpDecision: PermissionApprovalDecision;
}> {
  const command = `cd ${TAP_BUDGET_WORKSPACE_ROOT} && ls && git log`;
  const chat = await replayExactMemorySequence('s5', [
    { command, rememberCode: 'remember_allow_exact' },
  ]);
  const rows = chat.rows;
  const memory = inMemoryDecisionMemory(rows);
  const replayJob = async (requestId: string, jobCommand: string) => {
    let taps = 0;
    const responseKeyId = `tap-budget-${requestId}`;
    registerWorkerPermissionRunRestriction({
      sourceAgentFolder: 'main_agent',
      responseKeyId,
      hideAuthorityTools: false,
      runKind: 'scheduled',
      jobId: 'job-s5',
      runId: `run-${requestId}`,
    });
    try {
      const decision = await resolvePermissionIpcDecision({
        request: {
          requestId,
          appId: 'default',
          responseKeyId,
          targetJid: 'tap-budget:conversation',
          sourceAgentFolder: 'main_agent',
          toolName: 'RunCommand',
          toolInput: { command: jobCommand },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: () => ({
            'tap-budget:conversation': {
              name: 'tap budget',
              folder: 'main_agent',
              trigger: '@gantry',
              added_at: '2026-09-04',
              agentConfig: { permissionMode: 'auto' },
            },
          }),
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
            options.classifierConsult ??
            (async () => ({
              risk_level: 'high',
              reason: 'Ask the person.',
              latencyMs: 1,
            })),
          publishRuntimeEvent: async () => undefined,
          getPermissionDecisionMemoryRepository: () => memory,
          opsRepository: {
            getJobById: async () => ({
              id: 'job-s5',
              execution_context: { personId: 'person-one' },
            }),
          },
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
      return { taps, decision };
    } finally {
      unregisterPermissionRunRestriction({
        sourceAgentFolder: 'main_agent',
        responseKeyId,
      });
    }
  };

  const projected = await replayJob('s5-projected', command);
  const nearMiss = await replayJob('s5-near-miss', `${command} --oneline`);
  const currentRailVersion = rows[0]!.railVersion;
  rows[0]!.railVersion = currentRailVersion + 1;
  const railBump = await replayJob('s5-rail-bump', command);
  rows[0]!.railVersion = currentRailVersion;
  const revoked = await memory.revokeById({
    appId: 'default',
    agentFolder: 'main_agent',
    actingPersonId: 'person-one',
    recordId: rows[0]!.id,
    nowIso: '2026-09-09T00:00:00.000Z',
  });
  const afterForget = await replayJob('s5-after-forget', command);

  return {
    chatTaps: chat.taps[0]!,
    jobTaps: [projected.taps, nearMiss.taps, afterForget.taps],
    railBumpTaps: railBump.taps,
    revoked,
    decisions: [projected.decision, nearMiss.decision, afterForget.decision],
    railBumpDecision: railBump.decision,
  };
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
          row.scopeKey === input.scopeKey &&
          !row.revokedAt,
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
              row.railVersion === input.railVersion &&
              !row.revokedAt,
          ),
        )
        .find(Boolean) ?? null,
    revokeById: async (input) => {
      const row = rows.find(
        (candidate) =>
          candidate.id === input.recordId &&
          candidate.appId === input.appId &&
          candidate.agentFolder === input.agentFolder &&
          candidate.actingPersonId === input.actingPersonId,
      );
      if (!row) return 'not_found';
      if (row.revokedAt) return 'already_revoked';
      row.revokedAt = input.nowIso;
      return 'applied';
    },
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
