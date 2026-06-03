import { describe, expect, it, vi } from 'vitest';

import { adaptSessionControlPort } from '@core/control/server/session-control-port.js';

describe('adaptSessionControlPort', () => {
  it('maps ensureAppSession.folder into repository workspaceFolder', async () => {
    const ensureAppSession = vi.fn(async (input: unknown) => input);
    const control = {
      ensureAppSession,
      getAppSessionById: vi.fn(),
      getAppSessionByChatJid: vi.fn(),
      getWebhookById: vi.fn(),
      upsertAppResponseRoute: vi.fn(),
      getAppResponseRoute: vi.fn(),
    };
    const port = adaptSessionControlPort(control as never);

    await port.ensureAppSession({
      appId: 'app-one',
      conversationId: 'conv-one',
      conversationJid: 'app:app-one:conv-one',
      folder: 'app_scope_folder',
      title: 'Conversation One',
      defaultResponseMode: 'sse',
      defaultWebhookId: 'webhook-1',
    });

    expect(ensureAppSession).toHaveBeenCalledTimes(1);
    const [input] = ensureAppSession.mock.calls[0]!;
    expect(input).toMatchObject({
      appId: 'app-one',
      conversationId: 'conv-one',
      chatJid: 'app:app-one:conv-one',
      workspaceFolder: 'app_scope_folder',
      title: 'Conversation One',
      defaultResponseMode: 'sse',
      defaultWebhookId: 'webhook-1',
    });
    expect(input).not.toHaveProperty('folder');
    expect(input).not.toHaveProperty('conversationJid');
  });
});
