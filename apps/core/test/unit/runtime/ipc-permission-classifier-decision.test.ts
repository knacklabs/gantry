import { describe, expect, it, vi } from 'vitest';

import { formatPermissionPromptText } from '@core/channels/permission-interaction.js';
import type {
  PermissionRiskCategory,
  PermissionRiskLevel,
} from '@core/domain/types.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';

async function resolveWithClassifierRisk(input: {
  toolName: string;
  toolInput: unknown;
  riskLevel: PermissionRiskLevel;
  riskCategory: PermissionRiskCategory;
}) {
  const requestPermissionApproval = vi.fn(async () => ({
    approved: false,
    mode: 'cancel' as const,
    decidedBy: 'owner',
  }));

  const decision = await resolvePermissionIpcDecision({
    request: {
      requestId: `classifier-risk-${input.riskCategory}`,
      sourceAgentFolder: 'main_agent',
      toolName: input.toolName,
      toolInput: input.toolInput,
    },
    sourceAgentFolder: 'main_agent',
    deps: {
      conversationRoutes: () => ({}),
      requestPermissionApproval,
      classifierConsult: vi.fn(async () => ({
        risk_level: input.riskLevel,
        risk_category: input.riskCategory,
        reason: 'Classifier risk assessment.',
        latencyMs: 1,
      })),
      publishRuntimeEvent: vi.fn(async () => undefined),
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

  return { decision, requestPermissionApproval };
}

describe('IPC permission classifier decision', () => {
  it('keeps a destructive rail category and high severity over a low benign classifier verdict', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'RunCommand',
        toolInput: { command: 'rm -rf ./build' },
        riskLevel: 'low',
        riskCategory: 'benign',
      });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      risk_level: 'high',
      risk_category: 'destructive',
    });
  });

  it('keeps a secret rail category and raises severity to the classifier critical level', async () => {
    const { decision, requestPermissionApproval } =
      await resolveWithClassifierRisk({
        toolName: 'RunCommand',
        toolInput: { command: 'cat ~/.ssh/id_rsa' },
        riskLevel: 'critical',
        riskCategory: 'network',
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
      risk_level: 'medium',
      risk_category: 'network',
    });
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
