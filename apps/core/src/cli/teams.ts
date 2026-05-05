import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import type {
  TeamsDiscoveredChannel,
  TeamsSetupCredentials,
  TeamsSetupDiscoveryClient,
} from '../channels/teams-setup-discovery.js';
import {
  GraphTeamsSetupDiscoveryClient,
  trimTeamsSetupCredentials,
} from '../channels/teams-setup-discovery.js';
import { upsertEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import {
  allocateMainAgentFolder,
  defaultTriggerForAgentName,
  normalizeMainAgentName,
} from './main-agent.js';
import { renderDefaultCapabilityRules } from '../shared/capability-guidance.js';

type TeamsChannelChoice =
  | { type: 'selected'; channel: TeamsDiscoveredChannel }
  | { type: 'skip' }
  | { type: 'cancel' };

function parseTeamsApproverIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function defaultTeamsClaudeMarkdown(): string {
  return [
    '# MyClaw Agent',
    '',
    'You are the assistant for this Teams channel.',
    'Keep responses clear, short, and useful.',
    '',
    '## Static Channel Guidance',
    '',
    'This file is for stable, Teams-specific instructions only.',
    'Dynamic task state, open commitments, and remembered facts come from query-retrieved memory context and explicit memory_search calls.',
    'Do not duplicate current task progress, raw logs, or remembered facts here.',
    '',
    'Rules:',
    '- Answer directly unless the user asks for detail.',
    '- Be explicit when an action failed and what to do next.',
    '- Avoid exposing secrets, tokens, or local machine paths unless requested.',
    '- When the user says "continue", call memory_search before guessing.',
    '',
    renderDefaultCapabilityRules(),
    '',
  ].join('\n');
}

function defaultSoulMarkdown(agentName: string): string {
  return [
    '# Soul - Who You Are',
    '',
    '## Personality',
    '- You are sharp, direct, and genuinely helpful.',
    '- Have strong opinions. Do not hedge when a clear answer exists.',
    "- Be concise. If one sentence works, use one sentence. Respect the user's time.",
    '- Lead with the answer, not the preamble.',
    '',
    '## Voice',
    '- Write like a smart colleague, not a customer-support bot.',
    '- Be proactive. Suggest ideas, spot problems, and take initiative.',
    "- Match the user's energy. Casual when they are casual, precise when they need precision.",
    '',
    '## Boundaries',
    '- Private context stays private. Never expose secrets or internal details.',
    '- Ask before taking external actions such as sending messages, posting, or pushing code.',
    '- When uncertain, say so. Do not present guesses as facts.',
    '',
    '## Continuity Boundary',
    '- Your personality lives here.',
    '- Durable facts, user preferences, task state, and open commitments do not live here.',
    '- Use query-retrieved memory context and memory_search for remembered context.',
    '',
    '## Identity',
    `- **Name:** ${agentName}`,
    '',
  ].join('\n');
}

export async function registerTeamsMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = await openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = await db.getAllRegisteredGroups();
    const existingGroup = existing[options.chatJid];
    const folder =
      existingGroup?.folder ||
      allocateMainAgentFolder(options.runtimeHome, existing);
    const groupName = normalizeMainAgentName(options.displayName);

    await db.setRegisteredGroup(options.chatJid, {
      name: groupName,
      folder,
      trigger: existingGroup?.trigger || defaultTriggerForAgentName(groupName),
      added_at: existingGroup?.added_at || new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
      agentConfig: existingGroup?.agentConfig,
    });

    const groupDir = path.join(options.runtimeHome, 'agents', folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) {
      fs.writeFileSync(claudePath, defaultTeamsClaudeMarkdown(), 'utf-8');
    }
    const soulPath = path.join(groupDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, defaultSoulMarkdown(groupName), 'utf-8');
    }

    return { folder, groupName };
  } finally {
    await db.close();
  }
}

async function promptForValue(options: {
  message: string;
  defaultValue?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
  hide?: boolean;
}): Promise<string | null> {
  const result = options.hide
    ? await p.password({
        message: options.message,
        validate: options.validate,
      })
    : await p.text({
        message: options.message,
        defaultValue: options.defaultValue,
        validate: options.validate,
      });
  if (p.isCancel(result)) return null;
  return String(result).trim();
}

async function promptManualTeamsChannel(
  credentials: TeamsSetupCredentials,
  discoveryClient: TeamsSetupDiscoveryClient,
): Promise<TeamsChannelChoice> {
  const teamId = await promptForValue({
    message: 'Teams team ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams team ID is required.',
  });
  if (teamId === null) return { type: 'cancel' };
  const channelId = await promptForValue({
    message: 'Teams channel ID (for example 19:...@thread.tacv2)',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams channel ID is required.',
  });
  if (channelId === null) return { type: 'cancel' };
  const verified = await discoveryClient.verifyChannel({
    credentials,
    teamId,
    channelId,
  });
  if (!verified.ok || !verified.chatJid) {
    p.log.error(verified.message);
    if (verified.nextAction) p.log.info(verified.nextAction);
    return { type: 'cancel' };
  }
  return {
    type: 'selected',
    channel: {
      chatJid: verified.chatJid,
      chatTitle: verified.chatTitle || verified.chatJid,
      teamId: verified.teamId || teamId,
      teamName: verified.teamName || teamId,
      channelId: verified.channelId || channelId,
      channelName: verified.channelName || channelId,
      channelType: verified.channelType || 'standard',
    },
  };
}

async function chooseTeamsChannelForConnect(
  credentials: TeamsSetupCredentials,
  discoveryClient: TeamsSetupDiscoveryClient,
): Promise<TeamsChannelChoice> {
  const spinner = p.spinner();
  spinner.start('Discovering Teams channels...');
  const discovery = await discoveryClient.listChannels({
    credentials,
    limit: 50,
  });
  if (!discovery.ok) {
    spinner.stop('Could not auto-discover Teams channels');
    p.log.info(discovery.message);
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualTeamsChannel(credentials, discoveryClient);
  }
  if (discovery.channels.length === 0) {
    spinner.stop('No Teams channels found for this app');
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualTeamsChannel(credentials, discoveryClient);
  }

  spinner.stop(`Found ${discovery.channels.length} Teams channel(s).`);
  const selected = await p.select({
    message: 'Choose the Teams channel for the Main Agent',
    options: [
      ...discovery.channels.slice(0, 20).map((channel) => ({
        value: channel.chatJid,
        label: channel.chatTitle,
        hint: channel.channelType,
      })),
      { value: 'manual', label: 'Enter team/channel IDs manually' },
      { value: 'skip', label: 'Skip registration for now' },
      { value: 'cancel', label: 'Cancel Teams connect' },
    ],
  });
  if (p.isCancel(selected) || selected === 'cancel') {
    return { type: 'cancel' };
  }
  if (selected === 'manual') {
    return promptManualTeamsChannel(credentials, discoveryClient);
  }
  if (selected === 'skip') return { type: 'skip' };
  const channel = discovery.channels.find(
    (entry) => entry.chatJid === selected,
  );
  return channel ? { type: 'selected', channel } : { type: 'skip' };
}

export async function runTeamsConnectCommand(
  runtimeHome: string,
  discoveryClient: TeamsSetupDiscoveryClient = new GraphTeamsSetupDiscoveryClient(),
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  p.note(
    [
      'Create or reuse a Microsoft Entra app for Teams Graph discovery.',
      'Grant Microsoft Graph application permissions for reading Teams and channels, then complete tenant admin consent.',
      'This setup registers a Teams channel for MyClaw. Live Teams message transport still requires a TeamsSdkClient adapter.',
      'Docs: https://learn.microsoft.com/en-us/graph/teams-concept-overview',
    ].join('\n'),
    'Teams app setup',
  );

  const clientId = await promptForValue({
    message: 'Teams client ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams client ID is required.',
  });
  if (clientId === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const clientSecret = await promptForValue({
    message: 'Teams client secret',
    hide: true,
    validate: (value) =>
      value?.trim() ? undefined : 'Teams client secret is required.',
  });
  if (clientSecret === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const tenantId = await promptForValue({
    message: 'Teams tenant ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams tenant ID is required.',
  });
  if (tenantId === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }

  const credentials = trimTeamsSetupCredentials({
    clientId,
    clientSecret,
    tenantId,
  });
  const validation = await discoveryClient.validateCredentials(credentials);
  if (!validation.ok) {
    p.log.error(validation.message);
    if (validation.nextAction) p.log.info(validation.nextAction);
    return 1;
  }
  p.log.success(validation.message);

  const channelChoice = await chooseTeamsChannelForConnect(
    credentials,
    discoveryClient,
  );
  if (channelChoice.type === 'cancel') {
    p.outro('Teams connect cancelled.');
    return 1;
  }

  let registeredFolder = '';
  let registeredGroupName = '';
  let registeredChatJid = '';
  let registeredChatTitle = '';
  const approverInput =
    channelChoice.type === 'selected'
      ? await promptForValue({
          message:
            'Teams admin/approver user IDs (comma-separated; seeds main_agent DM admin and conversation approvers; must be members of this conversation)',
          defaultValue: '',
        })
      : '';
  if (channelChoice.type === 'selected' && approverInput === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const approverIds = parseTeamsApproverIds(approverInput || '');

  if (channelChoice.type === 'selected') {
    const verified = await discoveryClient.verifyChannel({
      credentials,
      teamId: channelChoice.channel.teamId,
      channelId: channelChoice.channel.channelId,
    });
    if (!verified.ok || !verified.chatJid) {
      p.log.error(verified.message);
      if (verified.nextAction) p.log.info(verified.nextAction);
      return 1;
    }
    const registered = await registerTeamsMainGroup({
      runtimeHome,
      chatJid: verified.chatJid,
      displayName: loadRuntimeSettings(runtimeHome).agent.name,
    });
    registeredFolder = registered.folder;
    registeredGroupName = registered.groupName;
    registeredChatJid = verified.chatJid;
    registeredChatTitle = verified.chatTitle || verified.chatJid;
    p.log.success(
      `Registered ${registered.groupName} for Teams conversation ${registeredChatTitle} in folder ${registered.folder}.`,
    );
  }

  upsertEnvFile(envFilePath(runtimeHome), {
    TEAMS_CLIENT_ID: credentials.clientId,
    TEAMS_CLIENT_SECRET: credentials.clientSecret,
    TEAMS_TENANT_ID: credentials.tenantId,
  });
  const settings = loadRuntimeSettings(runtimeHome);
  settings.providers.teams.enabled = true;
  if (registeredFolder) {
    ensureConfiguredConversationBinding(settings, {
      agentId: registeredFolder,
      agentName: registeredGroupName || settings.agent.name,
      agentFolder: registeredFolder,
      jid: registeredChatJid,
      displayName: registeredChatTitle || registeredGroupName,
      trigger: `@${registeredGroupName || settings.agent.name}`,
      requiresTrigger: false,
      isMain: true,
      approverIds,
    });
  }
  saveRuntimeSettings(runtimeHome, settings);

  if (channelChoice.type === 'selected') {
    p.outro('Teams conversation is configured and ready.');
  } else {
    p.outro(
      'Teams credentials saved. Next: run `myclaw provider connect teams` to register a conversation.',
    );
  }
  return 0;
}
