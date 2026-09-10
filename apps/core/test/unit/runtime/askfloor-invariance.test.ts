import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  createInlineCoreTools,
  wireInlineAgentLoopTools,
} from '@core/app/bootstrap/inline-agent-loop-tools.js';
import {
  JUDGE_OFFLINE_NOTICE,
  JUDGE_OFFLINE_REASON,
} from '@core/application/permissions/permission-judge-outage-latch.js';
import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import type { PermissionApprovalDecision } from '@core/domain/types.js';
import { FAMILY_RULE_RAIL_HIT_REASON } from '@core/runtime/permission-decision-coordinator.js';
import type { PermissionClassifierFailureCode } from '@core/runtime/permission-classifier.js';
import { judgeOutageLatch } from '@core/runtime/permission-judge-outage.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { evaluateNeutralToolPreChecks } from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';
import { permissionDecisionResult } from '../channels/permission-approval-result-helpers.js';
import {
  replayPermissionRequest,
  replayRememberedJobProjection,
  TAP_BUDGET_WORKSPACE_ROOT,
  type TapBudgetFixture,
} from './askfloor-tap-budget-harness.js';

const FAILURE_CODES = [
  'llm_unconfigured',
  'timeout',
  'model_resolution_failure',
  'query_error',
  'parse_failure',
  'validation_failure',
  'wiring_missing',
] as const satisfies readonly PermissionClassifierFailureCode[];

const ANSWERED_VERDICT = {
  status: PermissionClassifierStatus.Answered,
  risk_level: 'high' as const,
  risk_category: 'network' as const,
  reason: 'The judge requires approval.',
};

const CARD = {
  taps: 1,
  approved: false,
  mode: 'cancel',
  decidedBy: 'owner',
  source: 'user',
  railProvenance: null,
  decisionReason: null,
} as const;

const ANSWERED_CARD = {
  ...CARD,
  decisionReason: 'The judge requires approval.',
} as const;

const OFFLINE_CARD = {
  ...CARD,
  decisionReason: JUDGE_OFFLINE_REASON,
} as const;

const FIND_RAIL_CARD = {
  ...CARD,
  decisionReason:
    'Shell input is unsupported: Bash meta-executor find is not supported for persistent approval.',
} as const;

const STRICT_CARD = {
  ...CARD,
  decisionReason: 'No approved capability boundary covers this action.',
} as const;

const fixtureBase = {
  workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
  trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
};

type PermissionTuple = {
  taps: number;
  approved: boolean;
  mode: PermissionApprovalDecision['mode'];
  decidedBy: PermissionApprovalDecision['decidedBy'];
  source: PermissionApprovalDecision['source'];
  railProvenance: PermissionApprovalDecision['railProvenance'] | null;
  decisionReason: string | null;
};

function permissionTuple(
  result: Awaited<ReturnType<typeof replayPermissionRequest>>,
): PermissionTuple {
  return {
    taps: result.taps,
    approved: result.approved,
    mode: result.mode,
    decidedBy: result.decidedBy,
    source: result.source,
    railProvenance: result.railProvenance,
    decisionReason: result.decisionReason ?? null,
  };
}

function decisionTuple(
  decision: PermissionApprovalDecision,
  decisionReason?: string,
): Omit<PermissionTuple, 'taps'> {
  return {
    approved: decision.approved,
    mode: decision.mode,
    decidedBy: decision.decidedBy,
    source: decision.source,
    railProvenance: decision.railProvenance ?? null,
    decisionReason: decisionReason ?? null,
  };
}

function projectionTuples(
  replay: Awaited<ReturnType<typeof replayRememberedJobProjection>>,
) {
  return {
    chatTaps: replay.chatTaps,
    jobTaps: replay.jobTaps,
    railBumpTaps: replay.railBumpTaps,
    revoked: replay.revoked,
    decisions: replay.decisions.map((decision, index) =>
      decisionTuple(decision, replay.decisionReasons[index]),
    ),
    railBumpDecision: decisionTuple(
      replay.railBumpDecision,
      replay.railBumpReason,
    ),
  };
}

function unavailableVerdict(failureCode: PermissionClassifierFailureCode) {
  return {
    status: PermissionClassifierStatus.Unavailable,
    risk_level: 'high' as const,
    risk_category: 'network' as const,
    reason: `Classifier unavailable (${failureCode}); ask the user.`,
    failureCode,
  };
}

async function replayFixture(
  request: Omit<
    TapBudgetFixture,
    keyof typeof fixtureBase | 'classifierVerdict'
  >,
  failureCode?: PermissionClassifierFailureCode,
) {
  judgeOutageLatch.clearAll();
  const notices: string[] = [];
  const result = await replayPermissionRequest({
    ...fixtureBase,
    ...request,
    classifierVerdict: failureCode
      ? unavailableVerdict(failureCode)
      : ANSWERED_VERDICT,
    sendMessage: async (_jid, text) => {
      notices.push(text);
    },
    ...(failureCode === 'wiring_missing' ? { publishRuntimeEvent: false } : {}),
  });
  judgeOutageLatch.clearAll();
  return { tuple: permissionTuple(result), notices };
}

async function replayFamilyRail(failureCode?: PermissionClassifierFailureCode) {
  judgeOutageLatch.clearAll();
  const notices: string[] = [];
  let taps = 0;
  let decisionReason: string | undefined;
  let policyDecisionReason: string | undefined;
  const decision = await resolvePermissionIpcDecision({
    request: {
      requestId: 'invariance-family-rail',
      targetJid: 'invariance:family-rail',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      toolInput: { command: 'rm -rf build' },
    },
    sourceAgentFolder: 'main_agent',
    deps: {
      conversationRoutes: () => ({}),
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
      classifierConsult: async (input) => {
        policyDecisionReason = input.policyDecisionReason;
        return {
          ...(failureCode ? unavailableVerdict(failureCode) : ANSWERED_VERDICT),
          latencyMs: 1,
        };
      },
      sendMessage: async (_jid, text) => {
        notices.push(text);
      },
      ...(failureCode === 'wiring_missing'
        ? {}
        : { publishRuntimeEvent: async () => undefined }),
      getToolRepository: () => ({
        listAgentToolBindings: async () => [
          { status: 'active', toolId: 'family-rule', personId: null },
        ],
        getTool: async () => ({
          id: 'family-rule',
          appId: 'default',
          name: 'RunCommand(rm *)',
        }),
      }),
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
  judgeOutageLatch.clearAll();
  return {
    tuple: {
      taps,
      approved: decision.approved,
      mode: decision.mode,
      decidedBy: decision.decidedBy,
      source: decision.source,
      railProvenance: decision.railProvenance ?? null,
      decisionReason: decisionReason ?? null,
    },
    notices,
    policyDecisionReason,
  };
}

async function replayInlineScheduled(
  failureCode?: PermissionClassifierFailureCode,
) {
  judgeOutageLatch.clearAll();
  const notices: string[] = [];
  wireInlineAgentLoopTools({
    app: {
      executionAdapter: undefined,
      executionAdapters: undefined,
      runnerSandboxProvider: { enforcing: true },
      getCredentialBroker: async () => undefined,
      getConversationRoutes: () => ({}),
      resolveExecutionProviderId: async () => 'test:inline',
    },
    channelWiring: {
      sendMessage: async () => {
        notices.push(JUDGE_OFFLINE_NOTICE);
      },
      requestPermissionApproval: async () => {
        throw new Error(
          'Scheduled jobs must not use the interactive card path.',
        );
      },
      requestUserAnswer: async () => ({ requestId: 'unused', answers: {} }),
    },
    interactionsEnabled: true,
    getAgentAccessPreset: () => 'full',
    getPermissionRuntimeSettings: () => ({
      agents: { main_agent: { capabilities: [{ id: 'mcp.crm.access' }] } },
      permissions: { autoMode: {}, yoloMode: { enabled: false } },
      memory: { llm: { models: { extractor: 'sonnet' } } },
    }),
    getAsyncTaskRepository: () => ({ listTasks: async () => [] }),
    ...(failureCode === 'wiring_missing'
      ? {}
      : { publishRuntimeEvent: async () => undefined }),
    classifierConsult: async () => ({
      ...(failureCode ? unavailableVerdict(failureCode) : ANSWERED_VERDICT),
      latencyMs: 1,
    }),
    recordDecision: async () => undefined,
    warn: () => undefined,
  } as never);
  const result = await createInlineCoreTools(
    {
      group: {
        name: 'Test',
        folder: 'main_agent',
        providerAccountId: 'account-inline',
        trigger: '@test',
        added_at: new Date(0).toISOString(),
      },
      input: {
        prompt: 'Inspect the CRM record.',
        workspaceFolder: 'main_agent',
        chatJid: 'conversation:inline-invariance',
        compiledSystemPrompt: 'system',
        appId: 'default',
        agentId: 'agent-inline',
        runId: 'run-inline',
        permissionMode: 'auto',
        isScheduledJob: true,
        jobId: 'job-inline',
      },
      signal: new AbortController().signal,
      controlPort: { subscribe: () => () => undefined },
      resolvedModel: { ok: true },
      modelCredentialEnv: {},
      mcpServers: [],
      runtimeDataDir: '/tmp/inline-invariance',
      jobActivity: {
        beginPermissionRequest: () => undefined,
        finishPermissionRequest: () => undefined,
      },
      emitOutput: async () => undefined,
    } as never,
    {
      schemaFactory: z,
      evaluateToolPreChecks: evaluateNeutralToolPreChecks,
      evaluateToolPolicy: (() => ({
        status: 'prompt',
        reason: 'Approval required.',
      })) as never,
      formatMemorySearchResponse: formatMemoryToolResponse,
      formatMemoryWriteResponse,
    },
  ).authorizeThirdPartyMcpTool('mcp__crm__read', { id: 'scheduled' });
  judgeOutageLatch.clearAll();
  return { result, notices };
}

describe('ASKFLOOR judge invariance', () => {
  it('keeps every lane tuple unchanged under an answering judge and under an unavailable judge for the six codes and wiring_missing except the interactive-auto ask and its offline reason', async () => {
    const fixtures = [
      {
        label: 'ask',
        request: {
          permissionMode: 'ask' as const,
          command: "find . -name '*.ts'",
        },
        answered: FIND_RAIL_CARD,
        unavailable: FIND_RAIL_CARD,
      },
      {
        label: 'auto_strict',
        request: {
          permissionMode: 'auto_strict' as const,
          command: "find . -name '*.ts'",
        },
        answered: STRICT_CARD,
        unavailable: STRICT_CARD,
      },
      {
        label: 'interactive_auto',
        request: {
          permissionMode: 'auto' as const,
          targetJid: 'invariance:interactive',
          toolName: 'mcp__gantry__browser_act',
          toolInput: {
            action: 'file_attach',
            payload: { source: { type: 'path', path: '/tmp/upload.txt' } },
          },
        },
        answered: ANSWERED_CARD,
        unavailable: OFFLINE_CARD,
      },
      {
        label: 'trusted-host autonomous',
        request: {
          permissionMode: 'auto' as const,
          hostJobId: 'job-invariance',
          targetJid: 'invariance:job',
          toolName: 'mcp__gantry__browser_act',
          toolInput: {
            action: 'file_attach',
            payload: { source: { type: 'path', path: '/tmp/upload.txt' } },
          },
        },
        answered: ANSWERED_CARD,
        unavailable: OFFLINE_CARD,
      },
      {
        label: 'YOLO backstop',
        request: {
          permissionMode: 'auto' as const,
          command: 'git status',
          yoloMode: {
            enabled: true,
            denylist: ['git status'],
            denylistPaths: [],
          },
        },
        answered: {
          taps: 0,
          approved: false,
          mode: 'cancel',
          decidedBy: 'hard_deny',
          source: 'human_once',
          railProvenance: null,
          decisionReason: null,
        },
        unavailable: {
          taps: 0,
          approved: false,
          mode: 'cancel',
          decidedBy: 'hard_deny',
          source: 'human_once',
          railProvenance: null,
          decisionReason: null,
        },
      },
      {
        label: 'unmapped forced ask',
        request: {
          permissionMode: 'auto' as const,
          targetJid: 'invariance:unmapped',
          toolName: 'mcp__gantry__frobnicate_everything',
          toolInput: {},
        },
        answered: ANSWERED_CARD,
        unavailable: OFFLINE_CARD,
      },
      {
        label: 'scheduler mutation',
        request: {
          permissionMode: 'auto' as const,
          toolName: 'mcp__gantry__scheduler_delete_job',
          toolInput: { jobId: 'job-1' },
        },
        answered: { ...CARD, decisionReason: 'scheduler mutation' },
        unavailable: { ...CARD, decisionReason: 'scheduler mutation' },
      },
      {
        label: 'admin mutation',
        request: {
          permissionMode: 'auto' as const,
          toolName: 'mcp__gantry__admin_permission_revoke',
          toolInput: {},
        },
        answered: { ...CARD, decisionReason: 'admin mutation' },
        unavailable: { ...CARD, decisionReason: 'admin mutation' },
      },
      {
        label: 'destructive',
        request: { permissionMode: 'auto' as const, command: 'rm -rf build' },
        answered: ANSWERED_CARD,
        unavailable: OFFLINE_CARD,
      },
    ];

    for (const fixture of fixtures) {
      await expect(
        replayFixture(fixture.request),
        fixture.label,
      ).resolves.toEqual({
        tuple: fixture.answered,
        notices: [],
      });
      for (const failureCode of FAILURE_CODES) {
        await expect(
          replayFixture(fixture.request, failureCode),
          `${fixture.label}:${failureCode}`,
        ).resolves.toEqual({
          tuple: fixture.unavailable,
          notices:
            fixture.unavailable.decisionReason === JUDGE_OFFLINE_REASON &&
            fixture.request.targetJid
              ? [JUDGE_OFFLINE_NOTICE]
              : [],
        });
      }
    }

    const family = await replayFamilyRail();
    expect(family).toEqual({
      tuple: ANSWERED_CARD,
      notices: [],
      policyDecisionReason: `${FAMILY_RULE_RAIL_HIT_REASON} Destructive command requires approval.`,
    });
    for (const failureCode of FAILURE_CODES) {
      await expect(
        replayFamilyRail(failureCode),
        `family:${failureCode}`,
      ).resolves.toEqual({
        tuple: OFFLINE_CARD,
        notices: [JUDGE_OFFLINE_NOTICE],
        policyDecisionReason:
          failureCode === 'wiring_missing'
            ? undefined
            : `${FAMILY_RULE_RAIL_HIT_REASON} Destructive command requires approval.`,
      });
    }

    const answeringProjection = {
      chatTaps: 1,
      jobTaps: [0, 1, 1],
      railBumpTaps: 1,
      revoked: 'applied',
      decisions: [
        {
          approved: true,
          mode: 'allow_once',
          decidedBy: 'human_decision',
          source: 'human_decision',
          railProvenance: null,
          decisionReason: null,
        },
        {
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          source: 'user',
          railProvenance: null,
          decisionReason: 'Ask the person.',
        },
        {
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          source: 'user',
          railProvenance: null,
          decisionReason: 'Ask the person.',
        },
      ],
      railBumpDecision: {
        approved: false,
        mode: 'cancel',
        decidedBy: 'owner',
        source: 'user',
        railProvenance: null,
        decisionReason: 'Ask the person.',
      },
    };
    const unavailableProjection = {
      ...answeringProjection,
      decisions: [
        answeringProjection.decisions[0],
        {
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          source: 'user',
          railProvenance: null,
          decisionReason: JUDGE_OFFLINE_REASON,
        },
        {
          approved: false,
          mode: 'cancel',
          decidedBy: 'owner',
          source: 'user',
          railProvenance: null,
          decisionReason: JUDGE_OFFLINE_REASON,
        },
      ],
      railBumpDecision: {
        approved: false,
        mode: 'cancel',
        decidedBy: 'owner',
        source: 'user',
        railProvenance: null,
        decisionReason: JUDGE_OFFLINE_REASON,
      },
    };
    await expect(
      replayRememberedJobProjection().then(projectionTuples),
    ).resolves.toEqual(answeringProjection);
    for (const failureCode of FAILURE_CODES) {
      const replay = await replayRememberedJobProjection(
        failureCode === 'wiring_missing'
          ? { publishRuntimeEvent: false }
          : {
              classifierConsult: async () => ({
                ...unavailableVerdict(failureCode),
                latencyMs: 1,
              }),
            },
      );
      expect(projectionTuples(replay)).toEqual(unavailableProjection);
    }
  });

  it('keeps the inline-scheduled path and the attachment_open birthright unchanged under an unavailable judge', async () => {
    const attachment = {
      permissionMode: 'auto' as const,
      toolName: 'mcp__gantry__attachment_open',
      toolInput: { attachment_ids: ['attachment-1'] },
      attachmentOpenIds: { wellFormed: true, count: 1 },
    };
    const attachmentTuple = {
      taps: 0,
      approved: true,
      mode: 'allow_once',
      decidedBy: 'birthright',
      source: 'birthright',
      railProvenance: null,
      decisionReason: null,
    };
    await expect(replayFixture(attachment)).resolves.toEqual({
      tuple: attachmentTuple,
      notices: [],
    });
    for (const failureCode of FAILURE_CODES) {
      await expect(replayFixture(attachment, failureCode)).resolves.toEqual({
        tuple: attachmentTuple,
        notices: [],
      });

      await expect(replayInlineScheduled()).resolves.toEqual({
        result: {
          allowed: false,
          reason:
            'Classifier requested human approval: The judge requires approval.',
        },
        notices: [],
      });
      await expect(replayInlineScheduled(failureCode)).resolves.toEqual({
        result: { allowed: false, reason: JUDGE_OFFLINE_REASON },
        notices: [JUDGE_OFFLINE_NOTICE],
      });
    }
  });
});
