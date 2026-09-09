import { describe, expect, it, vi } from 'vitest';
import { permissionDecisionResult } from '../channels/permission-approval-result-helpers.js';

import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { PermissionLane, RailSignal } from '@core/domain/permission-lane.js';
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
  FAMILY_RULE_RAIL_HIT_REASON,
  PERMISSION_DECISION_STAGES,
  type PermissionDecisionTailContext,
  permissionRunRestriction,
  unregisterPermissionRunRestriction,
} from '@core/runtime/permission-decision-coordinator.js';
import * as permissionCoordinator from '@core/runtime/permission-decision-coordinator.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';
import { computePermissionEffectHash } from '@core/domain/permission-effect-key.js';

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
      toolName: 'mcp__gantry__send_message',
      toolInput: { text: 'status' },
      decisionReason: workerMiss,
      unattended: true,
    };
    try {
      const decision = await resolvePermissionIpcDecision({
        request: ipcRequest,
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: () => ({}),
          requestPermissionApproval: vi.fn(),
          getToolRepository: () => ({
            listAgentToolBindings: vi.fn(async () => [
              {
                status: 'active',
                toolId: 'tool:send-message',
                personId: null,
              },
            ]),
            getTool: vi.fn(async () => ({
              appId: 'default',
              name: 'mcp__gantry__send_message',
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
        reason: 'Allowed by autonomous tool rule mcp__gantry__send_message.',
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

  it('keeps the pinned stage order and runs the remembered No before hard restrictions and the remembered Allow after the rails and the trusted-root stage but before the classifier cache, never consulting the port under ask, auto_strict or a job lane, without a person, or under a non-overridable rail ask, resolves the workspace root from the rails input when the top-level one is absent, and maps decidedBy human_decision to repeatable human_decision provenance', async () => {
    expect(PERMISSION_DECISION_STAGES).toEqual([
      'pre_coordination_route_analysis',
      'exact_remembered_deny',
      'hard_restrictions',
      'reviewed_rules',
      'deterministic_rails',
      'conditional_trusted_root',
      'remembered_allows',
      'classifier_cache',
      'tail',
    ]);
    for (const reviewedRuleDecision of [
      undefined,
      { ...reviewedAllow, isFamilyRule: true },
    ]) {
      const observed: string[] = [];
      let railEvaluation = 0;
      await coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        analysis: Object.freeze({
          lane: PermissionLane.InteractiveAuto,
          readOnlyMetaExecutor: false,
        }),
        reviewedRuleDecision: async () => {
          observed.push('reviewed_rules');
          return reviewedRuleDecision;
        },
        deterministicRails: () => {
          railEvaluation += 1;
          if (railEvaluation > 1) return undefined;
          observed.push('deterministic_rails');
          return {
            railOutcome: 'ask',
            reason: 'outside the trusted root',
            railSignal: RailSignal.OutOfTrustedRoot,
          };
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
            observed.push('classifier_cache');
            return {
              decision: 'allow',
              reason: 'cached allow',
              risk_level: 'low',
            };
          },
        } as never,
        tail: async (context) => {
          expect(context?.cachedClassifierVerdict).toMatchObject({
            decision: 'allow',
            reason: 'cached allow',
          });
          observed.push('tail');
          return {
            approved: false,
            mode: 'cancel',
            decidedBy: 'human',
          };
        },
      });
      expect(observed).toEqual([
        'exact_remembered_deny',
        'reviewed_rules',
        'deterministic_rails',
        'conditional_trusted_root',
        'remembered_allows',
        'classifier_cache',
        'tail',
      ]);
      expect(railEvaluation).toBe(2);
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
    expect(nonOverridableFind).toHaveBeenCalledTimes(2);
    expect(nonOverridableFind).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        candidates: [
          { scope: HumanDecisionScope.Exact, scopeKey: 'non-overridable' },
        ],
      }),
    );
    expect(nonOverridableFind).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        candidates: [
          { scope: HumanDecisionScope.Exact, scopeKey: 'non-overridable' },
        ],
      }),
    );
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

  it('a rail hit inside an allowed family asks and permits allow-once only', async () => {
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
        `${FAMILY_RULE_RAIL_HIT_REASON} Destructive command requires approval.`,
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
    await expect(
      coordinatePermissionDecision({
        request: cachedRequest,
        effectHash: 'effect-hash-1',
        decisionMemory: { getClassifierVerdict } as never,
        deterministicRails: () => undefined,
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
      effectHash: 'effect-hash-1',
    });
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

    await expect(
      coordinatePermissionDecision({
        request: { ...request },
        effectHash: 'expired-effect-hash',
        decisionMemory: { getClassifierVerdict } as never,
        deterministicRails: () => undefined,
        tail,
      }),
    ).resolves.toEqual(liveClassifierDecision);
    expect(getClassifierVerdict).toHaveBeenCalledOnce();
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
        conversationAHash,
        { decision: 'allow' as const, reason: 'cached low risk' },
      ],
    ]);
    const getClassifierVerdict = vi.fn(
      async ({ effectHash }: { effectHash: string }) =>
        cached.get(effectHash) ?? null,
    );
    const decisionMemory = { getClassifierVerdict } as never;
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
          effectHash,
          decisionMemory,
          deterministicRails: () => undefined,
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
        effectHash: computePermissionEffectHash({
          request: otherConversationRequest,
        }),
        decisionMemory,
        deterministicRails: () => undefined,
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

  it('answers a hard-floor destructive ask from a remembered exact Allow (T3b-AC3 keys the consult on the rail case, never its hardFloor flag; story S4) while a protected-path ask never reaches exact memory', async () => {
    const findHumanDecision = vi.fn(async () =>
      humanDecisionRow({
        outcome: HumanDecisionOutcome.Allow,
        scope: HumanDecisionScope.Exact,
        scopeKey: 'destructive-allow',
      }),
    );
    const interactive = Object.freeze({
      lane: PermissionLane.InteractiveAuto,
      readOnlyMetaExecutor: false,
    });
    const destructiveTail = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        analysis: interactive,
        effectHash: 'destructive-allow',
        decisionMemory: { findHumanDecision } as never,
        deterministicRails: () => ({
          railOutcome: 'ask' as const,
          reason: 'Destructive command requires approval.',
          railSignal: RailSignal.Destructive,
          hardFloor: true as const,
        }),
        tail: destructiveTail,
      }),
    ).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'human_decision',
    });
    // The No stage reads the port once before the rails, the Allow stage once after.
    expect(findHumanDecision).toHaveBeenCalledTimes(2);
    expect(destructiveTail).not.toHaveBeenCalled();

    const tailDecision = {
      approved: false,
      mode: 'cancel' as const,
      decidedBy: 'human',
    };
    const secretTail = vi.fn(async () => tailDecision);
    await expect(
      coordinatePermissionDecision({
        request: { ...request, personId: 'person-one' },
        analysis: interactive,
        effectHash: 'destructive-allow',
        decisionMemory: { findHumanDecision } as never,
        deterministicRails: () => ({
          railOutcome: 'ask' as const,
          reason: 'Command references a credential, secret, or protected path.',
          railSignal: RailSignal.SecretPath,
          hardFloor: true as const,
        }),
        tail: secretTail,
      }),
    ).resolves.toEqual(tailDecision);
    // Only the No stage read the port; the Allow consult never ran.
    expect(findHumanDecision).toHaveBeenCalledTimes(3);
    expect(secretTail).toHaveBeenCalledOnce();
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
          sourceAgentFolder: key.sourceAgentFolder,
          toolName: 'FileRead',
          toolInput: { path: 'README.md' },
        },
        sourceAgentFolder: key.sourceAgentFolder,
        deps: {
          conversationRoutes: () => ({}),
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

  it("projects a job owner's remembered Allow after rails in exact tool-kind category-kind tool-place category-place order resolving an overridable ask to allow_once with human_decision provenance and humanDecisionRecordId never overriding a non-overridable rail never matching a place row for an escaping target letting a guard-returned decision stand with zero lookups and never consulting the repository for a null owner", async () => {
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
      const guard = vi.fn(() => undefined);
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
            guard,
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
      expect(guard).toHaveBeenCalledOnce();
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
        const guard = vi.fn(() => undefined);
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
              guard,
              warn: vi.fn(),
            },
            skipClassifierVerdictCache: true,
            tail,
          }),
        ).resolves.toMatchObject({ approved: false, decidedBy: 'owner' });
        expect(guard).not.toHaveBeenCalled();
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
            guard: vi.fn(() => undefined),
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
          guard: vi.fn(() => undefined),
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

    const guardedDecision = decisionForMode(
      projectionRequest,
      'cancel',
      'runtime',
      'machine',
    );
    const guardedFind = vi.fn();
    const guard = vi.fn(() => guardedDecision);
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
          ownerPersonId: 'person-one',
          memory: { findHumanDecision: guardedFind } as never,
          guard,
          warn: vi.fn(),
        },
        skipClassifierVerdictCache: true,
        tail: vi.fn(),
      }),
    ).resolves.toBe(guardedDecision);
    expect(guardedFind).not.toHaveBeenCalled();

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
          guard: vi.fn(() => undefined),
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
