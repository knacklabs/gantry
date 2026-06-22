import * as p from '@clack/prompts';

import { ConversationAdministrationService } from '../application/provider-conversations/conversation-administration-service.js';
import { ApplicationError } from '../application/common/application-error.js';
import { EnvRuntimeSecretProvider } from '../adapters/credentials/env-runtime-secret-provider.js';
import { RuntimeSecretConversationMembershipValidator } from '../channels/conversation-membership-validation.js';
import {
  getProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import type { DoctorReport } from './doctor.js';
import { nowIso } from '../shared/time/datetime.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry provider connect <telegram|slack|discord|teams>',
    '  gantry provider list',
    '  gantry provider doctor',
    '  gantry conversation info <conversationId>',
    '  gantry conversation approvers <conversationId> [--allow <userId,userId>]',
  ].join('\n');
}

function formatProviderList(runtimeHome: string): string {
  const settings = ensureRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const lines = ['Providers', ''];
  for (const provider of listConnectableChannelProviders()) {
    const enabled = settings.providers?.[provider.id]?.enabled ?? false;
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

function scopeProviderDoctorReport(report: DoctorReport): DoctorReport {
  const channelChecks = report.checks.filter((check) =>
    [
      'runtime-settings',
      'telegram-token',
      'telegram-token-api',
      'slack-tokens',
      'discord-credentials',
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

export async function runProviderCommand(
  importMetaUrl: string,
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, providerId] = args;
  if (!command || command === 'list') {
    p.note(formatProviderList(runtimeHome), 'Provider Status');
    return 0;
  }

  if (command === 'connect') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const provider = getProvider(providerId);
    if (!provider) {
      p.log.error(`Unknown provider: ${providerId}`);
      return 1;
    }
    const { runProviderConnectCommand } = await import('./provider-connect.js');
    return runProviderConnectCommand(runtimeHome, provider.id);
  }

  if (command === 'doctor') {
    const { formatDoctorReport, runDoctorWithNetwork } =
      await import('./doctor.js');
    const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
    const scoped = scopeProviderDoctorReport(report);
    p.note(formatDoctorReport(scoped), 'Provider Doctor');
    return scoped.ok ? 0 : 1;
  }

  if (command === 'info') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    try {
      const conversationId = resolveConversationIdArgument(
        runtimeHome,
        providerId,
      );
      p.note(
        await withRuntimeStorage(() => formatConversationInfo(conversationId)),
        'Conversation Info',
      );
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }

  if (command === 'control-allowlist' || command === 'approvers') {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const allowIndex = args.indexOf('--allow');
    const allowValue = allowIndex >= 0 ? args[allowIndex + 1] || '' : '';
    try {
      const conversationId = resolveConversationIdArgument(
        runtimeHome,
        providerId,
      );
      if (allowIndex >= 0) {
        const controlAllowlist = await withRuntimeStorage(async () => {
          const service = await conversationAdministrationService();
          return service.replaceControlAllowlist({
            appId: 'default' as never,
            conversationId: conversationId as never,
            userIds: parseCsv(allowValue),
            updatedAt: nowIso(),
          });
        });
        p.note(
          formatUserList(controlAllowlist.userIds),
          'Conversation Approvers',
        );
        return 0;
      }
      const summary = await withRuntimeStorage(async () => {
        const service = await conversationAdministrationService();
        return service.getAdminSummary({
          appId: 'default' as never,
          conversationId: conversationId as never,
        });
      });
      p.note(
        formatUserList(summary.controlAllowlist.userIds),
        'Conversation Approvers',
      );
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }

  p.log.error(usage());
  return 1;
}

export async function runConversationCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, conversationId] = args;
  if (command === 'info' && conversationId) {
    try {
      const resolvedConversationId = resolveConversationIdArgument(
        runtimeHome,
        conversationId,
      );
      p.note(
        await withRuntimeStorage(() =>
          formatConversationInfo(resolvedConversationId),
        ),
        'Conversation Info',
      );
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }
  if (command === 'approvers' && conversationId) {
    return runProviderCommand('', runtimeHome, [
      'approvers',
      conversationId,
      ...args.slice(2),
    ]);
  }
  p.log.error(usage());
  return 1;
}

async function formatConversationInfo(conversationId: string): Promise<string> {
  const repositories = await runtimeRepositories();
  const conversation = await repositories.conversations.getConversation(
    conversationId as never,
  );
  if (!conversation || conversation.appId !== 'default') {
    throw new ApplicationError('NOT_FOUND', 'Conversation not found');
  }
  const [bindings, sessions, summary] = await Promise.all([
    repositories.providerConnections.listAgentConversationBindings(
      'default' as never,
    ),
    repositories.conversations.listThreads(conversation.id),
    (await conversationAdministrationService()).getAdminSummary({
      appId: 'default' as never,
      conversationId: conversation.id,
    }),
  ]);
  const conversationBindings = bindings.filter(
    (binding) => binding.conversationId === conversation.id,
  );
  return [
    `Conversation: ${conversation.title || conversation.id}`,
    `ID: ${conversation.id}`,
    `Status: ${conversation.status}`,
    `Agents: ${conversationBindings.map((binding) => binding.agentId).join(', ') || 'none'}`,
    `Sessions: ${sessions.length}`,
    `Conversation approvers: ${formatUserList(summary.controlAllowlist.userIds)}`,
  ].join('\n');
}

async function conversationAdministrationService(): Promise<ConversationAdministrationService> {
  const repositories = await runtimeRepositories();
  return new ConversationAdministrationService(
    {
      providerConnections: repositories.providerConnections,
      conversations: repositories.conversations,
    },
    new RuntimeSecretConversationMembershipValidator(
      new EnvRuntimeSecretProvider(),
    ),
  );
}

async function runtimeRepositories() {
  const { getRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  return getRuntimeStorage().repositories;
}

function resolveConversationIdArgument(
  runtimeHome: string,
  conversationIdOrJid: string,
): string {
  const value = conversationIdOrJid.trim();
  if (value.startsWith('conversation:')) return value;
  const settings = ensureRuntimeSettings(runtimeHome);
  const configured = settings?.conversations?.[value];
  if (configured) {
    const connection =
      settings.providerConnections?.[configured.providerConnection];
    const provider = connection ? getProvider(connection.provider) : undefined;
    const prefix = provider?.jidPrefix ?? `${connection?.provider ?? ''}:`;
    const externalId = configured.externalId.trim();
    const jid = externalId.startsWith(prefix)
      ? externalId
      : `${prefix}${externalId}`;
    return `conversation:${jid}`;
  }
  if (/^[a-z][a-z0-9_-]*:/i.test(value)) return `conversation:${value}`;
  return value;
}

async function withRuntimeStorage<T>(fn: () => Promise<T>): Promise<T> {
  const { closeRuntimeStorage, initializeRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  await initializeRuntimeStorage();
  try {
    return await fn();
  } finally {
    await closeRuntimeStorage();
  }
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

function formatConversationAdminError(error: unknown): string {
  if (error instanceof ApplicationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
