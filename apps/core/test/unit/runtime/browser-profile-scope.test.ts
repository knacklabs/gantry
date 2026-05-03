import { describe, expect, it } from 'vitest';

import {
  formatBrowserProfileLabel,
  resolveConversationBrowserProfile,
} from '@core/shared/browser-profile-scope.js';

describe('browser profile scope', () => {
  it('derives a stable profile from agent and conversation', () => {
    const profile = resolveConversationBrowserProfile({
      agentId: 'Kai Agent',
      workspaceKey: 'ignored',
      conversationId: 'telegram:-1003986348737',
    });

    expect(profile).toMatch(/^c-kai-agent-[a-f0-9]{12}$/);
    expect(
      resolveConversationBrowserProfile({
        agentId: 'Kai Agent',
        conversationId: 'telegram:-1003986348737',
      }),
    ).toBe(profile);
  });

  it('keeps different conversations isolated for the same agent', () => {
    const dm = resolveConversationBrowserProfile({
      agentId: 'kai',
      conversationId: 'telegram:5759865942',
    });
    const channel = resolveConversationBrowserProfile({
      agentId: 'kai',
      conversationId: 'telegram:-1003986348737',
    });

    expect(dm).not.toBe(channel);
  });

  it('falls back to the shared default only when no conversation is known', () => {
    expect(resolveConversationBrowserProfile({ workspaceKey: 'kai' })).toBe(
      'myclaw',
    );
  });

  it('formats user-facing browser profile labels', () => {
    expect(
      formatBrowserProfileLabel({
        agentName: 'Kai',
        conversationKind: 'dm',
      }),
    ).toBe('Kai DM browser');
    expect(formatBrowserProfileLabel({ agentName: 'Kai' })).toBe(
      'Kai conversation browser',
    );
  });
});
