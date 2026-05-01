import * as p from '@clack/prompts';

import { ChannelAdministrationService } from '../application/channels/channel-administration-service.js';
import { ApplicationError } from '../application/common/application-error.js';
import { EnvRuntimeSecretProvider } from '../adapters/credentials/env-runtime-secret-provider.js';
import { RuntimeSecretChannelMembershipValidator } from '../channels/channel-membership-validation.js';
import {
  getChannelProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { DoctorReport } from './doctor.js';

function usage(): string {
  return [
    'Usage:',
    '  myclaw channel connect <telegram|slack|teams>',
    '  myclaw channel list',
    '  myclaw channel info <channelId>',
    '  myclaw channel control-allowlist <channelId> [--allow <userId,userId>]',
    '  myclaw channel doctor',
  ].join('\n');
}

function formatChannelList(runtimeHome: string): string {
  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const lines = ['Channels', ''];
  for (const provider of listConnectableChannelProviders()) {
    const enabled = settings.channels[provider.id]?.enabled ?? false;
    const missing = provider.setup.envKeys.filter(
      (envKey) => !env[envKey]?.trim(),
    );
    lines.push(
      `${provider.label}: ${enabled ? 'enabled' : 'disabled'} | credentials: ${
        missing.length === 0 ? 'configured' : `missing ${missing.join(', ')}`
      }`,
    );
  }
  return lines.join('\n');
}

function scopeChannelDoctorReport(report: DoctorReport): DoctorReport {
  const channelChecks = report.checks.filter((check) =>
    [
      'runtime-settings',
      'telegram-token',
      'telegram-token-api',
      'slack-tokens',
      'teams-credentials',
    ].includes(check.id),
  );
  const checks = channelChecks.length > 0 ? channelChecks : report.checks;
  const blockingFailures = checks.filter(
    (check) => check.status === 'fail',
  ).length;
  return {
    ...report,
    checks,
    blockingFailures,
    warnings: checks.filter((check) => check.status === 'warn').length,
    ok: blockingFailures === 0,
  };
}

export async function runChannelCommand(
  importMetaUrl: string,
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, providerId] = args;
  if (!command || command === 'list') {
    p.note(formatChannelList(runtimeHome), 'Channel Status');
    return 0;
  }

  if (command === 'connect') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const provider = getChannelProvider(providerId);
    if (!provider) {
      p.log.error(`Unknown channel: ${providerId}`);
      return 1;
    }
    const { runProviderConnectCommand } = await import('./provider-connect.js');
    return runProviderConnectCommand(runtimeHome, provider.id);
  }

  if (command === 'doctor') {
    const { formatDoctorReport, runDoctorWithNetwork } =
      await import('./doctor.js');
    const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
    const scoped = scopeChannelDoctorReport(report);
    p.note(formatDoctorReport(scoped), 'Channel Doctor');
    return scoped.ok ? 0 : 1;
  }

  if (command === 'info') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    try {
      p.note(await formatChannelInfo(providerId), 'Channel Info');
      return 0;
    } catch (error) {
      p.log.error(formatChannelAdminError(error));
      return 1;
    }
  }

  if (command === 'control-allowlist') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const allowIndex = args.indexOf('--allow');
    const allowValue = allowIndex >= 0 ? args[allowIndex + 1] || '' : '';
    try {
      const service = await channelAdministrationService();
      if (allowIndex >= 0) {
        const controlAllowlist = await service.replaceControlAllowlist({
          appId: 'default' as never,
          conversationId: providerId as never,
          userIds: parseCsv(allowValue),
          updatedAt: new Date().toISOString(),
        });
        p.note(
          formatUserList(controlAllowlist.userIds),
          'Channel Control Allowlist',
        );
        return 0;
      }
      const summary = await service.getAdminSummary({
        appId: 'default' as never,
        conversationId: providerId as never,
      });
      p.note(
        formatUserList(summary.controlAllowlist.userIds),
        'Channel Control Allowlist',
      );
      return 0;
    } catch (error) {
      p.log.error(formatChannelAdminError(error));
      return 1;
    }
  }

  p.log.error(usage());
  return 1;
}

async function formatChannelInfo(channelId: string): Promise<string> {
  const repositories = await runtimeRepositories();
  const channel = await repositories.conversations.getConversation(
    channelId as never,
  );
  if (!channel || channel.appId !== 'default') {
    throw new ApplicationError('NOT_FOUND', 'Channel not found');
  }
  const [bindings, sessions, summary] = await Promise.all([
    repositories.channelInstallations.listAgentChannelBindings(
      'default' as never,
    ),
    repositories.conversations.listThreads(channel.id),
    (await channelAdministrationService()).getAdminSummary({
      appId: 'default' as never,
      conversationId: channel.id,
    }),
  ]);
  const channelBindings = bindings.filter(
    (binding) => binding.conversationId === channel.id,
  );
  return [
    `Channel: ${channel.title || channel.id}`,
    `ID: ${channel.id}`,
    `Status: ${channel.status}`,
    `Agents: ${channelBindings.map((binding) => binding.agentId).join(', ') || 'none'}`,
    `Sessions: ${sessions.length}`,
    `Control allowlist: ${formatUserList(summary.controlAllowlist.userIds)}`,
  ].join('\n');
}

async function channelAdministrationService(): Promise<ChannelAdministrationService> {
  const repositories = await runtimeRepositories();
  return new ChannelAdministrationService(
    {
      channelInstallations: repositories.channelInstallations,
      conversations: repositories.conversations,
    },
    new RuntimeSecretChannelMembershipValidator(new EnvRuntimeSecretProvider()),
  );
}

async function runtimeRepositories() {
  const { getRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  return getRuntimeStorage().repositories;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatUserList(userIds: string[]): string {
  return userIds.length > 0 ? userIds.join(', ') : 'none';
}

function formatChannelAdminError(error: unknown): string {
  if (error instanceof ApplicationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
