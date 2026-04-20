import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

describe('runtime hermetic e2e flows', () => {
  it('processes inbound channel message from sqlite polling through fake agent and outbound reply', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'e2e-reply' },
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
      sender: 'tg:user:inbound',
      content: 'please respond',
    });

    await harness.pollMessagesOnce();
    await harness.waitFor(() => harness.channel.outbound.length > 0);

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.channel.outbound[0]?.text).toContain('e2e-reply');
  });

  it('enforces non-main trigger gating and sender allowlist behavior', async () => {
    const harness = await createHermeticRuntimeHarness({
      configureSettings: (settings) => {
        settings.channels.telegram.senderAllowlist.default = {
          allow: ['tg:user:allowed'],
          mode: 'trigger',
        };
      },
      fakeAgent: { resultText: 'trigger-accepted' },
    });
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:team',
      name: 'Team',
      folder: 'team',
      trigger: '@Bot',
      requiresTrigger: true,
    });

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'tg:user:blocked',
      content: '@Bot should be denied',
    });
    await harness.app.processGroupMessages('tg:team');
    expect(harness.fakeAgent.invocations).toHaveLength(0);

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'tg:user:allowed',
      content: 'no trigger yet',
    });
    await harness.app.processGroupMessages('tg:team');
    expect(harness.fakeAgent.invocations).toHaveLength(0);

    harness.storeInboundMessage({
      chatJid: 'tg:team',
      sender: 'tg:user:allowed',
      content: '@Bot now run',
    });
    await harness.app.processGroupMessages('tg:team');
    await harness.waitFor(() => harness.channel.outbound.length > 0);

    expect(harness.fakeAgent.invocations).toHaveLength(1);
    expect(harness.channel.outbound[0]?.chatJid).toBe('tg:team');
  });

  it('handles /new by clearing session state and preserving model override', async () => {
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

    harness.db.setSession('main', 'sess-before-new');
    harness.app.setGroupModelOverride('tg:main', 'claude-opus-4-1-20250805');

    harness.storeInboundMessage({
      chatJid: 'tg:main',
      sender: 'tg:admin',
      content: '/new',
      isFromMe: true,
    });

    const processed = await harness.app.processGroupMessages('tg:main');
    expect(processed).toBe(true);

    expect(harness.db.getSession('main')).toBeUndefined();
    const persisted = harness.db.getAllRegisteredGroups()['tg:main'];
    expect(persisted?.agentConfig?.model).toBe('claude-opus-4-1-20250805');
  });

  it('runs a manual scheduler job with persisted runs/events and linked-session notification', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'scheduled-result' },
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

    harness.db.upsertJob({
      id: 'manual-job-1',
      name: 'Manual Job',
      prompt: 'Run manual task',
      schedule_type: 'manual',
      schedule_value: 'manual',
      linked_sessions: ['tg:main'],
      group_scope: 'main',
      created_by: 'human',
      status: 'active',
      next_run: new Date(Date.now() - 1000).toISOString(),
    });

    await harness.runSchedulerOnce();
    await harness.waitFor(
      () =>
        harness.db
          .getRecentJobRuns(20)
          .some(
            (run) =>
              run.job_id === 'manual-job-1' && run.status === 'completed',
          ),
      4_000,
    );

    const events = harness.db.listRecentJobEvents(200);
    expect(
      events.some(
        (event) =>
          event.job_id === 'manual-job-1' && event.event_type === 'job.started',
      ),
    ).toBe(true);
    expect(
      harness.channel.outbound.some((msg) =>
        msg.text.includes('Scheduled task: Manual Job'),
      ),
    ).toBe(true);
  });

  it('enforces IPC authorization for main versus non-main task/message requests', async () => {
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
      jid: 'tg:team',
      name: 'Team',
      folder: 'team',
      trigger: 'Bot',
      requiresTrigger: true,
    });

    harness.startIpcWatcher();

    harness.writeIpcMessageRequest('team', {
      chatJid: 'tg:main',
      text: 'blocked-team-to-main',
    });
    harness.writeIpcMessageRequest('main', {
      chatJid: 'tg:team',
      text: 'allowed-main-to-team',
    });

    await harness.waitFor(() =>
      harness.channel.outbound.some(
        (msg) => msg.text === 'allowed-main-to-team',
      ),
    );
    expect(
      harness.channel.outbound.some(
        (msg) => msg.text === 'blocked-team-to-main',
      ),
    ).toBe(false);

    harness.writeIpcTaskRequest('team', {
      type: 'register_agent',
      taskId: 'team-register-agent',
      jid: 'tg:should-not-register',
      name: 'Denied',
      folder: 'denied_agent',
      trigger: 'Denied',
    });
    harness.writeIpcTaskRequest('main', {
      type: 'register_agent',
      taskId: 'main-register-agent',
      jid: 'tg:registered-by-main',
      name: 'Allowed',
      folder: 'allowed_agent',
      trigger: 'Allowed',
    });

    await harness.waitFor(
      () => Boolean(harness.app.getRegisteredGroups()['tg:registered-by-main']),
      4_000,
    );
    expect(
      harness.app.getRegisteredGroups()['tg:should-not-register'],
    ).toBeUndefined();
  });

  it('[BUG-TEST-002-MEMORY-CONTEXT] does not pass per-turn memory context files through normal agent input', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeAgent: { resultText: 'memory-context-reply' },
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
      sender: 'tg:user:memory',
      content: 'please use memory context',
    });

    await harness.app.processGroupMessages('tg:main');

    expect(harness.fakeAgent.invocations[0]?.memoryContextFile).toBeUndefined();
  });

  it('denies unauthorized management commands through the runtime without mutating state', async () => {
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
    harness.db.setSession('main', 'session-before-denied-command');
    harness.app.setGroupModelOverride('tg:main', 'claude-opus-4-1-20250805');

    for (const command of [
      '/new',
      '/model claude-sonnet-4-5',
      '/thinking off',
    ]) {
      harness.storeInboundMessage({
        chatJid: 'tg:main',
        sender: 'tg:user:not-admin',
        content: command,
      });
      const processed = await harness.app.processGroupMessages('tg:main');
      expect(processed).toBe(true);
    }

    expect(harness.db.getSession('main')).toBe('session-before-denied-command');
    const group = harness.db.getAllRegisteredGroups()['tg:main'];
    expect(group?.agentConfig?.model).toBe('claude-opus-4-1-20250805');
    expect(group?.agentConfig?.thinking).toBeUndefined();
    expect(harness.fakeAgent.invocations).toHaveLength(0);
    expect(
      harness.channel.outbound.filter((msg) =>
        msg.text.includes('Session commands require admin access.'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('persists and clears model and thinking overrides through runtime commands', async () => {
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

    for (const command of [
      '/model claude-opus-4-1-20250805',
      '/thinking off',
      '/model default',
      '/thinking default',
    ]) {
      harness.storeInboundMessage({
        chatJid: 'tg:main',
        sender: 'tg:admin',
        content: command,
        isFromMe: true,
      });
      const processed = await harness.app.processGroupMessages('tg:main');
      expect(processed).toBe(true);
    }

    const group = harness.db.getAllRegisteredGroups()['tg:main'];
    expect(group?.agentConfig?.model).toBeUndefined();
    expect(group?.agentConfig?.thinking).toBeUndefined();
  });
});
