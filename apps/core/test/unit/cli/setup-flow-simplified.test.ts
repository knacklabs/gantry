import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('simplified setup sequence', () => {
  it('is the minimum runnable path with no post-ready optional steps', async () => {
    const { FULL_SEQUENCE } = await import('@core/cli/setup-flow-state.js');

    expect(FULL_SEQUENCE).toEqual([
      'welcome',
      'runtime_home',
      'storage',
      'credentials',
      'channel',
      'model',
      'telegram',
      'slack',
      'config',
      'group',
      'verify',
      'ready',
    ]);

    for (const removed of [
      'prerequisites',
      'memory',
      'embeddings',
      'dreaming',
      'service',
    ]) {
      expect(FULL_SEQUENCE).not.toContain(removed);
    }
  });

  it('keeps ready-screen labels when setup resumes after binding', async () => {
    const { createInitialState } =
      await import('@core/cli/onboarding-state.js');
    const { updateDraftFromState, updateStateData } =
      await import('@core/cli/setup-flow-state.js');
    const state = createInitialState('/tmp/gantry-ready-labels');
    const draft = {
      runtimeHome: '/tmp/gantry-ready-labels',
      postgresSetupKind: 'local',
      postgresDatabaseUrl: 'postgres://localhost/gantry',
      postgresSchema: 'gantry',
      primaryProvider: 'telegram',
      credentialMode: 'gantry',
      agentName: 'Gantry',
      modelPreset: 'anthropic',
      selectedModel: 'sonnet',
      telegramBotToken: '',
      telegramChatJid: 'tg:-100123',
      telegramDisplayName: 'main team chat',
      telegramAdminSenderId: '',
      telegramAdminSenderName: '',
      telegramPermissionApproverIds: '123',
      telegramBotUsername: 'gantry_bot',
      slackBotToken: '',
      slackAppToken: '',
      slackChatJid: '',
      slackDisplayName: 'ops-room',
      slackPermissionApproverIds: '',
      memoryEnabled: true,
      embeddingsEnabled: true,
      dreamingEnabled: true,
      workspaceKey: 'gantry-main',
      conversationLabel: 'main team chat',
      startAfterSetup: false,
    };

    updateStateData(state, draft as never);
    expect(state.data.workspaceKey).toBe('gantry-main');
    expect(state.data.conversationLabel).toBe('main team chat');
    expect(state.data.telegramDisplayName).toBe('main team chat');
    expect(state.data.slackDisplayName).toBe('ops-room');

    const resumed = {
      ...draft,
      telegramDisplayName: '',
      slackDisplayName: '',
      workspaceKey: '',
      conversationLabel: '',
    };
    updateDraftFromState(resumed as never, state);
    expect(resumed.workspaceKey).toBe('gantry-main');
    expect(resumed.conversationLabel).toBe('main team chat');
    expect(resumed.telegramDisplayName).toBe('main team chat');
    expect(resumed.slackDisplayName).toBe('ops-room');
  });
});

async function loadReadyStep(selectValue: string) {
  const note = vi.fn();
  const select = vi.fn(async () => selectValue);
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note,
    select,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  }));
  const { runReadyStep } = await import('@core/cli/setup-ready.js');
  return { runReadyStep, note, select };
}

describe('ready screen copy', () => {
  const draft = {
    workspaceKey: 'gantry-main',
    agentName: 'Gantry',
    conversationLabel: 'main team chat',
    selectedModel: 'sonnet',
  };

  it('renders the ready contract block', async () => {
    const { runReadyStep, note } = await loadReadyStep('next');

    await runReadyStep(draft);

    const rendered = note.mock.calls[0][0] as string;
    expect(rendered).toBe(
      [
        'Gantry is ready.',
        '',
        'Workspace: gantry-main',
        'Agent: Gantry',
        'Conversation: main team chat',
        'Model: sonnet',
        '',
        'Next: Start chatting or run gantry status.',
        'Optional setup: memory, background service, extra providers.',
      ].join('\n'),
    );
    expect(note.mock.calls[0][1]).toBe('Ready');
  });

  it('returns start_now when the user chooses to start immediately', async () => {
    const { runReadyStep } = await loadReadyStep('start_now');
    await expect(runReadyStep(draft)).resolves.toEqual({ type: 'start_now' });
  });

  it('returns next when the user finishes setup', async () => {
    const { runReadyStep } = await loadReadyStep('next');
    await expect(runReadyStep(draft)).resolves.toEqual({ type: 'next' });
  });
});

async function loadVerifyStep(input: {
  runtimeConfigured: boolean;
  hasProcessableGroup?: boolean;
  report?: unknown;
  modelAccess?: unknown;
}) {
  const warn = vi.fn();
  const note = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note,
    log: { error: vi.fn(), info: vi.fn(), warn, success: vi.fn() },
  }));
  const report = input.report ?? { ok: true, sections: [], checks: [] };
  vi.doMock('@core/cli/doctor.js', () => ({
    runDoctorWithNetwork: vi.fn(async () => report),
    formatDoctorReport: vi.fn(() => 'doctor'),
    hasRuntimeConfig: vi.fn(() => input.runtimeConfigured),
    hasProcessableGroupForConfiguredChannel: vi.fn(
      async () => input.hasProcessableGroup ?? true,
    ),
  }));
  vi.doMock('@core/channels/provider-registry.js', async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@core/channels/provider-registry.js')
    >()),
    listConnectableChannelProviders: vi.fn(() => [{ id: 'telegram' }]),
  }));
  vi.doMock('@core/cli/setup-credentials.js', () => ({
    verifyModelAccess: vi.fn(
      async () => input.modelAccess ?? { ok: true, message: 'ok' },
    ),
  }));
  const { runVerifyStep } = await import('@core/cli/setup-flow-final-steps.js');
  return { runVerifyStep, warn };
}

describe('blocked copy', () => {
  it('uses the "Setup blocked:" + "Next action:" contract', async () => {
    const { runVerifyStep, warn } = await loadVerifyStep({
      runtimeConfigured: false,
    });

    const action = await runVerifyStep('file:///x', {
      runtimeHome: '/tmp/x',
      primaryProvider: 'telegram',
    } as never);

    expect(action).toEqual({ type: 'goto', step: 'telegram' });
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('Setup blocked: no channel connected');
    expect(message).toContain(
      'Next action: connect a channel with `gantry provider connect telegram`.',
    );
  });

  it('reports one provider command when the conversation binding is invalid', async () => {
    const { runVerifyStep, warn } = await loadVerifyStep({
      runtimeConfigured: true,
      hasProcessableGroup: false,
    });

    const action = await runVerifyStep('file:///x', {
      runtimeHome: '/tmp/x',
      primaryProvider: 'telegram',
    } as never);

    expect(action).toEqual({ type: 'goto', step: 'telegram' });
    const message = warn.mock.calls[0][0] as string;
    expect(message).toBe(
      [
        'Setup blocked: no processable conversation for the configured channel',
        'Next action: run `gantry provider connect telegram`.',
      ].join('\n'),
    );
    expect(message).not.toContain(' or ');
  });

  it('uses the first verification failure as the blocker reason', async () => {
    const { runVerifyStep, warn } = await loadVerifyStep({
      runtimeConfigured: true,
      report: {
        ok: false,
        blockingFailures: 1,
        warnings: 0,
        checks: [
          {
            id: 'model-access-credentials',
            title: 'Model Access Credentials',
            status: 'fail',
            message:
              'Missing active model credentials for selected defaults: anthropic.',
            nextAction: 'Run `gantry credentials model set anthropic`.',
          },
        ],
      },
    });

    const action = await runVerifyStep('file:///x', {
      runtimeHome: '/tmp/x',
      primaryProvider: 'telegram',
    } as never);

    expect(action).toEqual({ type: 'resume' });
    expect(warn.mock.calls[0][0]).toBe(
      [
        'Setup blocked: Missing active model credentials for selected defaults: anthropic.',
        'Next action: Run `gantry credentials model set anthropic`.',
      ].join('\n'),
    );
  });
});

async function loadGroupStep() {
  const settings = {};
  const spinner = { start: vi.fn(), stop: vi.fn() };
  const ensureConfiguredConversationBinding = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: vi.fn(),
    spinner: vi.fn(() => spinner),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  }));
  vi.doMock('@core/channels/provider-registry.js', () => ({
    listConnectableChannelProviders: vi.fn(() => []),
  }));
  vi.doMock('@core/cli/doctor.js', () => ({
    runDoctorWithNetwork: vi.fn(),
    formatDoctorReport: vi.fn(),
    hasRuntimeConfig: vi.fn(),
    hasProcessableGroupForConfiguredChannel: vi.fn(),
  }));
  vi.doMock('@core/cli/onboarding-config.js', () => ({
    persistOnboardingConfig: vi.fn(),
  }));
  vi.doMock('@core/cli/slack.js', () => ({
    registerSlackMainGroup: vi.fn(async () => ({
      folder: 'main_agent',
      groupName: 'Gantry',
    })),
  }));
  vi.doMock('@core/cli/telegram.js', () => ({
    registerTelegramMainGroup: vi.fn(async () => ({
      folder: 'main_agent',
      groupName: 'Gantry',
    })),
  }));
  vi.doMock('@core/config/settings/runtime-settings.js', () => ({
    loadRuntimeSettings: vi.fn(() => settings),
    saveRuntimeSettings: vi.fn(),
    ensureConfiguredConversationBinding,
  }));
  const { runGroupStep } = await import('@core/cli/setup-flow-final-steps.js');
  return { runGroupStep, ensureConfiguredConversationBinding };
}

describe('conversation binding labels', () => {
  it('uses the selected Slack conversation label in the ready draft', async () => {
    const { runGroupStep, ensureConfiguredConversationBinding } =
      await loadGroupStep();
    const draft = {
      primaryProvider: 'slack',
      runtimeHome: '/tmp/gantry-group-labels',
      slackChatJid: 'sl:C0123456789',
      slackDisplayName: 'ops-room',
      slackPermissionApproverIds: 'U123',
      agentName: 'Gantry',
    };

    await expect(runGroupStep(draft as never)).resolves.toEqual({
      type: 'next',
    });

    expect(ensureConfiguredConversationBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: 'Gantry',
        jid: 'sl:C0123456789',
        displayName: 'ops-room',
      }),
    );
    expect(draft).toEqual(
      expect.objectContaining({
        workspaceKey: 'main_agent',
        conversationLabel: 'ops-room',
      }),
    );
  });

  it('uses the selected Telegram conversation label in the ready draft', async () => {
    const { runGroupStep, ensureConfiguredConversationBinding } =
      await loadGroupStep();
    const draft = {
      primaryProvider: 'telegram',
      runtimeHome: '/tmp/gantry-group-labels',
      telegramChatJid: 'tg:-100123',
      telegramDisplayName: 'Ops Room',
      telegramPermissionApproverIds: '5759865942',
      telegramAdminSenderId: '',
      agentName: 'Gantry',
    };

    await expect(runGroupStep(draft as never)).resolves.toEqual({
      type: 'next',
    });

    expect(ensureConfiguredConversationBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: 'Gantry',
        jid: 'tg:-100123',
        displayName: 'Ops Room',
      }),
    );
    expect(draft).toEqual(
      expect.objectContaining({
        workspaceKey: 'main_agent',
        conversationLabel: 'Ops Room',
      }),
    );
  });
});
