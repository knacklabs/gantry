import { beforeEach, expect, it, vi } from 'vitest';

const browserAuth = vi.hoisted(() => ({
  browserCsrfHeader: vi.fn(() => ({ 'x-csrf-token': 'test-csrf' })),
  browserFetch: vi.fn(),
}));

vi.mock('../../lib/auth/browser-auth', () => browserAuth);

import {
  discoverChannelConversations,
  loadConversationMembers,
} from './channel-account-queries';

beforeEach(() => browserAuth.browserFetch.mockReset());

it('surfaces safe discovery guidance returned by the control API', async () => {
  browserAuth.browserFetch.mockResolvedValue({
    ok: false,
    json: vi.fn().mockResolvedValue({
      error: {
        message:
          'Ensure bot has conversations:read and is invited to target channels.',
      },
    }),
  });

  await expect(discoverChannelConversations('account:slack')).rejects.toThrow(
    'Ensure bot has conversations:read and is invited to target channels.',
  );
});

it('uses the generic message when the error response is not parseable', async () => {
  browserAuth.browserFetch.mockResolvedValue({
    ok: false,
    json: vi.fn().mockRejectedValue(new Error('invalid JSON')),
  });

  await expect(discoverChannelConversations('account:slack')).rejects.toThrow(
    'Gantry could not discover conversations for this account.',
  );
});

it('uses the provider-neutral conversation-members endpoint', async () => {
  browserAuth.browserFetch.mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ memberIds: ['user:one'] }),
  });

  await expect(loadConversationMembers('conversation:teams')).resolves.toEqual({
    memberIds: ['user:one'],
  });
  expect(browserAuth.browserFetch).toHaveBeenCalledWith(
    '/ui/api/conversations/conversation%3Ateams/members',
    { credentials: 'same-origin' },
  );
});
