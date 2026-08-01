import { describe, expect, it } from 'vitest';

import { resolveConversationBrowserProfile } from '@core/shared/browser-profile-scope.js';

const CHAT = 'sl:C123';
const FOLDER = 'alpha';

describe('browser profile scope', () => {
  it('gives two provider accounts in one conversation DIFFERENT profiles', () => {
    // The isolation bug: a Chrome profile carries logged-in sessions, so two
    // accounts sharing one means one inherits the other's logins.
    const first = resolveConversationBrowserProfile({
      agentId: FOLDER,
      workspaceKey: FOLDER,
      conversationId: CHAT,
      providerAccountId: 'slack:team-a',
    });
    const second = resolveConversationBrowserProfile({
      agentId: FOLDER,
      workspaceKey: FOLDER,
      conversationId: CHAT,
      providerAccountId: 'slack:team-b',
    });

    expect(first).not.toBe(second);
  });

  it('is stable for the same account', () => {
    const args = {
      agentId: FOLDER,
      workspaceKey: FOLDER,
      conversationId: CHAT,
      providerAccountId: 'slack:team-a',
    };
    expect(resolveConversationBrowserProfile(args)).toBe(
      resolveConversationBrowserProfile(args),
    );
  });

  it('never lets an absent account collide with a resolved one', () => {
    // `null` hashes as the empty string, which no real account id can equal —
    // so unresolved turns are isolated without needing a sentinel value.
    const absent = resolveConversationBrowserProfile({
      agentId: FOLDER,
      workspaceKey: FOLDER,
      conversationId: CHAT,
      providerAccountId: null,
    });
    for (const account of ['slack:team-a', 'telegram:bot-1', 'app:default']) {
      expect(absent).not.toBe(
        resolveConversationBrowserProfile({
          agentId: FOLDER,
          workspaceKey: FOLDER,
          conversationId: CHAT,
          providerAccountId: account,
        }),
      );
    }
  });

  it('leaves the no-conversation default profile shared across accounts', () => {
    // Deliberate boundary (decision 0092): the CLI/manual browser stays one
    // stable profile you can log into by hand.
    const a = resolveConversationBrowserProfile({
      agentId: FOLDER,
      providerAccountId: 'slack:team-a',
    });
    const b = resolveConversationBrowserProfile({
      agentId: FOLDER,
      providerAccountId: 'telegram:bot-1',
    });
    expect(a).toBe('gantry');
    expect(b).toBe('gantry');
  });
});

describe('per-turn browser credential', () => {
  it('maps only the issuing turn to its profile, and forgets it on release', async () => {
    const auth = await import('@core/runtime/ipc-auth.js');
    const scope = { workspaceKey: 'alpha', chatJid: 'sl:C1', threadId: null };
    auth.registerBrowserIpcAuthorization({
      ...scope,
      turnToken: 'token-a',
      browserProfileName: 'c-alpha-aaa',
    });
    auth.registerBrowserIpcAuthorization({
      ...scope,
      turnToken: 'token-b',
      browserProfileName: 'c-alpha-bbb',
    });

    // Two concurrent turns for different accounts get DIFFERENT profiles — the
    // thing a shared (workspace, chat, thread) key cannot express.
    expect(
      auth.browserTurnBinding({ ...scope, turnToken: 'token-a' })?.profileName,
    ).toBe('c-alpha-aaa');
    expect(
      auth.browserTurnBinding({ ...scope, turnToken: 'token-b' })?.profileName,
    ).toBe('c-alpha-bbb');

    // A token issued for ANOTHER caller does not resolve, even though it is live.
    expect(
      auth.browserTurnBinding({
        workspaceKey: 'beta',
        chatJid: 'sl:C1',
        threadId: null,
        turnToken: 'token-a',
      }),
    ).toBeUndefined();

    // An unknown or released token owns nothing; the handler refuses.
    expect(
      auth.browserTurnBinding({ ...scope, turnToken: 'token-c' }),
    ).toBeUndefined();
    auth.revokeBrowserIpcAuthorization({ ...scope, turnToken: 'token-a' });
    expect(
      auth.browserTurnBinding({ ...scope, turnToken: 'token-a' }),
    ).toBeUndefined();
    expect(
      auth.browserTurnBinding({ ...scope, turnToken: 'token-b' })?.profileName,
    ).toBe('c-alpha-bbb');
    // Leave no registration behind for other tests.
    auth.revokeBrowserIpcAuthorization({ ...scope, turnToken: 'token-b' });
  });

  it('refuses a tokenless request even when only one turn is live', async () => {
    // A scope-only fallback cannot be safe: authorization is refcounted per
    // (workspace, chat, thread), which concurrent account turns share, so a
    // runner could simply omit the field to reach the live turn's browser.
    const auth = await import('@core/runtime/ipc-auth.js');
    const { resolveBrowserTurnForRequest } =
      await import('@core/runtime/ipc-browser-requests.js');
    const scope = { workspaceKey: 'solo', chatJid: 'sl:CSOLO', threadId: null };
    auth.registerBrowserIpcAuthorization({
      ...scope,
      turnToken: 'solo-token',
      browserProfileName: 'c-solo-xyz',
      turnQueueKey: 'queue-solo',
    });

    expect(() =>
      resolveBrowserTurnForRequest({
        sourceAgentFolder: 'solo',
        chatJid: 'sl:CSOLO',
      }),
    ).toThrow(/no live turn owns this browser credential/);

    // The turn's OWN token still works.
    expect(
      resolveBrowserTurnForRequest({
        sourceAgentFolder: 'solo',
        chatJid: 'sl:CSOLO',
        turnToken: 'solo-token',
      }),
    ).toEqual({ profileName: 'c-solo-xyz', queueKey: 'queue-solo' });

    auth.revokeBrowserIpcAuthorization({ ...scope, turnToken: 'solo-token' });
  });

  it('refuses a stale token instead of rebinding it to a live turn', async () => {
    // Turn A is revoked while B stays live. A delayed request from A presents a
    // token that no longer resolves; falling back to B would hand A's runner
    // B's authenticated browser.
    const auth = await import('@core/runtime/ipc-auth.js');
    const { resolveBrowserTurnForRequest } =
      await import('@core/runtime/ipc-browser-requests.js');
    const scope = {
      workspaceKey: 'stale',
      chatJid: 'sl:CSTALE',
      threadId: null,
    };
    auth.registerBrowserIpcAuthorization({
      ...scope,
      turnToken: 'stale-a',
      browserProfileName: 'c-stale-a',
      turnQueueKey: 'q-a',
    });
    auth.registerBrowserIpcAuthorization({
      ...scope,
      turnToken: 'stale-b',
      browserProfileName: 'c-stale-b',
      turnQueueKey: 'q-b',
    });
    auth.revokeBrowserIpcAuthorization({ ...scope, turnToken: 'stale-a' });

    expect(() =>
      resolveBrowserTurnForRequest({
        sourceAgentFolder: 'stale',
        chatJid: 'sl:CSTALE',
        turnToken: 'stale-a',
      }),
    ).toThrow(/no live turn owns this browser credential/);

    auth.revokeBrowserIpcAuthorization({ ...scope, turnToken: 'stale-b' });
  });

  it('refuses a request with no live credential', async () => {
    const { resolveBrowserTurnForRequest } =
      await import('@core/runtime/ipc-browser-requests.js');
    expect(() =>
      resolveBrowserTurnForRequest({
        sourceAgentFolder: 'alpha',
        chatJid: 'sl:C1',
      }),
    ).toThrow(/no live turn owns this browser credential/);
  });
});
