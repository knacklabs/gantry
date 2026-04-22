import { afterEach, describe, expect, it } from 'vitest';

import { getContinuationInputNamespace } from '@core/runtime/continuation-input.js';
import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

describe('runtime continuation and restart e2e flows', () => {
  it('pipes follow-up messages to an active message agent run through IPC input', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'continued-result',
      },
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
      content: 'start long work',
      threadId: 'thread-1',
    });
    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'here is more context',
      threadId: 'thread-1',
    });
    await harness.pollMessagesOnce();

    const threadInput = getContinuationInputNamespace('thread-1');
    await harness.waitFor(
      () => harness.listIpcJson('main', threadInput).length === 1,
    );
    const pipedMessages = harness.listIpcJson<{ type: string; text: string }>(
      'main',
      threadInput,
    );
    expect(pipedMessages[0]?.type).toBe('message');
    expect(pipedMessages[0]?.text).toContain('here is more context');
    expect(harness.channel.progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatJid: 'tg:main',
          text: 'Still working on it, got your follow-up.',
          options: { threadId: 'thread-1' },
        }),
      ]),
    );

    harness.fakeAgent.releaseAll();
    await harness.waitFor(() =>
      harness.channel.outbound.some((msg) =>
        msg.text.includes('continued-result'),
      ),
    );
  });

  it('isolates concurrent continuations for separate threads in the same chat', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'thread-isolated-result',
      },
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
      sender: 'tg:user:a',
      content: 'start thread a',
      threadId: 'thread-a',
    });
    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:b',
      content: 'start thread b',
      threadId: 'thread-b',
    });
    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 2);

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:a',
      content: 'only for thread a',
      threadId: 'thread-a',
    });
    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:b',
      content: 'only for thread b',
      threadId: 'thread-b',
    });
    await harness.pollMessagesOnce();

    const threadAInput = getContinuationInputNamespace('thread-a');
    const threadBInput = getContinuationInputNamespace('thread-b');
    await harness.waitFor(
      () =>
        harness.listIpcJson('main', threadAInput).length === 1 &&
        harness.listIpcJson('main', threadBInput).length === 1,
    );

    const threadAText = harness
      .listIpcJson<{ text: string }>('main', threadAInput)
      .map((item) => item.text)
      .join('\n');
    const threadBText = harness
      .listIpcJson<{ text: string }>('main', threadBInput)
      .map((item) => item.text)
      .join('\n');
    expect(threadAText).toContain('only for thread a');
    expect(threadAText).not.toContain('only for thread b');
    expect(threadBText).toContain('only for thread b');
    expect(threadBText).not.toContain('only for thread a');
    expect(harness.listIpcJson('main', 'input')).toHaveLength(0);

    harness.fakeAgent.releaseAll();
  });

  it('pipes multiple rapid follow-ups as one ordered continuation batch', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'rapid-continuation-result',
      },
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
      content: 'start rapid work',
      timestamp: '2026-04-17T10:00:00.000Z',
    });
    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'first rapid follow-up',
      timestamp: '2026-04-17T10:00:01.000Z',
    });
    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'second rapid follow-up',
      timestamp: '2026-04-17T10:00:02.000Z',
    });

    await harness.pollMessagesOnce();
    await harness.waitFor(
      () => harness.listIpcJson('main', 'input').length === 1,
    );

    const [continuation] = harness.listIpcJson<{ text: string }>(
      'main',
      'input',
    );
    expect(continuation?.text.indexOf('first rapid follow-up')).toBeLessThan(
      continuation?.text.indexOf('second rapid follow-up') ?? -1,
    );

    harness.fakeAgent.releaseAll();
  });

  it('[BUG-TEST-004-HIGH-VOLUME-CONTINUATION] preserves high-volume same-tick follow-ups across continuation batches', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'high-volume-continuation-result',
      },
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
      id: 'high-volume-start-000',
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'start high volume work',
      timestamp: '2026-04-17T10:00:00.000Z',
    });
    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);

    const followUps = Array.from(
      { length: 20 },
      (_, index) => `same-tick follow-up ${String(index + 1).padStart(2, '0')}`,
    );
    for (const [index, content] of followUps.entries()) {
      harness.storeInboundMessage({
        id: `high-volume-follow-up-${String(index + 1).padStart(3, '0')}`,
        chatJid: 'tg:main',
        sender: 'tg:user:1',
        content,
        timestamp: '2026-04-17T10:00:01.000Z',
      });
    }

    await harness.pollMessagesOnce();
    await harness.waitFor(
      () => harness.listIpcJson('main', 'input').length >= 1,
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const continuationText = harness
        .listIpcJson<{ text: string }>('main', 'input')
        .map((item) => item.text)
        .join('\n');
      if (followUps.every((followUp) => continuationText.includes(followUp))) {
        break;
      }
      await harness.pollMessagesOnce();
    }

    const continuationText = harness
      .listIpcJson<{ text: string }>('main', 'input')
      .map((item) => item.text)
      .join('\n');
    let previousIndex = -1;
    for (const followUp of followUps) {
      const currentIndex = continuationText.indexOf(
        followUp,
        previousIndex + 1,
      );
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }

    harness.fakeAgent.releaseAll();
  }, 15_000);

  it('queues follow-ups instead of piping when the active run is idle-waiting', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        blockUntilReleased: true,
        resultText: 'queued-after-idle',
      },
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
      content: 'start then idle',
    });
    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);
    harness.app.queue.notifyIdle('tg:main');

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'do not pipe this while idle',
    });
    await harness.pollMessagesOnce();

    expect(harness.listIpcJson('main', 'input')).toHaveLength(0);

    harness.fakeAgent.releaseAll();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 2);
    harness.fakeAgent.releaseAll();
    await harness.waitFor(() =>
      harness.channel.outbound.some((msg) =>
        msg.text.includes('queued-after-idle'),
      ),
    );
  });

  it('queues user messages while a task container is active for the same group', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'message-after-task' },
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

    let releaseTask!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      harness.app.queue.enqueueTask('tg:main', 'blocking-task', async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseTask = release;
        });
      });
    });
    await taskStarted;

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:user:1',
      content: 'process after task',
    });
    await harness.pollMessagesOnce();
    expect(harness.listIpcJson('main', 'input')).toHaveLength(0);
    expect(harness.fakeAgent.invocations).toHaveLength(0);

    releaseTask();
    await harness.waitFor(() => harness.fakeAgent.invocations.length === 1);
    await harness.waitFor(() =>
      harness.channel.outbound.some((msg) =>
        msg.text.includes('message-after-task'),
      ),
    );
  });

  it('does not duplicate successful replies after cursor state is reloaded', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'single-reply' },
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
      content: 'only answer once',
    });
    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.channel.outbound.length === 1);

    harness.app.loadState();
    await harness.pollMessagesOnce();

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(
      harness.channel.outbound.filter((msg) =>
        msg.text.includes('single-reply'),
      ),
    ).toHaveLength(1);
  });

  it('rolls back the message cursor when an agent fails before user-visible output', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { failWithError: 'boom before output' },
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
      content: 'retry later',
    });

    const processed = await harness.app.processGroupMessages('tg:main');
    expect(processed).toBe(false);
    expect(harness.app.getOrRecoverCursor('tg:main')).toBe('');
  });

  it('keeps the advanced cursor when an agent fails after visible output', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: {
        failWithError: 'boom after output',
        outputBeforeFailureText: 'partial visible answer',
      },
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
      content: 'do not duplicate this',
    });

    const processed = await harness.app.processGroupMessages('tg:main');
    expect(processed).toBe(true);
    expect(harness.channel.outbound[0]?.text).toContain(
      'partial visible answer',
    );
    expect(harness.app.getOrRecoverCursor('tg:main')).not.toBe('');
  });
});
