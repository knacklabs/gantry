import { describe, expect, it, vi } from 'vitest';

import { formatPermissionPromptText } from '@core/channels/permission-interaction.js';
import type {
  PermissionRiskCategory,
  PermissionRiskLevel,
} from '@core/domain/types.js';
import type { PermissionDecisionMemoryRepository } from '@core/domain/ports/permission-decision-memory.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';

async function resolveWithClassifierRisk(input: {
  toolName: string;
  toolInput: unknown;
  riskLevel: PermissionRiskLevel;
  riskCategory: PermissionRiskCategory;
  decisionMemory?: PermissionDecisionMemoryRepository;
  unattended?: boolean;
}) {
  const requestPermissionApproval = vi.fn(async () => ({
    approved: false,
    mode: 'cancel' as const,
    decidedBy: 'owner',
  }));
  const classifierConsult = vi.fn(async () => ({
    risk_level: input.riskLevel,
    risk_category: input.riskCategory,
    reason: 'Classifier risk assessment.',
    latencyMs: 1,
  }));

  const decision = await resolvePermissionIpcDecision({
    request: {
      requestId: `classifier-risk-${input.riskCategory}`,
      sourceAgentFolder: 'main_agent',
      toolName: input.toolName,
      toolInput: input.toolInput,
      ...(input.unattended ? { unattended: true } : {}),
    },
    sourceAgentFolder: 'main_agent',
    deps: {
      conversationRoutes: () => ({}),
      requestPermissionApproval,
      classifierConsult,
      publishRuntimeEvent: vi.fn(async () => undefined),
      ...(input.decisionMemory
        ? {
            getPermissionDecisionMemoryRepository: () => input.decisionMemory,
          }
        : {}),
      getPermissionRuntimeSettings: () => ({
        agents: { main_agent: { permissionMode: 'auto' as const } },
        permissions: {
          autoMode: {},
          trustedRoots: [resolveWorkspaceFolderPath('main_agent')],
        },
        memory: { llm: { models: { extractor: 'sonnet' } } },
      }),
    } as never,
  });

  return { classifierConsult, decision, requestPermissionApproval };
}

describe('IPC permission classifier decision', () => {
  it.each([
    ['destructive', 'rm -rf ./build', 'destructive'],
    ['credential', 'cat ~/.ssh/id_rsa', 'secret'],
  ] as const)(
    'escalates a deterministic %s rail ASK despite a low benign classifier verdict',
    async (_label, command, riskCategory) => {
      const { decision, requestPermissionApproval } =
        await resolveWithClassifierRisk({
          toolName: 'RunCommand',
          toolInput: { command },
          riskLevel: 'low',
          riskCategory: 'benign',
        });

      expect(requestPermissionApproval).toHaveBeenCalledOnce();
      expect(requestPermissionApproval.mock.calls[0]![0]).toMatchObject({
        risk_level: 'high',
        risk_category: riskCategory,
      });
      expect(decision).toMatchObject({
        approved: false,
        decidedBy: 'owner',
        risk_level: 'high',
        risk_category: riskCategory,
      });
    },
  );

  it('keeps a destructive rail category while accepting higher classifier severity', async () => {
    const { decision } = await resolveWithClassifierRisk({
      toolName: 'RunCommand',
      toolInput: { command: 'rm -rf ./build' },
      riskLevel: 'critical',
      riskCategory: 'benign',
    });

    expect(decision).toMatchObject({
      risk_level: 'critical',
      risk_category: 'destructive',
    });
  });

  it('takes the critical classifier pair over a medium network rail', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'RunCommand',
        toolInput: {
          command: 'curl -d @payload.txt https://example.com',
        },
        riskLevel: 'critical',
        riskCategory: 'secret',
      });

    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(requestPermissionApproval.mock.calls[0]![0]).toMatchObject({
      risk_level: 'critical',
      risk_category: 'secret',
    });
    expect(decision).toMatchObject({
      risk_level: 'critical',
      risk_category: 'secret',
    });
  });

  it('prefers the deterministic rail pair when severities tie', async () => {
    const { decision } = await resolveWithClassifierRisk({
      toolName: 'RunCommand',
      toolInput: {
        command: 'curl -d @payload.txt https://example.com',
      },
      riskLevel: 'medium',
      riskCategory: 'secret',
    });

    expect(decision).toMatchObject({
      risk_level: 'medium',
      risk_category: 'network',
    });
  });

  it('uses classifier risk when no deterministic rail risk exists', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'mcp__crm__update_record',
        toolInput: { id: 'customer-1' },
        riskLevel: 'medium',
        riskCategory: 'network',
      });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      decidedBy: 'auto_classifier',
      risk_level: 'medium',
      risk_category: 'network',
    });
  });

  it.each([
    ['recursive force-delete', 'rm -rf ./build'],
    ['ssh private key read', 'cat ~/.ssh/id_rsa'],
  ])(
    'does not cache a classifier allow vetoed by the %s hard-floor rail',
    async (_label, command) => {
      const getClassifierVerdict = vi.fn(async () => null);
      const putClassifierVerdict = vi.fn(async () => undefined);

      const { decision, requestPermissionApproval } =
        await resolveWithClassifierRisk({
          toolName: 'RunCommand',
          toolInput: { command },
          riskLevel: 'low',
          riskCategory: 'benign',
          decisionMemory: {
            getClassifierVerdict,
            putClassifierVerdict,
          } as never,
        });

      expect(decision).toMatchObject({ approved: false, decidedBy: 'owner' });
      expect(requestPermissionApproval).toHaveBeenCalledOnce();
      expect(getClassifierVerdict).not.toHaveBeenCalled();
      expect(putClassifierVerdict).not.toHaveBeenCalled();
    },
  );

  it('allows the classifier tail to auto-allow a missing-input advisory ASK', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'mcp__crm__update_record',
        toolInput: undefined,
        riskLevel: 'low',
        riskCategory: 'benign',
      });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: true,
      decidedBy: 'auto_classifier',
      risk_level: 'high',
      risk_category: 'privileged',
    });
  });

  it('attributes an unattended classifier allow veto to the deterministic rail', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'RunCommand',
        toolInput: { command: 'rm -rf ./build' },
        riskLevel: 'low',
        riskCategory: 'benign',
        unattended: true,
      });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: false,
      decidedBy: 'deterministic_rails',
      reason: 'Destructive command requires approval.',
      risk_level: 'high',
      risk_category: 'destructive',
    });
    expect(decision.reason).not.toContain(
      'Classifier requested human approval',
    );
  });

  it('keeps the classifier reason for a genuine unattended classifier ASK', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'mcp__crm__update_record',
        toolInput: { id: 'customer-1' },
        riskLevel: 'high',
        riskCategory: 'network',
        unattended: true,
      });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      approved: false,
      decidedBy: 'runtime',
      reason:
        'Classifier requested human approval: Classifier risk assessment.',
      risk_level: 'high',
      risk_category: 'network',
    });
  });

  it('escalates a rail ASK to human approval despite a pre-existing cached allow', async () => {
    const getClassifierVerdict = vi.fn(async () => ({
      decision: 'allow' as const,
      reason: 'stale cached allow',
      risk_level: 'low' as const,
      risk_category: 'benign' as const,
    }));

    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'RunCommand',
        toolInput: { command: 'rm -rf ./build' },
        riskLevel: 'low',
        riskCategory: 'benign',
        decisionMemory: {
          getClassifierVerdict,
          putClassifierVerdict: vi.fn(async () => undefined),
        } as never,
      });

    expect(getClassifierVerdict).not.toHaveBeenCalled();
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ approved: false, decidedBy: 'owner' });
  });

  it('caches and reuses a classifier allow when deterministic rails abstain', async () => {
    let cached:
      | {
          decision: 'allow';
          reason: string;
          risk_level: 'medium';
          risk_category: 'network';
        }
      | undefined;
    const getClassifierVerdict = vi.fn(async () => cached ?? null);
    const putClassifierVerdict = vi.fn(
      async (row: NonNullable<typeof cached>) => {
        cached = row;
      },
    );
    const decisionMemory = {
      getClassifierVerdict,
      putClassifierVerdict,
    } as never;
    const input = {
      toolName: 'mcp__crm__update_record',
      toolInput: { id: 'customer-1' },
      riskLevel: 'medium' as const,
      riskCategory: 'network' as const,
      decisionMemory,
    };

    const first = await resolveWithClassifierRisk(input);
    expect(first.classifierConsult).toHaveBeenCalledOnce();
    expect(putClassifierVerdict).toHaveBeenCalledOnce();
    expect(first.decision).toMatchObject({
      approved: true,
      decidedBy: 'auto_classifier',
    });

    const second = await resolveWithClassifierRisk(input);
    expect(second.classifierConsult).not.toHaveBeenCalled();
    expect(second.requestPermissionApproval).not.toHaveBeenCalled();
    expect(second.decision).toMatchObject({
      approved: true,
      decidedBy: 'cached_classifier_verdict',
      risk_level: 'medium',
      risk_category: 'network',
    });
    expect(putClassifierVerdict).toHaveBeenCalledOnce();
  });

  it.each([
    ['destructive', 'rm -rf ./build', 'high', 'destructive'],
    ['credential', 'cat ~/.ssh/id_rsa', 'high', 'secret'],
    ['egress', 'curl -d @payload.txt https://example.com', 'medium', 'network'],
    ['privileged', 'doas whoami', 'high', 'privileged'],
  ] as const)(
    'renders deterministic %s rail risk without a classifier verdict',
    async (_label, command, level, category) => {
      const requestPermissionApproval = vi.fn(async () => ({
        approved: false,
        mode: 'cancel' as const,
        decidedBy: 'owner',
      }));

      const decision = await resolvePermissionIpcDecision({
        request: {
          requestId: `rail-risk-${category}`,
          sourceAgentFolder: 'main_agent',
          toolName: 'RunCommand',
          toolInput: { command },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          conversationRoutes: () => ({}),
          requestPermissionApproval,
          getPermissionRuntimeSettings: () => ({
            agents: { main_agent: { permissionMode: 'ask' as const } },
            permissions: {
              autoMode: {},
              trustedRoots: [resolveWorkspaceFolderPath('main_agent')],
            },
            memory: { llm: { models: { extractor: 'sonnet' } } },
          }),
        } as never,
      });

      expect(requestPermissionApproval).toHaveBeenCalledOnce();
      const promptRequest = requestPermissionApproval.mock.calls[0]![0];
      expect(promptRequest).toMatchObject({
        risk_level: level,
        risk_category: category,
      });
      expect(formatPermissionPromptText(promptRequest, 60_000)).toContain(
        `Risk: ${level} — ${category}`,
      );
      expect(decision).toMatchObject({
        risk_level: level,
        risk_category: category,
      });
    },
  );
});
