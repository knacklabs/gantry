import * as p from '@clack/prompts';

import { ConversationAdministrationService } from '../application/provider-conversations/conversation-administration-service.js';
import { ApplicationError } from '../application/common/application-error.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
import { RuntimeSecretConversationMembershipValidator } from '../channels/conversation-membership-validation.js';
import {
  getProvider,
  listConnectableChannelProviders,
} from '../channels/provider-registry.js';
import {
  loadDesiredRuntimeSettingsForWrite,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
} from '../config/settings/desired-settings-writer.js';
import type { AgentId } from '../domain/agent/agent.js';
import { folderForAgentId } from '../domain/agent/agent-folder-id.js';
import type { ConversationId } from '../domain/conversation/conversation.js';
import type { ProviderAccountId } from '../domain/provider/provider.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';
import type { DoctorReport } from './doctor.js';
import {
  assertRuntimeSecretRef,
  configuredConversationKey,
  option,
  parseRuntimeSecretRefOptions,
} from './provider-utils.js';
import { nowIso } from '../shared/time/datetime.js';

type DesiredRuntimeSettings = Awaited<
  ReturnType<typeof loadDesiredRuntimeSettingsForWrite>
>;

function usage(): string {
  return [
    'Usage:',
    '  gantry provider account connect <provider> --agent <agent-id> [--secret-ref key=ref]',
    '  gantry provider account list',
    '  gantry provider account rotate-secret <provider-account-id> --key <key> --ref <runtime-secret-ref>',
    '  gantry provider doctor',
    '  gantry provider list',
    '  gantry provider connect <telegram|slack|discord|teams>',
    '  gantry conversation install --agent <agent-id> --provider-account <id> --conversation <conversationId>',
    '  gantry conversation installs list',
    '  gantry conversation info <conversationId>',
    '  gantry conversation approvers <conversationId> [--allow <userId,userId>]',
  ].join('\n');
}

async function formatProviderList(runtimeHome: string): Promise<string> {
  const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
  const lines = ['Providers', ''];
  for (const provider of listConnectableChannelProviders()) {
    const enabled = settings.providers?.[provider.id]?.enabled ?? false;
    const accounts = Object.entries(settings.providerAccounts).filter(
      ([, candidate]) =>
        candidate.provider === provider.id && candidate.status !== 'disabled',
    );
    let credentialStatus = 'missing provider account';
    for (const [accountId, account] of accounts) {
      const missing = provider.setup.envKeys.filter((envKey) => {
        const key = runtimeSecretKeyForEnv(provider.id, envKey);
        return !account.runtimeSecretRefs[key]?.trim();
      });
      if (missing.length === 0) {
        credentialStatus = 'secret refs configured';
        break;
      }
      credentialStatus = `missing ${accountId}.${missing.join(', ')}`;
    }
    lines.push(
      `${provider.label}: ${enabled ? 'enabled' : 'disabled'} | credentials: ${
        credentialStatus
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
      'slack-token-api',
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
  if (command === 'account') {
    return runProviderAccountCommand(runtimeHome, args.slice(1));
  }
  if (!command || command === 'list') {
    p.note(await formatProviderList(runtimeHome), 'Provider Status');
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
    // Provider doctor reports only channel checks — skip the live model
    // credential probes whose results the scoped report would discard.
    const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome, {
      validateModelCredentials: false,
    });
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
      const conversationId = await resolveConversationIdArgument(
        runtimeHome,
        providerId,
        { providerAccountId: option(args, '--provider-account') },
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
      const conversationId = await resolveConversationIdArgument(
        runtimeHome,
        providerId,
        { providerAccountId: option(args, '--provider-account') },
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
  if (command === 'install') {
    return runConversationInstallCommand(runtimeHome, args.slice(1));
  }
  if (command === 'installs' && conversationId === 'list') {
    try {
      p.note(
        await withRuntimeStorage(() => formatConversationInstalls()),
        'Conversation Installs',
      );
      return 0;
    } catch (error) {
      p.log.error(formatConversationAdminError(error));
      return 1;
    }
  }
  if (command === 'info' && conversationId) {
    try {
      const resolvedConversationId = await resolveConversationIdArgument(
        runtimeHome,
        conversationId,
        { providerAccountId: option(args, '--provider-account') },
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

async function runProviderAccountCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, idOrProvider] = args;
  try {
    if (!command || command === 'list') {
      p.note(
        await withRuntimeStorage(() => formatProviderAccounts()),
        'Provider Accounts',
      );
      return 0;
    }
    if (command === 'connect') {
      return await connectProviderAccount(idOrProvider, args.slice(2));
    }
    if (command === 'rotate-secret') {
      return await rotateProviderAccountSecret(idOrProvider, args.slice(2));
    }
  } catch (error) {
    p.log.error(formatConversationAdminError(error));
    return 1;
  }
  p.log.error(usage());
  return 1;

  async function connectProviderAccount(
    providerId: string | undefined,
    rest: string[],
  ): Promise<number> {
    if (!providerId) {
      p.log.error(usage());
      return 1;
    }
    const provider = getProvider(providerId);
    if (!provider) {
      p.log.error(`Unknown provider: ${providerId}`);
      return 1;
    }
    const agentId = option(rest, '--agent');
    if (!agentId) {
      p.log.error('Provider Account connect requires --agent <agent-id>.');
      return 1;
    }
    const runtimeSecretRefs = parseRuntimeSecretRefOptions(rest);
    const label =
      option(rest, '--label') || `${provider.label} Provider Account`;
    const id =
      option(rest, '--id') ||
      `provider-account:${provider.id}:${agentId}:${Date.now()}`;
    const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
    const previousSettings = structuredClone(settings);
    const agentFolder = settingsAgentFolder(settings, agentId);
    if (!agentFolder) {
      throw new ApplicationError('NOT_FOUND', 'Agent not found');
    }
    settings.providers[provider.id] = {
      ...(settings.providers[provider.id] ?? {}),
      enabled: true,
    };
    settings.providerAccounts[id] = {
      agentId: agentFolder,
      provider: provider.id,
      label,
      status: 'active',
      runtimeSecretRefs,
      config: {},
    };
    const result = await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
      createdBy: 'cli:provider-account-connect',
    });
    noteRestartRequired(result);
    p.note(
      [
        `Provider Account: ${label}`,
        `Agent: ${agentId}`,
        `Status: ${Object.keys(runtimeSecretRefs).length ? 'Installed' : 'Needs setup'}`,
      ].join('\n'),
      'Provider Account',
    );
    return 0;
  }

  async function rotateProviderAccountSecret(
    providerAccountId: string | undefined,
    rest: string[],
  ): Promise<number> {
    if (!providerAccountId) {
      p.log.error(usage());
      return 1;
    }
    const key = option(rest, '--key');
    const ref = option(rest, '--ref');
    if (!key || !ref) {
      p.log.error(
        'Provider Account rotate-secret requires --key <key> --ref <runtime-secret-ref>.',
      );
      return 1;
    }
    assertRuntimeSecretRef(ref);
    const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
    const previousSettings = structuredClone(settings);
    const account = settings.providerAccounts[providerAccountId];
    if (!account) {
      throw new ApplicationError('NOT_FOUND', 'Provider Account not found');
    }
    settings.providerAccounts[providerAccountId] = {
      ...account,
      runtimeSecretRefs: { ...(account.runtimeSecretRefs ?? {}), [key]: ref },
    };
    const result = await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
      createdBy: 'cli:provider-account-rotate-secret',
    });
    noteRestartRequired(result);
    p.note('Provider Account secret ref updated.', 'Provider Account');
    return 0;
  }
}

async function runConversationInstallCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const agentId = option(args, '--agent');
  const providerAccountId = option(args, '--provider-account');
  const conversationId = option(args, '--conversation');
  if (!agentId || !providerAccountId || !conversationId) {
    p.log.error(usage());
    return 1;
  }
  try {
    const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
    const previousSettings = structuredClone(settings);
    const agentFolder = settingsAgentFolder(settings, agentId);
    if (!agentFolder) {
      throw new ApplicationError('NOT_FOUND', 'Agent not found');
    }
    const accountSettings = settings.providerAccounts[providerAccountId];
    if (!accountSettings) {
      throw new ApplicationError('NOT_FOUND', 'Provider Account not found');
    }
    if (accountSettings.agentId !== agentFolder) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Provider Account belongs to a different Agent',
      );
    }
    const conversation = await withRuntimeStorage(async () => {
      const repositories = await runtimeRepositories();
      const [account, storedConversation] = await Promise.all([
        getProviderAccountsRepo(repositories).getProviderAccount(
          providerAccountId as ProviderAccountId,
        ),
        repositories.conversations.getConversation(
          conversationId as ConversationId,
        ),
      ]);
      if (!account || account.appId !== 'default') {
        throw new ApplicationError('NOT_FOUND', 'Provider Account not found');
      }
      if (folderForAgentId(account.agentId as AgentId) !== agentFolder) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          'Provider Account belongs to a different Agent',
        );
      }
      if (!storedConversation || storedConversation.appId !== 'default') {
        throw new ApplicationError('NOT_FOUND', 'Conversation not found');
      }
      if (storedConversation.providerAccountId !== account.id) {
        throw new ApplicationError(
          'INVALID_REQUEST',
          'Conversation belongs to a different Provider Account',
        );
      }
      return storedConversation;
    });
    const now = nowIso();
    const conversationKey = configuredConversationKey(
      settings,
      conversation,
      providerAccountId,
    );
    const externalId =
      conversation.externalRef?.value ||
      String(conversation.id).replace(/^conversation:/, '');
    settings.conversations[conversationKey] = {
      providerConnection: providerAccountId,
      providerAccount: providerAccountId,
      externalId,
      kind: conversation.kind === 'direct' ? 'dm' : conversation.kind,
      displayName:
        conversation.title ||
        settings.conversations[conversationKey]?.displayName ||
        conversationKey,
      senderPolicy:
        settings.conversations[conversationKey]?.senderPolicy ??
        ({ allow: '*', mode: 'trigger' } as never),
      controlApprovers:
        settings.conversations[conversationKey]?.controlApprovers ?? [],
      installedAgents: {
        ...(settings.conversations[conversationKey]?.installedAgents ?? {}),
        [agentFolder]: {
          agentId: agentFolder,
          providerAccountId,
          status: 'active',
          addedAt: now,
          memoryScope: 'conversation',
          trigger: `@${settings.agents[agentFolder]?.name || agentFolder}`,
          requiresTrigger: conversation.kind !== 'direct',
        },
      },
    };
    const result = await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
      createdBy: 'cli:conversation-install',
    });
    noteRestartRequired(result);
    p.note(
      [
        `Agent: ${agentFolder}`,
        `Conversation: ${conversation.id}`,
        `Provider Account: ${providerAccountId}`,
        'Status: Installed',
      ].join('\n'),
      'Conversation Install',
    );
    return 0;
  } catch (error) {
    p.log.error(formatConversationAdminError(error));
    return 1;
  }
}

function settingsAgentFolder(
  settings: DesiredRuntimeSettings,
  agentId: string,
): string | undefined {
  if (settings.agents[agentId]) return agentId;
  const folder = folderForAgentId(agentId as AgentId);
  return folder && settings.agents[folder] ? folder : undefined;
}

async function formatProviderAccounts(): Promise<string> {
  const repositories = await runtimeRepositories();
  const rows = await getProviderAccountsRepo(repositories).listProviderAccounts(
    'default' as never,
  );
  if (rows.length === 0) return 'Provider Accounts: none';
  return rows
    .map((account: any) =>
      [
        `Provider Account: ${account.label}`,
        `Agent: ${account.agentId}`,
        `Status: ${account.status === 'active' ? 'Installed' : 'Needs setup'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

async function formatConversationInstalls(): Promise<string> {
  const repositories = await runtimeRepositories();
  const repo = getProviderAccountsRepo(repositories);
  const rows = await repo.listConversationInstalls('default' as never);
  if (rows.length === 0) return 'Conversation Installs: none';
  return rows
    .map((install: any) =>
      [
        `Agent: ${install.agentId}`,
        `Conversation: ${install.conversationId}`,
        `Provider Account: ${install.providerAccountId}`,
        `Status: ${install.status === 'active' ? 'Installed' : 'Needs setup'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

async function formatConversationInfo(conversationId: string): Promise<string> {
  const repositories = await runtimeRepositories();
  const conversation = await repositories.conversations.getConversation(
    conversationId as never,
  );
  if (!conversation || conversation.appId !== 'default') {
    throw new ApplicationError('NOT_FOUND', 'Conversation not found');
  }
  const [installs, sessions, summary] = await Promise.all([
    listInstallsForInfo(repositories),
    repositories.conversations.listThreads(conversation.id),
    (await conversationAdministrationService()).getAdminSummary({
      appId: 'default' as never,
      conversationId: conversation.id,
    }),
  ]);
  const conversationInstalls = installs.filter(
    (install) => install.conversationId === conversation.id,
  );
  return [
    `Conversation: ${conversation.title || conversation.id}`,
    `ID: ${conversation.id}`,
    `Status: ${conversation.status}`,
    `Agents: ${conversationInstalls.map((install) => install.agentId).join(', ') || 'none'}`,
    `Sessions: ${sessions.length}`,
    `Conversation approvers: ${formatUserList(summary.controlAllowlist.userIds)}`,
  ].join('\n');
}

async function conversationAdministrationService(): Promise<ConversationAdministrationService> {
  const repositories = await runtimeRepositories();
  return new ConversationAdministrationService(
    {
      providerAccounts: getProviderAccountsRepo(repositories) as never,
      conversations: repositories.conversations,
    },
    new RuntimeSecretConversationMembershipValidator(
      createRepositoryRuntimeSecretProvider({
        appId: 'default' as never,
        repository: repositories.capabilitySecrets,
      }),
    ),
  );
}

async function runtimeRepositories() {
  const { getRuntimeStorage } =
    await import('../adapters/storage/postgres/runtime-store.js');
  return getRuntimeStorage().repositories;
}

function getProviderAccountsRepo(repositories: any): any {
  return repositories.providerAccounts;
}

async function listInstallsForInfo(repositories: any): Promise<any[]> {
  const repo = getProviderAccountsRepo(repositories);
  return repo.listConversationInstalls('default' as never);
}

async function resolveConversationIdArgument(
  runtimeHome: string,
  conversationIdOrJid: string,
  options: { providerAccountId?: string | null } = {},
): Promise<string> {
  const value = conversationIdOrJid.trim();
  if (value.startsWith('conversation:')) return value;
  const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
  const configured = settings?.conversations?.[value];
  if (configured) return conversationIdFromConfigured(settings, configured);
  const matchingConfigured = Object.values(settings.conversations ?? {})
    .map((entry: any) => conversationIdFromConfigured(settings, entry))
    .filter((conversationId) => conversationId.endsWith(`:${value}`));
  if (matchingConfigured.length === 1) return matchingConfigured[0];
  if (/^[a-z][a-z0-9_-]*:/i.test(value)) {
    const providerAccountId =
      options.providerAccountId || soleProviderAccountIdForJid(settings, value);
    if (!providerAccountId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Raw conversation IDs require --provider-account <id> or a configured conversation key.',
      );
    }
    return `conversation:${providerAccountId}:${value}`;
  }
  return value;
}

function conversationIdFromConfigured(
  settings: DesiredRuntimeSettings,
  configured: any,
): string {
  const providerAccountId =
    configured.providerAccount ?? configured.providerConnection;
  const connection = settings.providerAccounts?.[providerAccountId];
  const provider = connection ? getProvider(connection.provider) : undefined;
  const prefix = provider?.jidPrefix ?? `${connection?.provider ?? ''}:`;
  const externalId = configured.externalId.trim();
  const jid = externalId.startsWith(prefix)
    ? externalId
    : `${prefix}${externalId}`;
  return `conversation:${providerAccountId}:${jid}`;
}

function soleProviderAccountIdForJid(
  settings: DesiredRuntimeSettings,
  jid: string,
): string | undefined {
  const matches = Object.entries(settings.providerAccounts ?? {})
    .filter(([, account]: any) => {
      const provider = getProvider(account.provider);
      return provider?.jidPrefix ? jid.startsWith(provider.jidPrefix) : false;
    })
    .map(([id]) => id);
  return matches.length === 1 ? matches[0] : undefined;
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
