import * as p from '@clack/prompts';

import { RuntimeSecretConversationDiscovery } from '../channels/control-provider-catalog.js';
import { RuntimeSecretConversationMembershipValidator } from '../channels/conversation-membership-validation.js';
import {
  getProvider,
  listConnectableChannelProviders,
  providerJidPrefix,
} from '../channels/provider-registry.js';
import {
  applyConversationInstallToSettings,
  hasConversationInstallInSettings,
} from '../config/settings/conversation-install-settings.js';
import {
  loadDesiredRuntimeSettingsForWrite,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import type {
  RuntimeProviderAccountSettings,
  RuntimeSettings,
} from '../config/settings/runtime-settings-types.js';
import type { Conversation } from '../domain/conversation/conversation.js';
import type { ProviderAccount } from '../domain/provider/provider.js';
import type { ChatAllowlistEntry } from '../config/settings/sender-allowlist.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';

type MemoryScope = 'conversation' | 'user' | 'agent' | 'app';

interface ConversationChoice {
  externalId: string;
  title: string;
  kind: Conversation['kind'];
}

function normalizeConversationExternalId(
  providerId: string,
  raw: string,
): string {
  const value = raw.trim();
  const prefix = providerJidPrefix(providerId);
  return prefix && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value;
}

function conversationKindForManualId(
  providerId: string,
  externalId: string,
): Conversation['kind'] {
  if (providerId === 'slack' && externalId.toUpperCase().startsWith('D')) {
    return 'direct';
  }
  if (providerId === 'telegram' && !externalId.startsWith('-')) {
    return 'direct';
  }
  return 'channel';
}

function configuredProviderAccount(input: {
  id: string;
  settings: RuntimeProviderAccountSettings;
  now: string;
}): ProviderAccount {
  return {
    id: input.id as never,
    appId: 'default' as never,
    agentId: input.settings.agentId as never,
    providerId: input.settings.provider as never,
    label: input.settings.label,
    status: input.settings.status ?? 'active',
    config: input.settings.config ?? {},
    runtimeSecretRefs: input.settings.runtimeSecretRefs,
    ...(input.settings.externalIdentityRef
      ? {
          externalIdentityRef: input.settings.externalIdentityRef as never,
        }
      : {}),
    createdAt: input.now as never,
    updatedAt: input.now as never,
  };
}

function transientConversation(input: {
  providerAccountId: string;
  choice: ConversationChoice;
  now: string;
}): Conversation {
  return {
    id: `conversation:${input.providerAccountId}:${input.choice.externalId}` as never,
    appId: 'default' as never,
    providerAccountId: input.providerAccountId as never,
    externalRef: {
      kind: 'conversation',
      value: input.choice.externalId,
    } as never,
    kind: input.choice.kind,
    title: input.choice.title,
    status: 'active',
    createdAt: input.now as never,
    updatedAt: input.now as never,
  };
}

function parseCsv(value: unknown): string[] {
  return [
    ...new Set(
      String(value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

async function chooseAgent(settings: RuntimeSettings): Promise<string | null> {
  const agentIds = Object.keys(settings.agents).sort();
  if (agentIds.length === 0) {
    p.log.error('No existing agents are configured.');
    return null;
  }
  const selected = await p.select({
    message: 'Choose an existing agent',
    options: [
      ...agentIds.map((agentId) => ({
        value: agentId,
        label: `${settings.agents[agentId]!.name} (${agentId})`,
      })),
      { value: '__manual', label: 'Enter agent ID manually' },
      { value: '__cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(selected) || selected === '__cancel') return null;
  if (selected !== '__manual') return String(selected);
  const manual = await p.text({
    message: 'Existing agent ID',
    validate: (value) =>
      settings.agents[String(value ?? '').trim()]
        ? undefined
        : 'Agent not found. Choose an agent that already exists; this flow does not create agents.',
  });
  if (p.isCancel(manual)) return null;
  return String(manual).trim();
}

function providerAccountOptions(settings: RuntimeSettings, agentId: string) {
  const connectable = new Set(
    listConnectableChannelProviders().map((provider) => provider.id),
  );
  return Object.entries(settings.providerAccounts)
    .filter(
      ([, account]) =>
        account.agentId === agentId &&
        account.status !== 'disabled' &&
        settings.providers[account.provider]?.enabled === true &&
        connectable.has(account.provider) &&
        Object.keys(account.runtimeSecretRefs).length > 0,
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

async function chooseProviderAccount(
  settings: RuntimeSettings,
  agentId: string,
): Promise<[string, RuntimeProviderAccountSettings] | null> {
  const accounts = providerAccountOptions(settings, agentId);
  if (accounts.length === 0) {
    p.log.error(
      `No provider accounts are installed for this agent. Run gantry provider connect <provider> --agent ${agentId} first.`,
    );
    return null;
  }
  const selected = await p.select({
    message: 'Choose the Provider Account to reuse',
    options: [
      ...accounts.map(([id, account]) => ({
        value: id,
        label: `${account.label} (${account.provider}, ${id})`,
      })),
      { value: '__cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(selected) || selected === '__cancel') return null;
  const id = String(selected);
  return [id, settings.providerAccounts[id]!];
}

async function chooseConversation(input: {
  providerAccount: ProviderAccount;
  discovery: RuntimeSecretConversationDiscovery;
}): Promise<ConversationChoice | null> {
  const spinner = p.spinner();
  spinner.start(
    'Looking for conversations this provider account can access...',
  );
  let discovered: Awaited<
    ReturnType<RuntimeSecretConversationDiscovery['discover']>
  > = [];
  try {
    discovered = await input.discovery.discover({
      providerAccount: input.providerAccount,
      limit: 100,
    });
    spinner.stop(`Found ${discovered.length} conversation(s).`);
  } catch (error) {
    spinner.stop('Conversation discovery was unavailable.');
    p.log.warn(error instanceof Error ? error.message : String(error));
  }

  const selected = await p.select({
    message: 'Choose a conversation to install',
    options: [
      ...discovered.slice(0, 100).map((conversation) => ({
        value: conversation.externalId,
        label: `${conversation.title || conversation.externalId} (${conversation.externalId})`,
        hint: conversation.kind,
      })),
      { value: '__manual', label: 'Enter conversation ID manually' },
      { value: '__cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(selected) || selected === '__cancel') return null;
  if (selected !== '__manual') {
    const match = discovered.find(
      (conversation) => conversation.externalId === selected,
    )!;
    return {
      externalId: match.externalId,
      title: match.title || match.externalId,
      kind: match.kind,
    };
  }

  const providerId = String(input.providerAccount.providerId);
  const provider = getProvider(providerId);
  const manual = await p.text({
    message: `${provider?.label || providerId} conversation ID`,
    validate: (value) =>
      String(value ?? '').trim() ? undefined : 'Conversation ID is required.',
  });
  if (p.isCancel(manual)) return null;
  const externalId = normalizeConversationExternalId(
    providerId,
    String(manual),
  );
  return {
    externalId,
    title: externalId,
    kind: conversationKindForManualId(providerId, externalId),
  };
}

async function promptSenderPolicy(): Promise<ChatAllowlistEntry | null> {
  const selected = await p.select({
    message: 'Sender policy',
    options: [
      {
        value: 'all',
        label: 'Allow all senders (Recommended)',
      },
      {
        value: 'listed',
        label: 'Only listed senders',
      },
      { value: '__cancel', label: 'Cancel' },
    ],
  });
  if (p.isCancel(selected) || selected === '__cancel') return null;
  if (selected === 'all') return { allow: '*', mode: 'trigger' };
  const allow = await p.text({
    message: 'Allowed sender user IDs (comma-separated)',
    validate: (value) =>
      parseCsv(value).length > 0 ? undefined : 'Enter at least one sender ID.',
  });
  if (p.isCancel(allow)) return null;
  return { allow: parseCsv(allow), mode: 'drop' };
}

export async function runAddConversationSetupSlice(
  runtimeHome: string,
): Promise<number> {
  p.note(
    'Reuse an existing agent and Provider Account. This flow will not ask for or overwrite credentials.',
    'Add conversation to existing agent',
  );
  const settings = await loadDesiredRuntimeSettingsForWrite({ runtimeHome });
  const agentId = await chooseAgent(settings);
  if (!agentId) return 1;
  const accountChoice = await chooseProviderAccount(settings, agentId);
  if (!accountChoice) return 1;
  const [providerAccountId, accountSettings] = accountChoice;
  p.log.info(
    'Credentials: reused from this Provider Account; no secret will be changed.',
  );

  const now = new Date().toISOString();
  const providerAccount = configuredProviderAccount({
    id: providerAccountId,
    settings: accountSettings,
    now,
  });
  const db = await openRuntimeGroupDb(runtimeHome);
  try {
    const secrets = db.getRuntimeSecrets?.();
    if (!secrets) {
      p.log.error('Runtime secret storage is unavailable.');
      return 1;
    }
    const choice = await chooseConversation({
      providerAccount,
      discovery: new RuntimeSecretConversationDiscovery(secrets),
    });
    if (!choice) return 1;
    const conversation = transientConversation({
      providerAccountId,
      choice,
      now,
    });
    if (
      hasConversationInstallInSettings({
        settings,
        conversation,
        providerAccountId,
        agentFolder: agentId,
      })
    ) {
      p.log.error(
        'This conversation is already installed for this agent and Provider Account. No changes were saved.',
      );
      return 1;
    }

    const displayName = await p.text({
      message: 'Conversation display name',
      defaultValue: choice.title,
      validate: (value) =>
        String(value ?? '').trim()
          ? undefined
          : 'Conversation display name is required.',
    });
    if (p.isCancel(displayName)) return 1;
    const approverInput = await p.text({
      message:
        'Conversation approver user IDs (comma-separated; must be members of this conversation)',
      validate: (value) =>
        parseCsv(value).length > 0
          ? undefined
          : 'Enter at least one conversation approver.',
    });
    if (p.isCancel(approverInput)) return 1;
    const controlApprovers = parseCsv(approverInput);
    const membership = await new RuntimeSecretConversationMembershipValidator(
      secrets,
    ).validateControlApprovers({
      providerId: providerAccount.providerId,
      providerAccount,
      conversation,
      userIds: controlApprovers,
    });
    if (membership.invalidUserIds.length > 0) {
      p.log.error(
        [
          'Conversation access or approver membership could not be verified.',
          `Invalid approvers: ${membership.invalidUserIds.join(', ')}`,
          membership.reason,
          'Invite the Provider Account and approvers to the conversation, check provider permissions, then retry.',
        ]
          .filter(Boolean)
          .join(' '),
      );
      return 1;
    }

    const senderPolicy = await promptSenderPolicy();
    if (!senderPolicy) return 1;
    const defaultTrigger = `@${settings.agents[agentId]!.name}`;
    const trigger = await p.text({
      message: 'Trigger phrase',
      defaultValue: defaultTrigger,
      validate: (value) =>
        String(value ?? '').trim() ? undefined : 'Trigger phrase is required.',
    });
    if (p.isCancel(trigger)) return 1;
    const requiresTrigger = await p.confirm({
      message: 'Require trigger before this agent responds?',
      initialValue: choice.kind !== 'direct',
    });
    if (p.isCancel(requiresTrigger)) return 1;
    const memoryScope = await p.select({
      message: 'Memory scope',
      options: [
        {
          value: 'conversation',
          label: 'Conversation (Recommended)',
        },
        { value: 'user', label: 'User' },
        { value: 'agent', label: 'Agent' },
        { value: 'app', label: 'App' },
        { value: '__cancel', label: 'Cancel' },
      ],
    });
    if (p.isCancel(memoryScope) || memoryScope === '__cancel') return 1;

    p.note(
      [
        `Agent: ${settings.agents[agentId]!.name} (${agentId})`,
        `Provider Account: ${accountSettings.label} (${providerAccountId})`,
        `Conversation: ${String(displayName).trim()} (${choice.externalId})`,
        `Approvers: ${controlApprovers.join(', ')}`,
        `Sender policy: ${senderPolicy.allow === '*' ? 'all senders' : senderPolicy.allow.join(', ')}`,
        `Trigger: ${String(trigger).trim()}`,
        `Requires trigger: ${requiresTrigger ? 'yes' : 'no'}`,
        `Memory scope: ${String(memoryScope)}`,
        'Credentials: reused; no secret will be changed.',
      ].join('\n'),
      'Review conversation install',
    );
    const save = await p.confirm({
      message: 'Save this conversation install?',
      initialValue: true,
    });
    if (p.isCancel(save) || !save) return 1;

    const nextSettings = structuredClone(settings);
    applyConversationInstallToSettings({
      settings: nextSettings,
      conversation,
      providerAccountId,
      agentFolder: agentId,
      controlApprovers,
      now,
      displayName: String(displayName),
      senderPolicy,
      memoryScope: String(memoryScope) as MemoryScope,
      trigger: String(trigger),
      requiresTrigger: Boolean(requiresTrigger),
    });
    const result = await writeDesiredRuntimeSettings({
      runtimeHome,
      settings: nextSettings,
      previousSettings: settings,
      createdBy: 'cli:setup-add-conversation',
    });
    noteRestartRequired(result);
    p.note(
      [
        `${String(displayName).trim()} is now installed for ${settings.agents[agentId]!.name}.`,
        'Existing credentials and conversations were not changed.',
        'Next: run gantry restart for this conversation topology change to take effect.',
      ].join('\n'),
      'Conversation installed',
    );
    return 0;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await db.close();
  }
}
