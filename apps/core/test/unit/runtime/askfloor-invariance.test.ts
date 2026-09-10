import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  createInlineCoreTools,
  wireInlineAgentLoopTools,
} from '@core/app/bootstrap/inline-agent-loop-tools.js';
import { decisionForMode } from '@core/domain/permission-decision.js';
import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import {
  FAMILY_RULE_RAIL_HIT_REASON,
  coordinatePermissionDecision,
} from '@core/runtime/permission-decision-coordinator.js';
import type { PermissionClassifierFailureCode } from '@core/runtime/permission-classifier.js';
import { judgeOutageLatch } from '@core/runtime/permission-judge-outage.js';
import { evaluateNeutralToolPreChecks } from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';
import {
  replayPermissionRequest,
  replayRememberedJobProjection,
  TAP_BUDGET_WORKSPACE_ROOT,
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

const fixtureBase = {
  workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
  trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
};

const answeredVerdict = {
  status: PermissionClassifierStatus.Answered,
  risk_level: 'high' as const,
  risk_category: 'network' as const,
  reason: 'The judge requires approval.',
};

function unavailableVerdict(failureCode: PermissionClassifierFailureCode) {
  return {
    status: PermissionClassifierStatus.Unavailable,
    risk_level: 'high' as const,
    risk_category: 'network' as const,
    reason: `Classifier unavailable (${failureCode}); ask the user.`,
    failureCode,
  };
}

const tuple = (
  result: Awaited<ReturnType<typeof replayPermissionRequest>>,
) => ({
  taps: result.taps,
  decidedBy: result.decidedBy,
  source: result.source,
  railProvenance: result.railProvenance,
});

async function replayFamilyRail(unavailable = false) {
  const request = {
    requestId: 'invariance-family-rail',
    sourceAgentFolder: 'main_agent',
    toolName: 'RunCommand',
    toolInput: { command: 'rm -rf build' },
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'RunCommand', ruleContent: 'rm *' }],
      },
    ],
  } as never;
  let taps = 0;
  const decision = await coordinatePermissionDecision({
    request,
    reviewedRuleDecision: {
      status: 'allow',
      reason: 'The command family is allowed.',
      matchedRule: 'RunCommand(rm *)',
      isFamilyRule: true,
    } as never,
    tail: async () => {
      taps += 1;
      return {
        ...decisionForMode(request, 'cancel', 'owner', 'human'),
        reason: unavailable
          ? 'Asking because my safety judge is offline.'
          : 'The judge requires approval.',
      };
    },
  });
  return { taps, decision, reason: request.decisionReason };
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
        notices.push('notice');
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
    classifierConsult: async () =>
      failureCode
        ? { ...unavailableVerdict(failureCode), latencyMs: 1 }
        : { ...answeredVerdict, latencyMs: 1 },
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
          command: 'git status 2>/dev/null',
        },
      },
      {
        label: 'auto_strict',
        request: {
          permissionMode: 'auto_strict' as const,
          command: 'git status 2>/dev/null',
        },
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
        offlineReason: true,
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
        offlineReason: true,
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
      },
      {
        label: 'unmapped forced ask',
        request: {
          permissionMode: 'auto' as const,
          toolName: 'mcp__gantry__frobnicate_everything',
          toolInput: {},
        },
        offlineReason: true,
      },
      {
        label: 'scheduler mutation',
        request: {
          permissionMode: 'auto' as const,
          toolName: 'mcp__gantry__scheduler_delete_job',
          toolInput: { jobId: 'job-1' },
        },
      },
      {
        label: 'destructive command',
        request: {
          permissionMode: 'auto' as const,
          command: 'rm -rf build',
        },
        offlineReason: true,
      },
    ];

    for (const fixture of fixtures) {
      judgeOutageLatch.clearAll();
      const answered = await replayPermissionRequest({
        ...fixtureBase,
        ...fixture.request,
        classifierVerdict: answeredVerdict,
      });
      for (const failureCode of FAILURE_CODES) {
        judgeOutageLatch.clearAll();
        const unavailable = await replayPermissionRequest({
          ...fixtureBase,
          ...fixture.request,
          classifierVerdict: unavailableVerdict(failureCode),
          ...(failureCode === 'wiring_missing'
            ? { publishRuntimeEvent: false }
            : {}),
        });
        expect(tuple(unavailable), `${fixture.label}:${failureCode}`).toEqual(
          tuple(answered),
        );
        if (fixture.offlineReason) {
          expect(unavailable.decisionReason).toBe(
            'Asking because my safety judge is offline.',
          );
        }
      }
    }

    for (const failureCode of FAILURE_CODES) {
      const answered = await replayRememberedJobProjection();
      const unavailable = await replayRememberedJobProjection({
        classifierConsult: async () => ({
          ...unavailableVerdict(failureCode),
          latencyMs: 1,
        }),
      });
      expect(unavailable).toMatchObject({
        chatTaps: answered.chatTaps,
        jobTaps: answered.jobTaps,
        railBumpTaps: answered.railBumpTaps,
        revoked: answered.revoked,
      });
      expect(unavailable).toMatchObject({
        chatTaps: 1,
        jobTaps: [0, 1, 1],
        railBumpTaps: 1,
        revoked: 'applied',
      });
    }

    const family = await replayFamilyRail();
    expect(family).toMatchObject({ taps: 1 });
    expect(family.reason).toBe(
      `${FAMILY_RULE_RAIL_HIT_REASON} Destructive command requires approval.`,
    );
    for (const failureCode of FAILURE_CODES) {
      await expect(
        replayFamilyRail(Boolean(failureCode)),
      ).resolves.toMatchObject({
        taps: family.taps,
        decision: {
          approved: family.decision.approved,
          mode: family.decision.mode,
          decidedBy: family.decision.decidedBy,
          source: family.decision.source,
        },
        reason: family.reason,
      });
    }
  });

  it('keeps the inline-scheduled path and the attachment_open birthright unchanged under an unavailable judge', async () => {
    for (const failureCode of FAILURE_CODES) {
      const answeredAttachment = await replayPermissionRequest({
        ...fixtureBase,
        permissionMode: 'auto',
        toolName: 'mcp__gantry__attachment_open',
        toolInput: { attachment_ids: ['attachment-1'] },
        attachmentOpenIds: { wellFormed: true, count: 1 },
        classifierVerdict: answeredVerdict,
      });
      const unavailableAttachment = await replayPermissionRequest({
        ...fixtureBase,
        permissionMode: 'auto',
        toolName: 'mcp__gantry__attachment_open',
        toolInput: { attachment_ids: ['attachment-1'] },
        attachmentOpenIds: { wellFormed: true, count: 1 },
        classifierVerdict: unavailableVerdict(failureCode),
        ...(failureCode === 'wiring_missing'
          ? { publishRuntimeEvent: false }
          : {}),
      });
      expect(tuple(unavailableAttachment)).toEqual(tuple(answeredAttachment));
      expect(unavailableAttachment).toMatchObject({
        taps: 0,
        decidedBy: 'birthright',
        source: 'birthright',
      });

      const answeredInline = await replayInlineScheduled();
      const unavailableInline = await replayInlineScheduled(failureCode);
      expect(answeredInline).toEqual({
        result: {
          allowed: false,
          reason:
            'Classifier requested human approval: The judge requires approval.',
        },
        notices: [],
      });
      expect(unavailableInline).toEqual({
        result: {
          allowed: false,
          reason: 'Asking because my safety judge is offline.',
        },
        notices: ['notice'],
      });
    }
  });
});
