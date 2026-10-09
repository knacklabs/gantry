import { describe, expect, it, vi } from 'vitest';
import { permissionDecisionResult } from '../channels/permission-approval-result-helpers.js';

import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { PermissionLane, RailSignal } from '@core/domain/permission-lane.js';
import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
  type PermissionDecisionMemoryRepository,
  type PermissionDecisionMemoryRow,
} from '@core/domain/ports/permission-decision-memory.js';
import type { ToolPolicyDecision } from '@core/shared/tool-execution-policy-service.js';
import { decisionForMode } from '@core/domain/permission-decision.js';
import {
  coordinatePermissionClassifierRisk,
  coordinatePermissionDecision,
  PERMISSION_DECISION_STAGES,
  type PermissionDecisionTailContext,
  permissionRunRestriction,
  unregisterPermissionRunRestriction,
} from '@core/runtime/permission-decision-coordinator.js';
import * as permissionCoordinator from '@core/runtime/permission-decision-coordinator.js';
import {
  registerWorkerPermissionRunRestriction,
  setupPermissionRunRestriction,
} from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { computePermissionEffectHash } from '@core/domain/permission-effect-key.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const GATES = [
  'SDK worker',
  'DeepAgents shell',
  'DeepAgents third-party MCP',
  'DeepAgents facade',
  'inline core tool',
  'inline third-party MCP',
] as const;

const request: PermissionApprovalRequest = {
  requestId: 'permission-test',
  sourceAgentFolder: 'main_agent',
  toolName: 'FileRead',
  toolInput: { path: 'README.md' },
};

const reviewedAllow: ToolPolicyDecision = {
  status: 'allow',
  reason: 'Allowed by reviewed rule FileRead.',
  audit: {
    category: 'tool_execution',
    origin: 'host',
    toolKind: 'file',
    toolName: 'FileRead',
    mutationIntent: 'read',
  },
};

const ROUTED_JID = 'tg:routed';

/** A live route binding main_agent to ROUTED_JID. */
function liveRoutes() {
  return {
    [makeAgentThreadQueueKey(ROUTED_JID, 'agent:main_agent')]: {
      name: 'Main',
      folder: 'main_agent',
      trigger: '',
      added_at: new Date(0).toISOString(),
    },
  };
}

const interactiveAuto = Object.freeze({
  lane: PermissionLane.InteractiveAuto,
  readOnlyMetaExecutor: false,
});

const classifierAsk = {
  status: PermissionClassifierStatus.Answered,
  decision: 'ask' as const,
  reason: 'needs a person',
  risk_level: 'high' as const,
  latencyMs: 1,
};

function humanDecisionRow(input: {
  outcome: (typeof HumanDecisionOutcome)[keyof typeof HumanDecisionOutcome];
  scope: (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope];
  scopeKey: string;
}): PermissionDecisionMemoryRow {
  return {
    id: `human-${input.outcome}-${input.scope}`,
    appId: 'default',
    agentFolder: 'main_agent',
    kind: 'human_decision',
    lookupIdentity: input.scopeKey,
    decision: input.outcome,
    outcome: input.outcome,
    scope: input.scope,
    scopeKey: input.scopeKey,
    actingPersonId: 'person-one',
    reason: 'remembered',
    effectSchemaVersion: 3,
    railVersion: 2,
    provenance: 'human_decision:test',
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

describe('coordinatePermissionDecision', () => {
  it('AUTODET-1-1 > host allow records host match reason; worker no-match text is diagnostic only', async () => {
    const hostRequest = {
      ...request,
      decisionReason: 'Tool not on autonomous run allowlist: FileRead.',
    };

    await expect(
      coordinatePermissionDecision({
        request: hostRequest,
        reviewedRuleDecision: reviewedAllow,
        tail: vi.fn(),
      }),
    ).resolves.toMatchObject({
      approved: true,
      decidedBy: 'reviewed_rule',
      reason: reviewedAllow.reason,
    });
    expect(hostRequest.decisionReason).toBe(reviewedAllow.reason);

    const responseKeyId = 'autodet-reviewed-rule-response-key';
    registerWorkerPermissionRunRestriction({
      sourceAgentFolder: 'main_agent',
      responseKeyId,
      hideAuthorityTools: false,
      runKind: 'scheduled',
      jobId: 'job-1',
      runId: 'run-1',
    });
    const workerMiss = 'Worker found no local autonomous rule.';
    const ipcRequest = {
      requestId: 'autodet-reviewed-rule-allow',
      responseKeyId,
      sourceAgentFolder: 'main_agent',
      appId: 'default',
      agentId: 'agent:test',
      targetJid: ROUTED_JID,
      toolName: 'mcp__gantry__canvas_create',
      toolInput: { title: 'status' },
      decisionReason: workerMiss,
      unattended: true,
    };
    try {
      const decision = await resolvePermissionIpcDecision({
        request: ipcRequest,
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: liveRoutes,
          requestPermissionApproval: vi.fn(),
          getToolRepository: () => ({
            listAgentToolBindings: vi.fn(async () => [
              {
                status: 'active',
                toolId: 'tool:canvas-create',
                personId: null,
              },
            ]),
            getTool: vi.fn(async () => ({
              appId: 'default',
              name: 'mcp__gantry__canvas_create',
            })),
          }),
          getPermissionRuntimeSettings: () => ({
            agents: { main_agent: { permissionMode: 'auto' as const } },
            permissions: { autoMode: {}, trustedRoots: [] },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      });

      expect(decision).toMatchObject({
        approved: true,
        decidedBy: 'reviewed_rule',
        reason: 'Allowed by autonomous tool rule mcp__gantry__canvas_create.',
      });
      expect(ipcRequest.decisionReason).toBe(decision.reason);
      expect(ipcRequest.decisionReason).not.toBe(workerMiss);
    } finally {
      unregisterPermissionRunRestriction({
        sourceAgentFolder: 'main_agent',
        responseKeyId,
      });
    }
  });

  it('never promotes a human decision whose approverRef collides with a machine decider', async () => {
    const { decisionForMode } =
      await import('@core/domain/permission-decision.js');
    for (const decider of ['auto_classifier', 'reviewed_rule', 'birthright']) {
      const decision = decisionForMode(
        { requestId: 'r1' } as never,
        'allow_once',
        decider,
        'human',
      );
      expect(decision.source).toBe('human_once');
      expect(decision.repeatableForFutureRuns).toBe(false);
    }
  });

  it('treats prototype-key deciders as unknown (conservative human_once)', async () => {
    const { decisionForMode } =
      await import('@core/domain/permission-decision.js');
    for (const decider of ['constructor', 'toString', 'hasOwnProperty']) {
      const decision = decisionForMode(
        { requestId: 'r1' } as never,
        'allow_once',
        decider,
      );
      expect(decision.source).toBe('human_once');
      expect(decision.repeatableForFutureRuns).toBe(false);
    }
  });
  it.each(['low', 'medium'] as const)(
    'maps %s classifier risk to auto_classifier allow_once',
    async (riskLevel) => {
      const tail = vi.fn();
      const allow = vi.fn(() => ({
        ...decisionForMode(request, 'allow_once', 'auto_classifier'),
        reason: `${riskLevel} intrinsic risk.`,
      }));

      await expect(
        coordinatePermissionClassifierRisk({ riskLevel, allow, tail }),
      ).resolves.toMatchObject({
        approved: true,
        mode: 'allow_once',
        decidedBy: 'auto_classifier',
      });
      expect(allow).toHaveBeenCalledOnce();
      expect(tail).not.toHaveBeenCalled();
    },
  );

  it.each(['high', 'critical'] as const)(
    'routes %s classifier risk to the human tail',
    async (riskLevel) => {
      const humanDecision = {
        approved: false,
        mode: 'cancel' as const,
        decidedBy: 'human',
      };
      const tail = vi.fn(async () => humanDecision);
      const allow = vi.fn();

      await expect(
        coordinatePermissionClassifierRisk({ riskLevel, allow, tail }),
      ).resolves.toEqual(humanDecision);
      expect(allow).not.toHaveBeenCalled();
      expect(tail).toHaveBeenCalledOnce();
    },
  );

  it.each(
    GATES.flatMap((gate) => [
      {
        gate,
        authority: 'hard-deny',
        input: {
          hardDenyReason: 'hard denied',
          accessPreset: 'locked' as const,
          fixedImageRestricted: true,
          reviewedRuleDecision: reviewedAllow,
        },
        expected: { approved: false, decidedBy: 'hard_deny' },
      },
      {
        gate,
        authority: 'locked-preset',
        input: {
          accessPreset: 'locked' as const,
          fixedImageRestricted: true,
          reviewedRuleDecision: reviewedAllow,
        },
        expected: { approved: false, decidedBy: 'locked_preset' },
      },
      {
        gate,
        authority: 'fixed-image',
        input: {
          fixedImageRestricted: true,
          reviewedRuleDecision: reviewedAllow,
        },
        expected: { approved: false, decidedBy: 'fixed_image' },
      },
      {
        gate,
        authority: 'reviewed-rule-allow',
        input: { reviewedRuleDecision: reviewedAllow },
        expected: { approved: true, decidedBy: 'reviewed_rule' },
      },
    ]),
  )('$gate: $authority beats the otherwise-allowing tail', async (testCase) => {
    const tail = vi.fn(async (_context?: PermissionDecisionTailContext) => ({
      approved: true,
      mode: 'allow_once' as const,
      decidedBy: 'tail',
    }));
    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        ...testCase.input,
        tail,
      }),
    ).resolves.toMatchObject(testCase.expected);
    expect(tail).not.toHaveBeenCalled();
  });

  it('routes an injected ASK rail to the classifier/human tail', async () => {
    const railRequest = { ...request };
    const tailDecision = {
      approved: true,
      mode: 'allow_once' as const,
      decidedBy: 'human',
    };
    const tail = vi.fn(async () => tailDecision);
    const deterministicRails = vi.fn(() => ({
      railOutcome: 'ask' as const,
      reason: 'rail asks',
    }));
    await expect(
      coordinatePermissionDecision({
        request: railRequest,
        deterministicRails,
        tail,
      }),
    ).resolves.toEqual(tailDecision);
    expect(deterministicRails).toHaveBeenCalledOnce();
    expect(tail).toHaveBeenCalledOnce();
    expect(railRequest.decisionReason).toBe('rail asks');
  });

  it('evaluates the rails once and threads the completed AutoLaneAnalysis unchanged into the tail', async () => {
    const analysis = Object.freeze({
      lane: PermissionLane.InteractiveAuto,
      readOnlyMetaExecutor: true,
    });
    const railDecision = {
      railOutcome: 'ask' as const,
      reason: 'outside the trusted root',
      railSignal: 'out_of_trusted_root' as const,
      hardFloor: true as const,
    };
    const deterministicRails = vi.fn(() => railDecision);
    const tail = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    }));

    await coordinatePermissionDecision({
      request: { ...request },
      analysis,
      deterministicRails,
      tail,
    });

    expect(deterministicRails).toHaveBeenCalledOnce();
    expect(tail).toHaveBeenCalledOnce();
    const context = tail.mock.calls[0]![0]!;
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.analysis).toBe(analysis);
    expect(context.railDecision).toBe(railDecision);
  });

  it('keeps the pinned ladder: route, hard rules, saved approvals, verdict cache, classifier, ask; a soft out-of-root ask skips the cache and reaches the classifier after the trusted-root stage; the remembered No and Allow are saved approvals behind the hard rules; and the person-memory port is never consulted under ask, auto_strict or a job lane, without a person, or under a hard-rule ask', async () => {
    expect(PERMISSION_DECISION_STAGES).toEqual([
      'route',
      'hard_rules',
      'saved_approvals',
      'verdict_cache',
      'classifier',
      'ask',
    ]);
    for (const softRail of [false, true]) {
      const observed: string[] = [];
      let railEvaluation = 0;
      await coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        routeRefusal: () => {
          observed.push('route');
          return undefined;
        },
        analysis: Object.freeze({
          lane: PermissionLane.InteractiveAuto,
          readOnlyMetaExecutor: false,
        }),
        reviewedRuleDecision: async () => {
          observed.push('reviewed_rules');
          return undefined;
        },
        deterministicRails: () => {
          railEvaluation += 1;
          if (railEvaluation > 1) return undefined;
          observed.push('hard_rules');
          return softRail
            ? {
                railOutcome: 'ask',
                reason: 'outside the trusted root',
                railSignal: RailSignal.OutOfTrustedRoot,
              }
            : undefined;
        },
        deterministicRailsInput: { workspaceRoot: '/workspace' },
        effectHash: 'stage-order',
        decisionMemory: {
          findHumanDecision: async ({ candidates }) => {
            observed.push(
              candidates.length === 1
                ? 'exact_remembered_deny'
                : 'remembered_allows',
            );
            return null;
          },
          list: async () => {
            observed.push('conditional_trusted_root');
            return [];
          },
          getClassifierVerdict: async () => {
            observed.push('verdict_cache');
            return null;
          },
          putClassifierVerdict: async () => undefined,
        } as never,
        consultClassifier: async () => {
          observed.push('classifier');
          return {
            status: PermissionClassifierStatus.Answered,
            decision: 'ask',
            reason: 'needs a person',
            risk_level: 'high',
            latencyMs: 1,
          };
        },
        tail: async () => {
          observed.push('ask');
          return { approved: false, mode: 'cancel', decidedBy: 'human' };
        },
      });
      expect(observed).toEqual([
        'route',
        'hard_rules',
        'exact_remembered_deny',
        'reviewed_rules',
        ...(softRail ? ['conditional_trusted_root'] : []),
        'remembered_allows',
        ...(softRail ? [] : ['verdict_cache']),
        'classifier',
        'ask',
      ]);
      expect(railEvaluation).toBe(softRail ? 2 : 1);
    }

    const interactiveAnalysis = Object.freeze({
      lane: PermissionLane.InteractiveAuto,
      readOnlyMetaExecutor: false,
    });
    const denyTail = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        analysis: interactiveAnalysis,
        effectHash: 'remembered-deny',
        hardDenyReason: 'hard restriction',
        decisionMemory: {
          findHumanDecision: async () =>
            humanDecisionRow({
              outcome: HumanDecisionOutcome.Deny,
              scope: HumanDecisionScope.Exact,
              scopeKey: 'remembered-deny',
            }),
        } as never,
        tail: denyTail,
      }),
    ).resolves.toMatchObject({ approved: false, decidedBy: 'hard_deny' });
    await expect(
      coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        analysis: interactiveAnalysis,
        effectHash: 'remembered-deny',
        deterministicRails: () => undefined,
        decisionMemory: {
          findHumanDecision: async () =>
            humanDecisionRow({
              outcome: HumanDecisionOutcome.Deny,
              scope: HumanDecisionScope.Exact,
              scopeKey: 'remembered-deny',
            }),
        } as never,
        tail: denyTail,
      }),
    ).resolves.toMatchObject({
      approved: false,
      decidedBy: 'human_decision',
      source: 'human_decision',
      repeatableForFutureRuns: true,
    });
    expect(denyTail).not.toHaveBeenCalled();

    const cachedVerdict = vi.fn(async () => null);
    const exactAllow = await coordinatePermissionDecision({
      request: { ...request, personId: 'person-one' },
      analysis: interactiveAnalysis,
      effectHash: 'remembered-allow',
      deterministicRails: () => undefined,
      decisionMemory: {
        findHumanDecision: async () =>
          humanDecisionRow({
            outcome: HumanDecisionOutcome.Allow,
            scope: HumanDecisionScope.Exact,
            scopeKey: 'remembered-allow',
          }),
        getClassifierVerdict: cachedVerdict,
      } as never,
      tail: vi.fn(),
    });
    expect(exactAllow).toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'human_decision',
      source: 'human_decision',
      repeatableForFutureRuns: true,
    });
    expect(
      decisionForMode(
        { ...request, personId: 'person-one' },
        'allow_once',
        'human_decision',
        'machine',
      ),
    ).toMatchObject({
      source: 'human_decision',
      repeatableForFutureRuns: true,
    });
    expect(cachedVerdict).not.toHaveBeenCalled();

    const kindAllow = humanDecisionRow({
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Kind,
      scopeKey: 'kind:web_read',
    });
    await expect(
      coordinatePermissionDecision({
        request: {
          ...request,
          personId: 'person-one',
          toolName: 'WebRead',
          toolInput: { url: 'https://example.com' },
        },
        analysis: interactiveAnalysis,
        effectHash: 'kind-near-miss',
        deterministicRails: () => undefined,
        decisionMemory: {
          findHumanDecision: async ({ candidates }) =>
            candidates.some(({ scopeKey }) => scopeKey === kindAllow.scopeKey)
              ? kindAllow
              : null,
        } as never,
        tail: vi.fn(),
      }),
    ).resolves.toMatchObject({ decidedBy: 'human_decision' });

    const placeAllow = humanDecisionRow({
      outcome: HumanDecisionOutcome.Allow,
      scope: HumanDecisionScope.Place,
      scopeKey: 'place:web_read:/workspace',
    });
    const placeCandidates: string[] = [];
    const placeCache = vi.fn(async () => null);
    const placeRails = vi.fn((input: { trustedRoots?: readonly string[] }) =>
      input.trustedRoots?.includes('/workspace')
        ? undefined
        : {
            railOutcome: 'ask' as const,
            railSignal: RailSignal.OutOfTrustedRoot,
            reason: 'outside the trusted root',
            hardFloor: true as const,
          },
    );
    await expect(
      coordinatePermissionDecision({
        request: {
          ...request,
          personId: 'person-one',
          toolName: 'WebRead',
          toolInput: { url: 'https://example.com' },
        },
        analysis: interactiveAnalysis,
        effectHash: 'place-near-miss',
        deterministicRails: placeRails as never,
        deterministicRailsInput: { workspaceRoot: '/workspace' },
        decisionMemory: {
          list: async () => [],
          findHumanDecision: async ({ candidates }) => {
            placeCandidates.push(...candidates.map(({ scopeKey }) => scopeKey));
            return candidates.some(
              ({ scopeKey }) => scopeKey === placeAllow.scopeKey,
            )
              ? placeAllow
              : null;
          },
          getClassifierVerdict: placeCache,
        } as never,
        tail: vi.fn(),
      }),
    ).resolves.toMatchObject({ decidedBy: 'human_decision' });
    expect(placeCandidates).toContain('place:web_read:/workspace');
    expect(placeCache).not.toHaveBeenCalled();

    const ineligibleFind = vi.fn(async () => null);
    for (const lane of [
      PermissionLane.Ask,
      PermissionLane.AutoStrict,
      PermissionLane.Autonomous,
    ]) {
      await coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        analysis: { lane, readOnlyMetaExecutor: false },
        effectHash: 'ineligible-lane',
        deterministicRails: () => undefined,
        decisionMemory: { findHumanDecision: ineligibleFind } as never,
        skipClassifierVerdictCache: true,
        tail: async () => decisionForMode(request, 'cancel', 'human', 'human'),
      });
    }
    await coordinatePermissionDecision({
      request: { ...request },
      analysis: interactiveAnalysis,
      effectHash: 'no-person',
      deterministicRails: () => undefined,
      decisionMemory: { findHumanDecision: ineligibleFind } as never,
      skipClassifierVerdictCache: true,
      tail: async () => decisionForMode(request, 'cancel', 'human', 'human'),
    });
    expect(ineligibleFind).not.toHaveBeenCalled();

    const nonOverridableFind: PermissionDecisionMemoryRepository['findHumanDecision'] =
      vi.fn(async () => null);
    const nonOverridableRail = {
      railOutcome: 'ask' as const,
      railSignal: RailSignal.Destructive,
      reason: 'destructive rail asks',
    };
    const railTail = vi.fn(async (context?: PermissionDecisionTailContext) => {
      expect(context?.railDecision).toBe(nonOverridableRail);
      return decisionForMode(request, 'cancel', 'human', 'human');
    });
    await coordinatePermissionDecision({
      request: { ...request, personId: 'person-one' },
      analysis: interactiveAnalysis,
      effectHash: 'non-overridable',
      deterministicRails: () => nonOverridableRail,
      decisionMemory: { findHumanDecision: nonOverridableFind } as never,
      tail: railTail,
    });
    // A hard-rule ask never consults saved approvals, even an exact one.
    expect(nonOverridableFind).not.toHaveBeenCalled();
    expect(railTail).toHaveBeenCalledOnce();
  });

  it('routes a default ASK rail to the classifier/human tail', async () => {
    const tailDecision = {
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    };
    const tail = vi.fn(async () => tailDecision);
    const railRequest = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'rm -rf ./build' },
    };
    await expect(
      coordinatePermissionDecision({
        request: railRequest,
        tail,
      }),
    ).resolves.toEqual(tailDecision);
    expect(tail).toHaveBeenCalledOnce();
    expect(railRequest.decisionReason).toContain('Destructive');
  });

  it('a destructive rail hit inside an allowed family asks a person and offers only Allow once and Deny', async () => {
    const familyRequest: PermissionApprovalRequest = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'rm -rf ./build' },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'RunCommand', ruleContent: 'rm *' }],
        },
      ],
    };
    const tailDecision = {
      approved: true,
      mode: 'allow_once' as const,
      decidedBy: 'human',
    };
    const tail = vi.fn(async () => {
      expect(familyRequest.suggestions).toEqual([]);
      expect(familyRequest.decisionOptions).toEqual(['allow_once', 'cancel']);
      expect(familyRequest.decisionReason).toBe(
        'Destructive command requires approval.',
      );
      return tailDecision;
    });

    await expect(
      coordinatePermissionDecision({
        request: familyRequest,
        reviewedRuleDecision: {
          ...reviewedAllow,
          matchedRule: 'RunCommand(rm *)',
          isFamilyRule: true,
        },
        tail,
      }),
    ).resolves.toEqual(tailDecision);
    expect(tail).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'DENY',
      railDecision: {
        railOutcome: 'deny' as const,
        approved: false,
        mode: 'cancel' as const,
        decidedBy: 'deterministic_rails',
        reason: 'rail denies',
      },
    },
    {
      label: 'ALLOW',
      railDecision: {
        railOutcome: 'allow' as const,
        approved: true,
        mode: 'allow_once' as const,
        decidedBy: 'deterministic_read_only',
        reason: 'rail allows',
      },
    },
  ])('terminates on an injected $label rail', async ({ railDecision }) => {
    const tail = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        deterministicRails: () => railDecision,
        tail,
      }),
    ).resolves.toEqual(railDecision);
    expect(tail).not.toHaveBeenCalled();
  });

  it('routes credential-read ASK rails to the tail', async () => {
    const tailDecision = {
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    };
    const tail = vi.fn(async () => tailDecision);
    const railRequest = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'cat ~/.ssh/id_rsa' },
    };

    await expect(
      coordinatePermissionDecision({
        request: railRequest,
        tail,
      }),
    ).resolves.toEqual(tailDecision);
    expect(tail).toHaveBeenCalledOnce();
    expect(railRequest.decisionReason).toContain('credential');
  });

  it.each([
    [
      'allow',
      {
        approved: true,
        mode: 'allow_once' as const,
        decidedBy: 'classifier_cache',
      },
    ],
    [
      'deny',
      {
        approved: false,
        mode: 'cancel' as const,
        decidedBy: 'classifier_cache',
      },
    ],
  ])(
    're-validates a cached %s against current rails',
    async (_label, cachedDecision) => {
      const tail = vi.fn(async () => cachedDecision);
      const shellRequest = {
        ...request,
        toolName: 'RunCommand',
        toolInput: { command: 'git status' },
      };

      await expect(
        coordinatePermissionDecision({
          request: { ...shellRequest },
          deterministicRailsInput: {
            workspaceRoot: '/workspace',
            trustedRoots: ['/workspace'],
          },
          tail,
        }),
      ).resolves.toEqual(cachedDecision);

      const outsideRequest = { ...shellRequest };
      await expect(
        coordinatePermissionDecision({
          request: outsideRequest,
          deterministicRailsInput: {
            workspaceRoot: '/workspace',
            trustedRoots: [],
          },
          tail,
        }),
      ).resolves.toEqual(cachedDecision);
      expect(outsideRequest.decisionReason).toContain('outside');
      expect(tail).toHaveBeenCalledTimes(2);
    },
  );

  it('returns a cached classifier allow WITHOUT reaching the tail (cache hit)', async () => {
    const tail = vi.fn();
    const getClassifierVerdict = vi.fn(async () => ({
      decision: 'allow' as const,
      reason: 'cached allow',
      risk_level: 'low' as const,
      risk_category: 'filesystem' as const,
    }));
    const cachedRequest = { ...request };
    const consultClassifier = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: cachedRequest,
        analysis: interactiveAuto,
        effectHash: 'effect-hash-1',
        decisionMemory: { getClassifierVerdict } as never,
        deterministicRails: () => undefined,
        consultClassifier,
        tail,
      }),
    ).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'cached_classifier_verdict',
      reason: 'cached allow',
      risk_level: 'low',
      risk_category: 'filesystem',
    });
    expect(cachedRequest).toMatchObject({
      risk_level: 'low',
      risk_category: 'filesystem',
    });
    expect(getClassifierVerdict).toHaveBeenCalledWith({
      appId: 'default',
      agentFolder: 'main_agent',
      effectHash: 'effect-hash-1:interactive_auto',
    });
    expect(consultClassifier).not.toHaveBeenCalled();
    expect(tail).not.toHaveBeenCalled();
  });

  it('falls through to the live classifier when an expired cached verdict is excluded', async () => {
    const liveClassifierDecision = {
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'live_classifier',
    };
    const tail = vi.fn(async () => liveClassifierDecision);
    const getClassifierVerdict = vi.fn(async () => null);

    const consultClassifier = vi.fn(async () => classifierAsk);
    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        analysis: interactiveAuto,
        effectHash: 'expired-effect-hash',
        decisionMemory: {
          getClassifierVerdict,
          putClassifierVerdict: vi.fn(async () => undefined),
        } as never,
        deterministicRails: () => undefined,
        consultClassifier,
        tail,
      }),
    ).resolves.toEqual(liveClassifierDecision);
    expect(getClassifierVerdict).toHaveBeenCalledOnce();
    expect(consultClassifier).toHaveBeenCalledOnce();
    expect(tail).toHaveBeenCalledOnce();
  });

  it('reuses a cached verdict only within the same parent conversation, including its threads', async () => {
    const base = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'npm test' },
      targetJid: 'conversation-a',
    };
    const conversationAHash = computePermissionEffectHash({ request: base })!;
    const cached = new Map([
      [
        `${conversationAHash}:interactive_auto`,
        { decision: 'allow' as const, reason: 'cached low risk' },
      ],
    ]);
    const getClassifierVerdict = vi.fn(
      async ({ effectHash }: { effectHash: string }) =>
        cached.get(effectHash) ?? null,
    );
    const decisionMemory = {
      getClassifierVerdict,
      putClassifierVerdict: vi.fn(async () => undefined),
    } as never;
    const consultClassifier = vi.fn(async () => classifierAsk);
    const tail = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    }));

    for (const sameConversationRequest of [
      base,
      { ...base, threadId: 'thread-1' },
    ]) {
      const effectHash = computePermissionEffectHash({
        request: sameConversationRequest,
      });
      await expect(
        coordinatePermissionDecision({
          request: sameConversationRequest,
          analysis: interactiveAuto,
          effectHash,
          decisionMemory,
          deterministicRails: () => undefined,
          consultClassifier,
          tail,
        }),
      ).resolves.toMatchObject({
        approved: true,
        decidedBy: 'cached_classifier_verdict',
      });
    }

    const otherConversationRequest = {
      ...base,
      targetJid: 'conversation-b',
    };
    await expect(
      coordinatePermissionDecision({
        request: otherConversationRequest,
        analysis: interactiveAuto,
        effectHash: computePermissionEffectHash({
          request: otherConversationRequest,
        }),
        decisionMemory,
        deterministicRails: () => undefined,
        consultClassifier,
        tail,
      }),
    ).resolves.toMatchObject({ approved: false, decidedBy: 'human' });
    expect(tail).toHaveBeenCalledOnce();
  });

  it('lets an ASK rail override a cached allow WITHOUT reading the cache', async () => {
    const tailDecision = {
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    };
    const tail = vi.fn(async () => tailDecision);
    const getClassifierVerdict = vi.fn(async () => ({
      decision: 'allow' as const,
      reason: 'stale cached allow',
    }));
    const railRequest = { ...request };
    await expect(
      coordinatePermissionDecision({
        request: railRequest,
        analysis: Object.freeze({
          lane: PermissionLane.InteractiveAuto,
          readOnlyMetaExecutor: false,
        }),
        effectHash: 'effect-hash-1',
        decisionMemory: { getClassifierVerdict } as never,
        deterministicRails: () => ({
          railOutcome: 'ask' as const,
          reason: 'rail now asks',
          railSignal: RailSignal.Destructive,
        }),
        tail,
      }),
    ).resolves.toEqual(tailDecision);
    expect(getClassifierVerdict).not.toHaveBeenCalled();
    expect(tail).toHaveBeenCalledOnce();
    expect(railRequest.decisionReason).toBe('rail now asks');
  });

  // Contract change (PERMFLOW-1): a remembered exact Allow used to answer a
  // destructive ask. Hard rules now come before every saved approval.
  it('never answers a destructive or secret-path ask from a remembered exact Allow', async () => {
    const findHumanDecision = vi.fn(async () =>
      humanDecisionRow({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        scopeKey: 'destructive-allow',
      }),
    );
    for (const rail of [
      {
        railOutcome: 'ask' as const,
        reason: 'Destructive command requires approval.',
        railSignal: RailSignal.Destructive,
        hardFloor: true as const,
      },
      {
        railOutcome: 'ask' as const,
        reason: 'Command references a credential, secret, or protected path.',
        railSignal: RailSignal.SecretPath,
        hardFloor: true as const,
      },
    ]) {
      const tail = vi.fn(async () =>
        decisionForMode(request, 'cancel', 'human', 'human'),
      );
      await expect(
        coordinatePermissionDecision({
          request: { ...request, personId: 'person-one' },
          analysis: interactiveAuto,
          effectHash: 'destructive-allow',
          decisionMemory: { findHumanDecision } as never,
          deterministicRails: () => rail,
          tail,
        }),
      ).resolves.toMatchObject({ approved: false, decidedBy: 'human' });
      expect(tail).toHaveBeenCalledOnce();
    }
    expect(findHumanDecision).not.toHaveBeenCalled();
  });

  it('lets a locked preset outrank a cached allow (lock beats cache)', async () => {
    const tail = vi.fn();
    const getClassifierVerdict = vi.fn(async () => ({
      decision: 'allow' as const,
      reason: 'cached allow',
    }));
    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        accessPreset: 'locked',
        effectHash: 'effect-hash-1',
        decisionMemory: { getClassifierVerdict } as never,
        deterministicRails: () => undefined,
        tail,
      }),
    ).resolves.toMatchObject({ approved: false, decidedBy: 'locked_preset' });
    expect(getClassifierVerdict).not.toHaveBeenCalled();
    expect(tail).not.toHaveBeenCalled();
  });

  it('skips the cache entirely when the effect hash is undefined', async () => {
    const tailDecision = {
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    };
    const tail = vi.fn(async () => tailDecision);
    const getClassifierVerdict = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        effectHash: undefined,
        decisionMemory: { getClassifierVerdict } as never,
        deterministicRails: () => undefined,
        tail,
      }),
    ).resolves.toEqual(tailDecision);
    expect(getClassifierVerdict).not.toHaveBeenCalled();
    expect(tail).toHaveBeenCalledOnce();
  });

  // Task G — learned trusted-root ask-once `[this folder][once][deny]`.
  const shellIn = (root: string) => ({
    workspaceRoot: root,
    trustedRoots: [] as string[],
  });
  const grantRow = (canonicalRoot: string) => ({ canonicalRoot }) as never;

  it('offers ask-once "this folder" on the first command in a new root and persists the grant', async () => {
    const list = vi.fn(async () => []);
    const put = vi.fn(async () => {});
    // The human picks the persistent-rule option ("this folder"), which for a
    // trustedRootLearn request approves without a tool-rule suggestion.
    const tail = vi.fn(async () => ({
      approved: true,
      mode: 'allow_persistent_rule' as const,
      decidedBy: 'owner-1',
    }));
    const req = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'git status' },
    };
    const decision = await coordinatePermissionDecision({
      request: req,
      decisionMemory: { list, put } as never,
      deterministicRailsInput: shellIn('/perm2test/project'),
      tail,
    });
    expect(tail).toHaveBeenCalledOnce();
    expect(req.decisionOptions).toEqual([
      'allow_persistent_rule',
      'allow_once',
      'cancel',
    ]);
    expect(req.trustedRootLearn).toBe(true);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).toMatchObject({
      kind: 'trusted_root',
      canonicalRoot: '/perm2test/project',
      principal: 'owner-1',
      lookupIdentity: '/perm2test/project\u0000owner-1',
      provenance: 'human_trusted_root',
    });
    expect(decision).toMatchObject({
      approved: true,
      decidedBy: 'trusted_root_grant',
    });
  });

  it('passes the validated canonical root to the learning tail when the caller supplied no lane analysis', async () => {
    const list = vi.fn(async () => []);
    const put = vi.fn(async () => {});
    const tail = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
    }));
    await coordinatePermissionDecision({
      request: {
        ...request,
        toolName: 'RunCommand',
        toolInput: { command: 'git status' },
      },
      decisionMemory: { list, put } as never,
      deterministicRailsInput: shellIn('/perm2test/project'),
      tail,
    });
    expect(tail).toHaveBeenCalledOnce();
    expect(tail.mock.calls[0][0]).toMatchObject({
      canonicalRoot: '/perm2test/project',
    });
    expect(tail.mock.calls[0][0]?.analysis).toBeUndefined();
  });

  it('auto-allows a reviewed family op inside a granted trusted root WITHOUT prompting', async () => {
    const tail = vi.fn();
    const list = vi.fn(async () => [grantRow('/perm2test/project')]);
    const req = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'git status' },
    };
    const decision = await coordinatePermissionDecision({
      request: req,
      analysis: Object.freeze({
        lane: PermissionLane.InteractiveAuto,
        readOnlyMetaExecutor: false,
      }),
      reviewedRuleDecision: { ...reviewedAllow, isFamilyRule: true },
      decisionMemory: { list, put: vi.fn() } as never,
      deterministicRailsInput: shellIn('/perm2test/project'),
      tail,
    });
    expect(tail).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      decidedBy: 'trusted_root_grant',
    });
  });

  it('still ASKs for a destructive command inside a granted root (rails override)', async () => {
    const tail = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    }));
    const put = vi.fn(async () => {});
    const req = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'rm -rf ./build' },
    };
    await coordinatePermissionDecision({
      request: req,
      decisionMemory: {
        list: vi.fn(async () => [grantRow('/perm2test/project')]),
        put,
      } as never,
      deterministicRailsInput: shellIn('/perm2test/project'),
      tail,
    });
    expect(tail).toHaveBeenCalledOnce();
    expect(req.decisionReason).toContain('Destructive');
    // Destructive commands are never offered as a learnable root.
    expect(req.trustedRootLearn).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it('scopes a grant to its canonical root (a sibling root is not covered)', async () => {
    const tail = vi.fn(async () => ({
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    }));
    const put = vi.fn(async () => {});
    const req = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'git status' },
    };
    const decision = await coordinatePermissionDecision({
      request: req,
      decisionMemory: {
        list: vi.fn(async () => [grantRow('/perm2test/project-a')]),
        put,
      } as never,
      // Sibling of the granted root — the project-a grant must NOT auto-allow.
      deterministicRailsInput: shellIn('/perm2test/project-b'),
      tail,
    });
    expect(tail).toHaveBeenCalledOnce();
    expect(req.decisionOptions).toEqual([
      'allow_persistent_rule',
      'allow_once',
      'cancel',
    ]);
    expect(put).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ approved: false });
  });

  it('domain guard: "this folder" approves a trustedRootLearn request with no suggestion', () => {
    const learnReq: PermissionApprovalRequest = {
      ...request,
      decisionOptions: ['allow_persistent_rule', 'allow_once', 'cancel'],
      trustedRootLearn: true,
    };
    expect(
      decisionForMode(learnReq, 'allow_persistent_rule', 'owner-1'),
    ).toMatchObject({ approved: true, mode: 'allow_persistent_rule' });
    // Without the flag the same suggestion-less request collapses to cancel.
    const plainReq: PermissionApprovalRequest = {
      ...request,
      decisionOptions: ['allow_persistent_rule', 'allow_once', 'cancel'],
    };
    expect(
      decisionForMode(plainReq, 'allow_persistent_rule', 'owner-1'),
    ).toMatchObject({ approved: false, mode: 'cancel' });
  });

  it('spawn registration stores and removes the host restriction by agent/run key', () => {
    const key = {
      sourceAgentFolder: 'main_agent',
      responseKeyId: 'response-key-run-1',
    };
    registerWorkerPermissionRunRestriction({
      ...key,
      hideAuthorityTools: true,
      runKind: 'scheduled',
      jobId: 'job-1',
      runId: 'run-1',
      parentTaskId: 'task-parent',
    });
    expect(permissionRunRestriction(key)).toEqual({
      hideAuthorityTools: true,
      runKind: 'scheduled',
      jobId: 'job-1',
      runId: 'run-1',
      parentTaskId: 'task-parent',
    });
    unregisterPermissionRunRestriction(key);
    expect(permissionRunRestriction(key)).toBeUndefined();
  });

  it('exposes the approver label from AgentInput through setupPermissionRunRestriction into the registry', () => {
    const setup = setupPermissionRunRestriction(
      'main_agent',
      {
        appId: 'app:test',
        agentId: 'agent:test',
        threadId: 'thread:test',
        memoryUserId: 'person:approver',
        memoryUserLabel: 'Approver',
      },
      false,
    );
    const key = {
      sourceAgentFolder: 'main_agent',
      responseKeyId: setup.ipcAuth.responseKeyId,
    };

    expect(permissionRunRestriction(key)).toMatchObject({
      memoryUserId: 'person:approver',
      memoryUserLabel: 'Approver',
    });

    setup.unregisterPermissionRunRestriction();
    expect(permissionRunRestriction(key)).toBeUndefined();
  });

  it('reaches the coordinator exactly once for an SDK worker IPC decision', async () => {
    const coordinate = vi.spyOn(
      permissionCoordinator,
      'coordinatePermissionDecision',
    );
    await resolvePermissionIpcDecision({
      request: {
        requestId: 'sdk-worker-once',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        toolInput: { command: 'echo hello' },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        conversationRoutes: () => ({}),
        requestPermissionApproval: vi.fn(async () =>
          permissionDecisionResult({
            approved: false,
            mode: 'cancel' as const,
          }),
        ),
        getPermissionRuntimeSettings: () => ({
          agents: { main_agent: { permissionMode: 'ask' as const } },
          permissions: { autoMode: {} },
          memory: { llm: { models: { extractor: 'sonnet' } } },
        }),
      } as never,
    });
    expect(coordinate).toHaveBeenCalledTimes(1);
    coordinate.mockRestore();
  });

  it('consults the host registry before the IPC tail', async () => {
    const key = {
      sourceAgentFolder: 'main_agent',
      responseKeyId: 'fixed-image-run',
    };
    registerWorkerPermissionRunRestriction({
      ...key,
      hideAuthorityTools: true,
      runKind: 'interactive',
      runId: 'run-1',
    });
    const requestPermissionApproval = vi.fn();
    await expect(
      resolvePermissionIpcDecision({
        request: {
          requestId: 'fixed-image-request',
          responseKeyId: key.responseKeyId,
          targetJid: ROUTED_JID,
          sourceAgentFolder: key.sourceAgentFolder,
          toolName: 'FileRead',
          toolInput: { path: 'README.md' },
        },
        sourceAgentFolder: key.sourceAgentFolder,
        deps: {
          conversationRoutes: liveRoutes,
          requestPermissionApproval,
          getPermissionRuntimeSettings: () => ({
            agents: {},
            permissions: { autoMode: {} },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      }),
    ).resolves.toMatchObject({
      approved: false,
      decidedBy: 'fixed_image',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    unregisterPermissionRunRestriction(key);
  });

  it("projects a job owner's remembered Allow after rails in exact tool-kind category-kind tool-place category-place order resolving an overridable ask to allow_once with human_decision provenance and humanDecisionRecordId never overriding a non-overridable rail never matching a place row for an escaping target refusing a routeless call with zero lookups and never consulting the repository for a null owner", async () => {
    const projectionRequest: PermissionApprovalRequest = {
      ...request,
      toolName: 'RunCommand',
      toolInput: { command: 'cat report.txt' },
    };
    const candidates = [
      [HumanDecisionScope.Exact, 'effect-job'],
      [HumanDecisionScope.Kind, 'kind:tool:RunCommand'],
      [HumanDecisionScope.Kind, 'kind:file_read'],
      [HumanDecisionScope.Place, 'place:tool:RunCommand:/workspace'],
      [HumanDecisionScope.Place, 'place:file_read:/workspace'],
    ] as const;
    const overridableRails = (input: { trustedRoots?: readonly string[] }) =>
      input.trustedRoots?.includes('/workspace')
        ? undefined
        : {
            railOutcome: 'ask' as const,
            railSignal: RailSignal.OutOfTrustedRoot,
            reason: 'outside the trusted root',
          };
    for (const [scope, scopeKey] of candidates) {
      const findHumanDecision = vi.fn(
        async ({
          candidates: actual,
        }: {
          candidates: Array<{ scopeKey: string }>;
        }) =>
          actual.some((candidate) => candidate.scopeKey === scopeKey)
            ? humanDecisionRow({
                outcome: HumanDecisionOutcome.Allow,
                scope,
                scopeKey,
              })
            : null,
      );
      const memory = {
        list: vi.fn(async () => []),
        findHumanDecision,
      } as never;
      await expect(
        coordinatePermissionDecision({
          request: { ...projectionRequest },
          analysis: {
            lane: PermissionLane.Autonomous,
            readOnlyMetaExecutor: false,
          },
          effectHash: 'effect-job',
          workspaceRoot: '/workspace',
          deterministicRails: overridableRails as never,
          deterministicRailsInput: { workspaceRoot: '/workspace' },
          decisionMemory: memory,
          humanDecisionProjection: {
            ownerPersonId: 'person-one',
            memory,
            warn: vi.fn(),
          },
          skipClassifierVerdictCache: true,
          tail: vi.fn(),
        }),
      ).resolves.toMatchObject({
        approved: true,
        mode: 'allow_once',
        decidedBy: 'human_decision',
        source: 'human_decision',
        repeatableForFutureRuns: true,
        humanDecisionRecordId: `human-allow-${scope}`,
      });
      expect(findHumanDecision).toHaveBeenCalledOnce();
    }

    for (const [railSignal, readOnlyMetaExecutor] of [
      [RailSignal.OutOfTrustedRoot, false],
      [RailSignal.UnsupportedMetaExecutor, true],
    ] as const) {
      for (const [scope, scopeKey] of candidates.slice(0, 2)) {
        const hardFloorRail = {
          railOutcome: 'ask' as const,
          railSignal,
          reason: 'hard floor asks',
          hardFloor: true as const,
        };
        const findHumanDecision = vi.fn(async () =>
          humanDecisionRow({
            outcome: HumanDecisionOutcome.Allow,
            scope,
            scopeKey,
          }),
        );
        const tail = vi.fn(async (context?: PermissionDecisionTailContext) => {
          expect(context?.railDecision).toBe(hardFloorRail);
          return decisionForMode(projectionRequest, 'cancel', 'owner', 'human');
        });
        await expect(
          coordinatePermissionDecision({
            request: { ...projectionRequest },
            analysis: {
              lane: PermissionLane.Autonomous,
              readOnlyMetaExecutor,
            },
            effectHash: 'effect-job',
            workspaceRoot: '/workspace',
            deterministicRails: () => hardFloorRail,
            decisionMemory: { findHumanDecision } as never,
            humanDecisionProjection: {
              ownerPersonId: 'person-one',
              memory: { findHumanDecision } as never,
              warn: vi.fn(),
            },
            skipClassifierVerdictCache: true,
            tail,
          }),
        ).resolves.toMatchObject({ approved: false, decidedBy: 'owner' });
        expect(findHumanDecision).not.toHaveBeenCalled();
        expect(tail).toHaveBeenCalledOnce();
      }
    }

    const nonOverridableRail = {
      railOutcome: 'ask' as const,
      railSignal: RailSignal.Destructive,
      reason: 'destructive rail asks',
      hardFloor: true as const,
    };
    for (const [scope, scopeKey] of candidates) {
      const findHumanDecision = vi.fn(async () =>
        humanDecisionRow({
          outcome: HumanDecisionOutcome.Allow,
          scope,
          scopeKey,
        }),
      );
      const tail = vi.fn(async () =>
        decisionForMode(projectionRequest, 'cancel', 'owner', 'human'),
      );
      await expect(
        coordinatePermissionDecision({
          request: { ...projectionRequest },
          analysis: {
            lane: PermissionLane.Autonomous,
            readOnlyMetaExecutor: false,
          },
          effectHash: 'effect-job',
          workspaceRoot: '/workspace',
          deterministicRails: () => nonOverridableRail,
          humanDecisionProjection: {
            ownerPersonId: 'person-one',
            memory: { findHumanDecision } as never,
            warn: vi.fn(),
          },
          skipClassifierVerdictCache: true,
          tail,
        }),
      ).resolves.toMatchObject({ approved: false, decidedBy: 'owner' });
      expect(findHumanDecision).not.toHaveBeenCalled();
      expect(tail).toHaveBeenCalledOnce();
    }

    const escapingFind = vi.fn(
      async ({
        candidates: actual,
      }: {
        candidates: Array<{ scopeKey: string }>;
      }) =>
        actual.some(({ scopeKey }) => scopeKey === 'place:file_read:/workspace')
          ? humanDecisionRow({
              outcome: HumanDecisionOutcome.Allow,
              scope: HumanDecisionScope.Place,
              scopeKey: 'place:file_read:/workspace',
            })
          : null,
    );
    const escapingMemory = {
      list: vi.fn(async () => []),
      findHumanDecision: escapingFind,
    } as never;
    await expect(
      coordinatePermissionDecision({
        request: { ...projectionRequest },
        analysis: {
          lane: PermissionLane.Autonomous,
          readOnlyMetaExecutor: false,
        },
        effectHash: 'effect-job',
        workspaceRoot: '/workspace',
        deterministicRails: () => ({
          railOutcome: 'ask',
          railSignal: RailSignal.OutOfTrustedRoot,
          reason: 'target escapes the candidate root',
        }),
        deterministicRailsInput: { workspaceRoot: '/workspace' },
        decisionMemory: escapingMemory,
        humanDecisionProjection: {
          ownerPersonId: 'person-one',
          memory: escapingMemory,
          warn: vi.fn(),
        },
        skipClassifierVerdictCache: true,
        tail: async () =>
          decisionForMode(projectionRequest, 'cancel', 'owner', 'human'),
      }),
    ).resolves.toMatchObject({ approved: false, decidedBy: 'owner' });
    expect(escapingFind).toHaveBeenCalledOnce();
    expect(escapingFind.mock.calls[0]![0].candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: HumanDecisionScope.Place }),
      ]),
    );

    // A missing route refuses before any saved approval is read.
    const routelessFind = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: { ...projectionRequest },
        routeRefusal: () => 'route gone',
        analysis: {
          lane: PermissionLane.Autonomous,
          readOnlyMetaExecutor: false,
        },
        effectHash: 'effect-job',
        workspaceRoot: '/workspace',
        deterministicRails: () => undefined,
        humanDecisionProjection: {
          ownerPersonId: 'person-one',
          memory: { findHumanDecision: routelessFind } as never,
          warn: vi.fn(),
        },
        skipClassifierVerdictCache: true,
        tail: vi.fn(),
      }),
    ).resolves.toMatchObject({ approved: false, decidedBy: 'route' });
    expect(routelessFind).not.toHaveBeenCalled();

    const ownerlessFind = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: { ...projectionRequest },
        analysis: {
          lane: PermissionLane.Autonomous,
          readOnlyMetaExecutor: false,
        },
        effectHash: 'effect-job',
        workspaceRoot: '/workspace',
        deterministicRails: () => undefined,
        humanDecisionProjection: {
          ownerPersonId: null,
          memory: { findHumanDecision: ownerlessFind } as never,
          warn: vi.fn(),
        },
        skipClassifierVerdictCache: true,
        tail: async () =>
          decisionForMode(projectionRequest, 'cancel', 'owner', 'human'),
      }),
    ).resolves.toMatchObject({ approved: false, decidedBy: 'owner' });
    expect(ownerlessFind).not.toHaveBeenCalled();
  });
});
