import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

describe('runtime integration', () => {
  it('runs message polling + queue + fake agent end-to-end on hermetic runtime home', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'integration reply' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:main',
      name: 'Main',
      folder: 'main',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'hello integration',
    });

    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.channel.outbound.length > 0);

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.channel.outbound[0]?.chatJid).toBe('tg:main');
    expect(harness.channel.outbound[0]?.text).toContain('integration reply');

    const dbPath = path.join(harness.runtimeHome, 'store', 'messages.db');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('does not spawn an agent when no channel owns the registered JID', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:orphaned',
      name: 'Orphaned',
      folder: 'orphaned',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });
    harness.app.setChannelRuntime({
      hasChannel: () => false,
      supportsStreaming: () => false,
      supportsProgress: () => false,
      sendMessage: async () => {},
      sendStreamingChunk: async () => {},
      resetStreaming: () => {},
      setTyping: async () => {},
      sendProgressUpdate: async () => {},
    });

    harness.storeInboundMessage({
      chatJid: 'tg:orphaned',
      sender: 'tg:user:1',
      content: 'nobody can receive this',
    });

    const processed = await harness.app.processGroupMessages('tg:orphaned');

    expect(processed).toBe(true);
    expect(harness.fakeAgent.invocations).toHaveLength(0);
  });

  it('deduplicates repeated provider message ids before agent processing', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'dedupe-reply' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:main',
      name: 'Main',
      folder: 'main',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });

    harness.storeInboundMessage({
      id: 'provider-duplicate-id',
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'old duplicate content',
      timestamp: new Date(Date.now() - 1_000).toISOString(),
    });
    harness.storeInboundMessage({
      id: 'provider-duplicate-id',
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'new duplicate content',
      timestamp: new Date().toISOString(),
    });

    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.channel.outbound.length > 0);

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.fakeAgent.invocations[0]?.prompt).toContain(
      'new duplicate content',
    );
    expect(harness.fakeAgent.invocations[0]?.prompt).not.toContain(
      'old duplicate content',
    );
  });

  it('enforces IPC main-vs-non-main authorization for message/task requests', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:main',
      name: 'Main',
      folder: 'main',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });
    harness.registerGroup({
      jid: 'tg:child',
      name: 'Child',
      folder: 'child',
      trigger: 'Bot',
      requiresTrigger: true,
    });

    harness.startIpcWatcher();

    harness.writeIpcMessageRequest('child', {
      chatJid: 'tg:main',
      text: 'should be blocked',
    });
    harness.writeIpcMessageRequest('main', {
      chatJid: 'tg:child',
      text: 'allowed from main',
    });

    await harness.waitFor(() =>
      harness.channel.outbound.some((msg) => msg.text === 'allowed from main'),
    );
    expect(
      harness.channel.outbound.some((msg) => msg.text === 'should be blocked'),
    ).toBe(false);

    harness.writeIpcTaskRequest('child', {
      type: 'register_agent',
      taskId: 'child-register',
      jid: 'tg:blocked',
      name: 'Blocked Agent',
      folder: 'blocked_agent',
      trigger: 'Blocked',
    });
    harness.writeIpcTaskRequest('main', {
      type: 'register_agent',
      taskId: 'main-register',
      jid: 'tg:new-agent',
      name: 'New Agent',
      folder: 'new_agent',
      trigger: 'New',
    });

    await harness.waitFor(
      () => Boolean(harness.app.getRegisteredGroups()['tg:new-agent']),
      4_000,
    );
    expect(harness.app.getRegisteredGroups()['tg:blocked']).toBeUndefined();
  });
});
