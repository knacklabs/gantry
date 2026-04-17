import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { saveRuntimeSettings } from '@core/cli/runtime-settings.js';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

function registerMainGroups(
  harness: Awaited<ReturnType<typeof createHermeticRuntimeHarness>>,
) {
  harness.registerGroup({
    jid: 'tg:main',
    name: 'Telegram Main',
    folder: 'telegram_main',
    trigger: 'Andy',
    isMain: true,
    requiresTrigger: false,
  });
  harness.registerGroup({
    jid: 'sl:main',
    name: 'Slack Main',
    folder: 'slack_main',
    trigger: 'Andy',
    isMain: true,
    requiresTrigger: false,
  });
}

describe('real-world channel and user runtime e2e scenarios', () => {
  it('processes an onboarded Slack group through sqlite, queue, fake agent, and outbound channel', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'slack-runtime-reply' },
    });
    activeHarnesses.push(harness);
    registerMainGroups(harness);

    harness.storeInboundMessage({
      chatJid: 'sl:main',
      sender: 'sl:user:alice',
      senderName: 'Alice',
      content: 'please handle this from Slack',
      threadId: 'sl-thread-1',
    });

    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.channel.outbound.length === 1);

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.fakeAgent.invocations[0]).toEqual(
      expect.objectContaining({
        chatJid: 'sl:main',
        groupFolder: 'slack_main',
        prompt: expect.stringContaining('please handle this from Slack'),
      }),
    );
    expect(harness.channel.outbound[0]).toEqual(
      expect.objectContaining({
        chatJid: 'sl:main',
        text: expect.stringContaining('slack-runtime-reply'),
        options: { threadId: 'sl-thread-1' },
      }),
    );
  });

  it('keeps Telegram and Slack sender allowlists isolated even when sender ids look similar', async () => {
    const harness = await createHermeticRuntimeHarness({
      configureSettings: (settings) => {
        settings.channels.telegram.senderAllowlist.default = {
          allow: ['tg:user:42'],
          mode: 'trigger',
        };
        settings.channels.slack.senderAllowlist.default = {
          allow: ['sl:user:42'],
          mode: 'trigger',
        };
      },
      fakeAgent: { resultText: 'channel-boundary-reply' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:team',
      name: 'Telegram Team',
      folder: 'telegram_team',
      trigger: '@Andy',
      requiresTrigger: true,
    });
    harness.registerGroup({
      jid: 'sl:team',
      name: 'Slack Team',
      folder: 'slack_team',
      trigger: '@Andy',
      requiresTrigger: true,
    });

    harness.storeInboundMessage({
      chatJid: 'sl:team',
      sender: 'tg:user:42',
      content: '@Andy cross-channel spoof should fail',
    });
    await harness.app.processGroupMessages('sl:team');

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'sl:user:42',
      content: '@Andy reverse cross-channel spoof should fail',
    });
    await harness.app.processGroupMessages('tg:team');

    expect(harness.fakeAgent.invocations).toHaveLength(0);

    harness.storeInboundMessage({
      chatJid: 'sl:team',
      sender: 'sl:user:42',
      content: '@Andy valid Slack sender',
    });
    await harness.app.processGroupMessages('sl:team');

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.fakeAgent.invocations[0]?.chatJid).toBe('sl:team');
  });

  it('keeps attachment placeholders and safe workspace paths in runtime prompts', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'attachment-reply' },
    });
    activeHarnesses.push(harness);
    registerMainGroups(harness);

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:file',
      content:
        '[Document: quarterly report.pdf] (/workspace/group/attachments/quarterly_report.pdf)\ncaption: review this file',
    });

    await harness.app.processGroupMessages('tg:main');

    expect(harness.fakeAgent.invocations[0]?.prompt).toContain(
      '/workspace/group/attachments/quarterly_report.pdf',
    );
    expect(harness.fakeAgent.invocations[0]?.prompt).toContain(
      'caption: review this file',
    );
  });

  it('deduplicates burst channel delivery by provider message id', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'deduped-reply' },
    });
    activeHarnesses.push(harness);
    registerMainGroups(harness);

    for (const timestamp of [
      '2026-04-17T10:00:00.001Z',
      '2026-04-17T10:00:00.002Z',
      '2026-04-17T10:00:00.003Z',
    ]) {
      harness.storeInboundMessage({
        id: 'telegram-provider-duplicate-1',
        chatJid: 'tg:main',
        sender: 'tg:user:retry',
        content: 'network replayed this message',
        timestamp,
      });
    }

    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.channel.outbound.length === 1);
    await harness.pollMessagesOnce();

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(
      harness.channel.outbound.filter((msg) =>
        msg.text.includes('deduped-reply'),
      ),
    ).toHaveLength(1);
  });

  it('handles multi-user non-main interleaving without granting command or trigger authority to blocked senders', async () => {
    const harness = await createHermeticRuntimeHarness({
      configureSettings: (settings) => {
        settings.channels.telegram.senderAllowlist.default = {
          allow: ['tg:user:allowed'],
          mode: 'trigger',
        };
      },
      fakeAgent: { resultText: 'allowed-team-reply' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:team',
      name: 'Team',
      folder: 'team',
      trigger: '@Andy',
      requiresTrigger: true,
    });
    harness.db.setSession('team', 'existing-team-session');

    for (const message of [
      {
        sender: 'tg:user:blocked',
        content: '@Andy blocked trigger should not run',
      },
      { sender: 'tg:user:allowed', content: 'allowed but no trigger' },
      { sender: 'tg:user:blocked', content: '/new' },
    ]) {
      harness.storeInboundMessage({
        chatJid: 'tg:team',
        sender: message.sender,
        content: message.content,
      });
      await harness.app.processGroupMessages('tg:team');
    }

    expect(harness.fakeAgent.invocations).toHaveLength(0);
    expect(harness.db.getSession('team')).toBe('existing-team-session');

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'tg:user:allowed',
      content: '@Andy now answer',
    });
    await harness.app.processGroupMessages('tg:team');

    expect(harness.fakeAgent.invocations).toHaveLength(1);
  });

  it('applies sender policy changes from settings.yaml to new inbound turns without restarting', async () => {
    const harness = await createHermeticRuntimeHarness({
      configureSettings: (settings) => {
        settings.channels.telegram.senderAllowlist.default = {
          allow: ['tg:user:old'],
          mode: 'trigger',
        };
      },
      fakeAgent: { resultText: 'dynamic-policy-reply' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:team',
      name: 'Team',
      folder: 'team',
      trigger: '@Andy',
      requiresTrigger: true,
    });

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'tg:user:new',
      content: '@Andy denied before policy change',
    });
    await harness.app.processGroupMessages('tg:team');
    expect(harness.fakeAgent.invocations).toHaveLength(0);

    const runtimeSettings = await import('@core/cli/runtime-settings.js');
    const settings = runtimeSettings.loadRuntimeSettingsFromPath(
      path.join(harness.runtimeHome, 'settings.yaml'),
    );
    settings.channels.telegram.senderAllowlist.default = {
      allow: ['tg:user:new'],
      mode: 'trigger',
    };
    saveRuntimeSettings(harness.runtimeHome, settings);

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'tg:user:new',
      content: '@Andy allowed after policy change',
    });
    await harness.app.processGroupMessages('tg:team');

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.fakeAgent.invocations[0]?.prompt).toContain(
      'allowed after policy change',
    );
  });

  it('does not reuse stale thread context after a newer unthreaded turn', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'thread-context-reply' },
    });
    activeHarnesses.push(harness);
    registerMainGroups(harness);

    harness.storeInboundMessage({
      chatJid: 'sl:main',
      sender: 'sl:user:thread',
      content: 'threaded question',
      threadId: 'thread-a',
    });
    await harness.app.processGroupMessages('sl:main');
    await harness.waitFor(() => harness.channel.outbound.length === 1);

    harness.storeInboundMessage({
      chatJid: 'sl:main',
      sender: 'sl:user:thread',
      content: 'new top-level question',
    });
    await harness.app.processGroupMessages('sl:main');
    await harness.waitFor(() => harness.channel.outbound.length === 2);

    expect(harness.channel.outbound[0]?.options?.threadId).toBe('thread-a');
    expect(harness.channel.outbound[1]?.options?.threadId).toBeUndefined();
  });

  it('keeps same-named Telegram and Slack groups in separate runtime state islands', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'state-island-reply' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:shared',
      name: 'Shared Name',
      folder: 'telegram_shared',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });
    harness.registerGroup({
      jid: 'sl:shared',
      name: 'Shared Name',
      folder: 'slack_shared',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });

    harness.db.setSession('telegram_shared', 'telegram-session');
    harness.db.setSession('slack_shared', 'slack-session');

    harness.storeInboundMessage({
      chatJid: 'tg:shared',
      sender: 'tg:user:1',
      content: 'telegram side',
    });
    harness.storeInboundMessage({
      chatJid: 'sl:shared',
      sender: 'sl:user:1',
      content: 'slack side',
    });

    await harness.app.processGroupMessages('tg:shared');
    await harness.app.processGroupMessages('sl:shared');

    expect(
      harness.fakeAgent.invocations.map((item) => item.groupFolder),
    ).toEqual(['telegram_shared', 'slack_shared']);
    expect(harness.db.getSession('telegram_shared')).toBe('telegram-session');
    expect(harness.db.getSession('slack_shared')).toBe('slack-session');
  });

  it('exercises authorized runtime /stop no-op command path without spawning agents', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainGroups(harness);
    harness.db.setSession('telegram_main', 'session-before-commands');
    const transcriptDir = path.join(harness.runtimeHome, 'agents');
    fs.mkdirSync(transcriptDir, { recursive: true });

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:admin',
      content: '/stop',
      isFromMe: true,
    });
    const processed = await harness.app.processGroupMessages('tg:main');
    expect(processed).toBe(true);

    expect(harness.fakeAgent.invocations).toHaveLength(0);
    expect(
      harness.channel.outbound.some((msg) =>
        msg.text.includes('No active run to stop.'),
      ),
    ).toBe(true);
    expect(harness.db.getSession('telegram_main')).toBe(
      'session-before-commands',
    );
  });
});
