import { describe, expect, it } from 'vitest';

import { formatRuntimeStatus } from '@core/cli/status.js';
import type { RuntimeStatusSummary } from '@core/cli/status.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

describe('status command formatting', () => {
  it('renders the unified operator status without storage internals', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = { enabled: true };
    settings.providerConnections.telegram_default = {
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
          missingEnvKeys: [],
        },
      ],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
    } satisfies RuntimeStatusSummary);

    expect(output).toMatchInlineSnapshot(`
      "Gantry

      Runtime: Ready
      Service (background): running(pid:12345)
      Sandbox: direct (compatibility, no OS sandbox)
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

  it('reports missing conversation binding after provider setup is ready', () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = { enabled: true };
    settings.providerConnections.telegram_default = {
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
          missingEnvKeys: [],
        },
      ],
      accessNeedsApprovalCount: 0,
      modelCredentialReady: true,
      memoryStatus: 'Ready',
      settings,
    } satisfies RuntimeStatusSummary);

    expect(output).toContain('Providers: 1/0/0');
    expect(output).toContain(
      'Next action: Run `gantry agent add <chat-jid>` to bind an agent to a conversation.',
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
    } satisfies RuntimeStatusSummary);

    expect(output).toContain(
      'Sandbox: sandbox_runtime (unavailable: sandbox_runtime needs sandbox-exec on macOS.)',
    );
  });
});
