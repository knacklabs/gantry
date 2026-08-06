import { describe, expect, it, vi } from 'vitest';

import { ensureSessionForControl } from '@core/control/server/session-interaction-adapter.js';

describe('session interaction control adapter', () => {
  it('projects non-default app routes without persisting them into the default canonical store', async () => {
    const registerGroup = vi.fn();
    const projectConversationRoute = vi.fn();
    const registerGroupResult = {
      conversationJid: 'app:manipal-tender-copilot:discovery',
      group: { name: 'Manipal', folder: 'agent_manipal' },
    };
    const ensureSession = vi.fn(async () => ({
      session: { appId: 'manipal-tender-copilot' },
      registerGroup: registerGroupResult,
    }));

    await ensureSessionForControl(
      {
        app: { registerGroup, projectConversationRoute },
        sessionInteraction: { ensureSession },
      } as never,
      {
        appId: 'manipal-tender-copilot',
        conversationId: 'discovery',
      },
    );

    expect(projectConversationRoute).toHaveBeenCalledWith(
      registerGroupResult.conversationJid,
      registerGroupResult.group,
    );
    expect(registerGroup).not.toHaveBeenCalled();
  });
});
