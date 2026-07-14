import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRunDoctorWithNetwork = vi.hoisted(() => vi.fn());

vi.mock('@core/cli/doctor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/cli/doctor.js')>()),
  runDoctorWithNetwork: mockRunDoctorWithNetwork,
}));

vi.mock('@core/infrastructure/service/manager.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@core/infrastructure/service/manager.js')
  >()),
  getServiceStatus: vi.fn(() => ({ kind: 'mock', status: 'stopped' })),
}));

vi.mock(
  '@core/adapters/storage/postgres/storage-readiness.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@core/adapters/storage/postgres/storage-readiness.js')
    >()),
    inspectRuntimeSecretReadiness: vi.fn(async () => ({
      status: 'pass',
      message: 'Runtime secret refs are ready.',
    })),
  }),
);

import { collectRuntimeStatus, formatRuntimeStatus } from '@core/cli/status.js';
import { unresolvedProviderIdsFromRuntimeSecretDetails } from '@core/cli/runtime-secret-status.js';
import type { RuntimeStatusSummary } from '@core/cli/status.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-status-'));
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

afterEach(() => {
  mockRunDoctorWithNetwork.mockReset();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('status command formatting', () => {
  it('collects runtime status without channel live token probes', async () => {
    mockRunDoctorWithNetwork.mockResolvedValue({
      ok: false,
      warnings: 0,
      blockingFailures: 1,
      checks: [
        {
          id: 'storage-capabilities',
          title: 'Storage Capabilities',
          status: 'fail',
          message: 'Postgres unavailable.',
        },
      ],
    });
    const runtimeHome = makeRuntimeHome();
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: {
        bot_token: 'env:SLACK_BOT_TOKEN',
        app_token: 'env:SLACK_APP_TOKEN',
      },
    };
    fs.writeFileSync(
      path.join(runtimeHome, '.env'),
      'SLACK_BOT_TOKEN=xoxb-valid\nSLACK_APP_TOKEN=xapp-valid\n',
    );
    fs.writeFileSync(
      path.join(runtimeHome, 'settings.yaml'),
      renderRuntimeSettingsYaml(settings),
    );

    await collectRuntimeStatus(import.meta.url, runtimeHome);

    expect(mockRunDoctorWithNetwork).toHaveBeenCalledWith(
      import.meta.url,
      runtimeHome,
      {
        validateTelegramToken: false,
        validateSlackToken: false,
        validateModelCredentials: false,
      },
    );
  });

  it('maps unresolved runtime secret readiness details back to blocked providers', () => {
    expect(
      unresolvedProviderIdsFromRuntimeSecretDetails([
        'providers.slack.bot_token runtime secret ref gantry-secret:SLACK_BOT_TOKEN did not resolve.',
        'providers.slack.app_token runtime secret ref gantry-secret:SLACK_APP_TOKEN did not resolve.',
        'unrelated detail',
      ]),
    ).toEqual(new Set(['slack']));
  });

  it('renders the unified operator status without storage internals', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = { enabled: true };
    settings.providerAccounts.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Default Agent',
      folder: 'main_agent',
      model: 'opus',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [{ id: 'browser.use', version: 'builtin' }],
    };
    settings.conversations.main_dm = {
      providerConnection: 'telegram_default',
      externalId: '123',
      kind: 'dm',
      displayName: 'Main DM',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['123'],
    };
    settings.bindings.main_binding = {
      agent: 'main_agent',
      conversation: 'main_dm',
      trigger: '@Default Agent',
      addedAt: '2026-01-01T00:00:00.000Z',
      requiresTrigger: false,
      memoryScope: 'conversation',
    };

    const output = formatRuntimeStatus({
      doctor: {
        ok: true,
        warnings: 0,
        blockingFailures: 0,
        checks: [],
      },
      service: {
        kind: 'background',
        status: 'running(pid:12345)',
      },
      channels: [
        {
          id: 'telegram',
          label: 'Telegram',
          enabled: true,
          missingCredentialKeys: [],
        },
      ],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
      processRole: 'all',
      runtimeCapacity: {
        interactive: {
          used: 1,
          capacity: 6,
          backlog: 2,
          oldestBacklogSeconds: 33,
          warmSpare: 'available',
        },
        backgroundJobs: { used: 1, capacity: 4 },
        asyncTasks: { used: 2, capacity: 4 },
        host: { used: 2, budget: 8, cpuThreads: 8 },
      },
      sandboxWarmTemplate: {
        available: false,
        cacheHit: false,
        authorityFree: true,
      },
    } satisfies RuntimeStatusSummary);

    expect(output).toMatchInlineSnapshot(`
      "Gantry

      Runtime: Ready
      Service (background): running(pid:12345)
      Sandbox: direct (compatibility, no OS sandbox)
      Sandbox warm template: unavailable, cache miss
      Role: all (control:full, live, jobs, inbound, bake)
      Interactive capacity: 1/6
      Interactive backlog: 2, oldest 33s
      Background jobs: 1/4
      Async tasks: 2/4
      Host capacity: 2/8, CPU threads 8
      Live warm spare: available
      Workspace: default
      Agents: 1/1
      Conversations: 1/1
      Jobs: 0/0/0
      Access: 1/0
      Memory: Ready
      Providers: 1/0/0

      Next action: none"
    `);
    expect(output).not.toContain('Postgres');
    expect(output).not.toContain('settings.yaml');
    expect(output).not.toContain('IPC');
  });

  it('reports missing conversation install after provider setup is ready', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = { enabled: true };
    settings.providerAccounts.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.agents.main_agent = {
      name: 'Default Agent',
      folder: 'main_agent',
      model: 'opus',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    };

    const output = formatRuntimeStatus({
      doctor: {
        ok: true,
        warnings: 0,
        blockingFailures: 0,
        checks: [],
      },
      service: {
        kind: 'background',
        status: 'running(pid:12345)',
      },
      channels: [
        {
          id: 'telegram',
          label: 'Telegram',
          enabled: true,
          missingCredentialKeys: [],
        },
      ],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
      processRole: 'all',
    } satisfies RuntimeStatusSummary);

    expect(output).toContain('Providers: 1/0/0');
    expect(output).toContain(
      'Next action: Run `gantry conversation install --agent <agent-id> --conversation <conversation-id>` to install an agent in a conversation.',
    );
  });

  it('uses repository-backed current runtime counts when available', () => {
    const settings = createDefaultRuntimeSettings();
    const output = formatRuntimeStatus({
      doctor: {
        ok: true,
        warnings: 0,
        blockingFailures: 0,
        checks: [],
      },
      service: {
        kind: 'background',
        status: 'running(pid:12345)',
      },
      channels: [],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
      processRole: 'all',
      readModel: {
        title: 'Gantry',
        runtime: 'Ready',
        workspaceKey: 'default',
        agents: { ready: 1, total: 1 },
        conversations: { ready: 2, total: 2 },
        jobs: { ready: 4, needsAction: 1, blocked: 0 },
        access: { approved: 9, needsApproval: 0 },
        memory: 'Ready',
        providers: { ready: 1, needsConnection: 0, blocked: 0 },
        nextAction: { kind: 'none', label: 'none' },
        agentDetails: [],
      },
    } satisfies RuntimeStatusSummary);

    expect(output).toContain('Jobs: 4/1/0');
    expect(output).toContain('Access: 9/0');
    expect(output).toContain('Sandbox: direct (compatibility, no OS sandbox)');
    expect(output).toContain('Sandbox warm template: unavailable, cache miss');
  });

  it('renders unavailable sandbox_runtime state from doctor evidence', () => {
    const settings = createDefaultRuntimeSettings();
    settings.runtime.sandbox.provider = 'sandbox_runtime';

    const output = formatRuntimeStatus({
      doctor: {
        ok: false,
        warnings: 0,
        blockingFailures: 1,
        checks: [
          {
            id: 'runner-sandbox',
            title: 'Runner Sandbox',
            status: 'fail',
            message: 'sandbox_runtime needs sandbox-exec on macOS.',
          },
        ],
      },
      service: {
        kind: 'background',
        status: 'running(pid:12345)',
      },
      channels: [],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
      processRole: 'all',
    } satisfies RuntimeStatusSummary);

    expect(output).toContain(
      'Sandbox: sandbox_runtime (unavailable: sandbox_runtime needs sandbox-exec on macOS.)',
    );
    expect(output).toContain('Sandbox warm template: unavailable, cache miss');
  });

  it('renders a role line scoped to the resolved process role', () => {
    const settings = createDefaultRuntimeSettings();
    const output = formatRuntimeStatus({
      doctor: { ok: true, warnings: 0, blockingFailures: 0, checks: [] },
      service: { kind: 'background', status: 'running(pid:12345)' },
      channels: [],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
      processRole: 'live-worker',
    } satisfies RuntimeStatusSummary);

    // live-worker runs live execution + inbound, ops-only control, no jobs/bake.
    expect(output).toContain('Role: live-worker (control:ops, live, inbound)');
    expect(output).not.toContain('jobs');
  });
});
