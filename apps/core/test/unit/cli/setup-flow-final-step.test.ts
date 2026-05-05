import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-config-step-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

function makeDraft(runtimeHome: string): any {
  return {
    runtimeHome,
    postgresSetupKind: 'local',
    postgresDatabaseUrl: '',
    onecliPostgresDatabaseUrl: '',
    postgresSchema: 'myclaw',
    onecliPostgresSchema: 'onecli',
    primaryProvider: 'telegram',
    credentialMode: 'onecli',
    onecliUrl: 'http://localhost:10254',
    selectedModel: 'sonnet',
    telegramBotToken: 'telegram-token',
    telegramChatJid: 'tg:-100123',
    telegramDisplayName: 'Main Agent',
    telegramAdminSenderId: '123',
    telegramAdminSenderName: 'Admin',
    telegramPermissionApproverIds: '123',
    telegramBotUsername: 'mybot',
    slackBotToken: '',
    slackAppToken: '',
    slackChatJid: '',
    slackDisplayName: 'Main Agent',
    slackPermissionApproverIds: '',
    memoryEnabled: true,
    embeddingsEnabled: false,
    dreamingEnabled: true,
    serviceChoice: 'skip',
    serviceStartedAfterSetup: false,
    startAfterSetup: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@core/channels/provider-registry.js');
  vi.doUnmock('@core/cli/doctor.js');
  vi.doUnmock('@core/cli/setup-credentials.js');
  vi.doUnmock('@core/cli/setup-flow-prompts.js');
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

async function loadConfigStep() {
  const logError = vi.fn();
  const note = vi.fn();
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  };
  const persistOnboardingConfig = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    note,
    isCancel: () => false,
    spinner: vi.fn(() => spinner),
    log: { error: logError, info: vi.fn(), warn: vi.fn() },
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
  }));
  vi.doMock('@core/cli/setup-flow-prompts.js', () => ({
    chooseProgressAction: vi.fn(async () => ({ type: 'next' })),
  }));
  vi.doMock('@core/cli/onboarding-config.js', () => ({
    persistOnboardingConfig,
  }));
  const { runConfigStep } = await import('@core/cli/setup-flow-final-steps.js');
  return {
    runConfigStep,
    persistOnboardingConfig,
    logError,
    note,
    spinner,
  };
}

async function loadEmbeddingsStep(selection: string) {
  const note = vi.fn();
  vi.doMock('@clack/prompts', () => ({
    note,
    isCancel: () => false,
    spinner: vi.fn(),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    select: vi.fn(async () => selection),
    text: vi.fn(),
    password: vi.fn(),
  }));
  vi.doMock('@core/cli/setup-flow-prompts.js', () => ({
    chooseProgressAction: vi.fn(async () => ({ type: 'next' })),
  }));
  const { runEmbeddingsStep } =
    await import('@core/cli/setup-flow-final-steps.js');
  return { runEmbeddingsStep, note };
}

async function loadVerifyStep(modelAccessResult: {
  ok: boolean;
  message: string;
  nextAction?: string;
}) {
  const warn = vi.fn();
  const success = vi.fn();
  const note = vi.fn();
  const verifyFirstAgentModelAccess = vi.fn(async () => modelAccessResult);
  vi.doMock('@clack/prompts', () => ({
    note,
    isCancel: () => false,
    spinner: vi.fn(),
    log: { error: vi.fn(), info: vi.fn(), warn, success },
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
  }));
  vi.doMock('@core/cli/doctor.js', () => ({
    runDoctorWithNetwork: vi.fn(async () => ({
      ok: true,
      blockingFailures: 0,
      warnings: 0,
      checks: [],
    })),
    formatDoctorReport: vi.fn(() => 'doctor ok'),
    hasRuntimeConfig: vi.fn(() => true),
    hasProcessableGroupForConfiguredChannel: vi.fn(async () => true),
  }));
  vi.doMock('@core/channels/provider-registry.js', () => ({
    registerProvider: vi.fn(),
    listConnectableChannelProviders: vi.fn(() => [
      { id: 'telegram' },
      { id: 'slack' },
    ]),
  }));
  vi.doMock('@core/cli/setup-credentials.js', () => ({
    verifyFirstAgentModelAccess,
  }));
  const { runVerifyStep } = await import('@core/cli/setup-flow-final-steps.js');
  return { runVerifyStep, verifyFirstAgentModelAccess, warn, success, note };
}

async function loadGroupStep() {
  const spinner = {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  };
  const registerTelegramMainGroup = vi.fn(async () => ({
    folder: 'main_agent',
    groupName: 'Main Agent',
  }));
  vi.doMock('@clack/prompts', () => ({
    note: vi.fn(),
    isCancel: () => false,
    spinner: vi.fn(() => spinner),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
  }));
  vi.doMock('@core/cli/telegram.js', () => ({
    registerTelegramMainGroup,
  }));
  vi.doMock('@core/cli/slack.js', () => ({
    registerSlackMainGroup: vi.fn(),
  }));
  const { runGroupStep } = await import('@core/cli/setup-flow-final-steps.js');
  return { runGroupStep, registerTelegramMainGroup, spinner };
}

describe('setup config step', () => {
  it('persists provided MyClaw and OneCLI database URLs without provisioning Docker', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runConfigStep, persistOnboardingConfig } = await loadConfigStep();
    const draft = makeDraft(runtimeHome);
    draft.postgresDatabaseUrl =
      'postgres://myclaw_app:pass@localhost:15432/myclaw';
    draft.onecliPostgresDatabaseUrl =
      'postgres://onecli_app:pass@localhost:15432/myclaw?schema=onecli';

    const action = await runConfigStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.postgresDatabaseUrl).toContain('myclaw_app');
    expect(draft.onecliPostgresDatabaseUrl).toContain('onecli_app');
    expect(persistOnboardingConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHome,
        anthropicModel: 'sonnet',
        postgresDatabaseUrl: draft.postgresDatabaseUrl,
        onecliPostgresDatabaseUrl: draft.onecliPostgresDatabaseUrl,
      }),
    );
  }, 10_000);

  it('returns to storage without writing config when database URLs are missing', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runConfigStep, persistOnboardingConfig, logError } =
      await loadConfigStep();

    const action = await runConfigStep(makeDraft(runtimeHome));

    expect(action).toEqual({ type: 'goto', step: 'storage' });
    expect(persistOnboardingConfig).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('MYCLAW_DATABASE_URL'),
    );
  }, 10_000);
});

describe('setup group step', () => {
  it('writes Telegram permission approvers to settings control allowlist on first setup', async () => {
    const runtimeHome = makeRuntimeHome();
    const draft = makeDraft(runtimeHome);
    draft.telegramPermissionApproverIds = '123,456';
    const { runGroupStep } = await loadGroupStep();

    const action = await runGroupStep(draft);

    expect(action).toEqual({ type: 'next' });
    const { loadRuntimeSettings } =
      await import('@core/config/settings/runtime-settings.js');
    const settings = loadRuntimeSettings(runtimeHome);
    const conversation = Object.values(settings.conversations).find(
      (entry) => entry.providerConnection === 'telegram_default',
    );
    expect(Object.keys(settings.agents)).toEqual(['main_agent']);
    expect(Object.values(settings.bindings)).toHaveLength(1);
    expect(settings.agents.main_agent?.dmAccess).toEqual([
      {
        provider: 'telegram',
        userIds: ['123', '456'],
        adminUserId: '123',
      },
    ]);
    expect(conversation?.controlApprovers).toEqual(['123', '456']);
    expect(conversation?.senderPolicy).toEqual({ allow: '*', mode: 'trigger' });
  });
});

describe('setup embeddings step', () => {
  it('keeps external embeddings off during first-run setup', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runEmbeddingsStep, note } = await loadEmbeddingsStep('on');
    const draft = makeDraft(runtimeHome);
    draft.memoryEnabled = true;
    draft.embeddingsEnabled = false;

    const action = await runEmbeddingsStep(draft);

    expect(action).toEqual({ type: 'next' });
    expect(draft.embeddingsEnabled).toBe(false);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('brokered embedding provider access'),
      'Embeddings',
    );
  });
});

describe('setup verification step', () => {
  it('returns to Model Access when the first-agent check fails', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runVerifyStep, verifyFirstAgentModelAccess, warn } =
      await loadVerifyStep({
        ok: false,
        message: 'OneCLI check failed',
        nextAction: 'Open Model Access.',
      });
    const draft = makeDraft(runtimeHome);

    const action = await runVerifyStep(import.meta.url, draft);

    expect(action).toEqual({ type: 'goto', step: 'credentials' });
    expect(verifyFirstAgentModelAccess).toHaveBeenCalledWith(
      'http://localhost:10254',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OneCLI check'));
  });

  it('continues when the first-agent Model Access check succeeds', async () => {
    const runtimeHome = makeRuntimeHome();
    const { runVerifyStep, verifyFirstAgentModelAccess, success } =
      await loadVerifyStep({
        ok: true,
        message: 'First-agent Model Access check passed.',
      });
    const draft = makeDraft(runtimeHome);

    const action = await runVerifyStep(import.meta.url, draft);

    expect(action).toEqual({ type: 'next' });
    expect(verifyFirstAgentModelAccess).toHaveBeenCalledWith(
      'http://localhost:10254',
    );
    expect(success).toHaveBeenCalledWith(
      expect.stringContaining('Verification passed'),
    );
  });
});
