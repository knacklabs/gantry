import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

function registerMain(
  harness: Awaited<ReturnType<typeof createHermeticRuntimeHarness>>,
) {
  harness.registerGroup({
    jid: 'tg:main',
    name: 'Main',
    folder: 'main',
    trigger: 'Andy',
    isMain: true,
    requiresTrigger: false,
  });
}

describe('deterministic runtime soak and stress integration scenarios', () => {
  it('processes repeated message-loop turns without duplicate agent runs or replies', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'soak-message-result' },
    });
    activeHarnesses.push(harness);
    registerMain(harness);

    for (let i = 0; i < 30; i += 1) {
      harness.storeInboundMessage({
        chatJid: 'tg:main',
        sender: 'tg:user:soak',
        content: `message-loop soak turn ${i}`,
        timestamp: new Date(Date.UTC(2026, 3, 17, 10, 0, i)).toISOString(),
      });
      await harness.pollMessagesOnce();
      await harness.waitFor(() => harness.channel.outbound.length === i + 1);
    }

    expect(harness.fakeAgent.invocations).toHaveLength(30);
    expect(
      harness.channel.outbound.filter((msg) =>
        msg.text.includes('soak-message-result'),
      ),
    ).toHaveLength(30);

    await harness.pollMessagesOnce();
    expect(harness.fakeAgent.invocations).toHaveLength(30);
    expect(harness.channel.outbound).toHaveLength(30);
  });

  it('runs repeated one-time scheduler cycles once each without duplicate work', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'soak-scheduler-result' },
    });
    activeHarnesses.push(harness);
    registerMain(harness);

    const jobCount = 12;
    for (let i = 0; i < jobCount; i += 1) {
      const jobId = `soak-once-job-${i}`;
      harness.db.upsertJob({
        id: jobId,
        name: `Soak Once Job ${i}`,
        prompt: `scheduler soak prompt ${i}`,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() - 5_000 - i).toISOString(),
        linked_sessions: ['tg:main'],
        group_scope: 'main',
        created_by: 'agent',
        status: 'active',
        next_run: new Date(Date.now() - 5_000 - i).toISOString(),
      });

      await harness.runSchedulerOnce();
      await harness.waitFor(
        () =>
          harness.fakeAgent.invocations.length === i + 1 &&
          harness.db.getJobById(jobId)?.status === 'completed',
        4_000,
      );
    }

    for (let i = 0; i < 3; i += 1) {
      await harness.runSchedulerOnce();
    }

    const soakRuns = harness.db
      .getRecentJobRuns(100)
      .filter((run) => run.job_id.startsWith('soak-once-job-'));
    expect(harness.fakeAgent.invocations).toHaveLength(jobCount);
    expect(soakRuns).toHaveLength(jobCount);
    expect(soakRuns.every((run) => run.status === 'completed')).toBe(true);
    expect(
      Array.from(new Set(soakRuns.map((run) => run.job_id))).sort(),
    ).toHaveLength(jobCount);
  }, 10_000);

  it('drains a burst of IPC messages while archiving malformed neighbors', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMain(harness);
    harness.startIpcWatcher();

    for (let i = 0; i < 30; i += 1) {
      harness.writeRawFile(
        'main',
        'messages',
        `bad-neighbor-${i}.json`,
        '{"type":',
      );
      harness.writeIpcMessageRequest('main', {
        chatJid: 'tg:main',
        text: `ipc soak message ${i}`,
      });
    }

    await harness.waitFor(
      () =>
        harness.channel.outbound.filter((msg) =>
          msg.text.startsWith('ipc soak message '),
        ).length === 30,
      8_000,
    );

    expect(harness.listIpcFiles('main', 'messages')).toHaveLength(0);
    expect(
      harness
        .listIpcErrorFiles()
        .filter((file) => file.includes('bad-neighbor-')),
    ).toHaveLength(30);
    expect(new Set(harness.channel.outbound.map((msg) => msg.text)).size).toBe(
      30,
    );
  });
});
