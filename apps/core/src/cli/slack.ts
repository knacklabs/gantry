import * as p from '@clack/prompts';
import '../channels/register-builtins.js';

import { readEnvFile } from '../config/env/file.js';
import {
  safeSlackErrorCode,
  TOKEN_BOUND_HTTP_GUIDANCE,
  TOKEN_BOUND_NETWORK_GUIDANCE,
} from './provider-error-guidance.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  allocateDefaultAgentFolder,
  DEFAULT_AGENT_FOLDER,
  defaultTriggerForAgentName,
  normalizeDefaultAgentName,
} from './main-agent.js';
import {
  ensureConfiguredAgent,
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { chooseSlackChatForConnect } from './slack-connect-chat-picker.js';
import { nowIso } from '../shared/time/datetime.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';
import {
  createProfileFileMirrorExists,
  createProfileFileMirrorWriter,
} from '../platform/profile-file-mirror.js';
import { planRuntimeSecretInput } from './runtime-secret-ref-prompt.js';
import { providerAccountIdForAgent } from './provider-utils.js';

export interface SlackTokenValidation {
  ok: boolean;
  teamId?: string;
  teamName?: string;
  userId?: string;
  message: string;
  nextAction?: string;
}

function parseSlackApproverIds(raw: string | undefined): string[] {
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

export interface SlackAppTokenValidation {
  ok: boolean;
  message: string;
  nextAction?: string;
}

export interface SlackChatAccessValidation {
  ok: boolean;
  chatTitle?: string;
  sentTestMessage?: boolean;
  message: string;
  nextAction?: string;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: Omit<RequestInit, 'signal'>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...(init || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readSlackPayload<T>(
  response: Response,
): Promise<
  { ok?: boolean; error?: string; warning?: string; [key: string]: unknown } & T
> {
  return (await response.json()) as {
    ok?: boolean;
    error?: string;
    warning?: string;
    [key: string]: unknown;
  } & T;
}

export function normalizeSlackChatJid(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const channelIdRaw = value.startsWith('sl:')
    ? value.slice(3).trim()
    : value.trim();

  if (!/^[A-Za-z][A-Za-z0-9]{7,20}$/.test(channelIdRaw)) {
    return null;
  }

  return `sl:${channelIdRaw.toUpperCase()}`;
}

export async function validateSlackBotToken(
  token: string,
  timeoutMs = 10_000,
): Promise<SlackTokenValidation> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: 'Slack bot token is empty.',
      nextAction: 'Create a bot token (xoxb-...) and retry.',
    };
  }

  if (!trimmed.startsWith('xoxb-')) {
    return {
      ok: false,
      message: 'Slack bot token must start with xoxb-.',
      nextAction: 'Use a bot token from your Slack app OAuth install.',
    };
  }

  try {
    const response = await fetchWithTimeout(
      'https://slack.com/api/auth.test',
      timeoutMs,
      {
        headers: {
          authorization: `Bearer ${trimmed}`,
        },
      },
    );

    if (!response.ok) {
      return {
        ok: false,
        message: `Slack auth.test returned HTTP ${response.status}.`,
        nextAction: 'Check token scope and internet connectivity, then retry.',
      };
    }

    const payload = await readSlackPayload<{
      team?: string;
      team_id?: string;
      user_id?: string;
    }>(response);

    if (!payload.ok) {
      return {
        ok: false,
        message: `Slack rejected bot token: ${safeSlackErrorCode(payload.error)}`,
        nextAction:
          'Reinstall the app to workspace and copy the latest Bot User OAuth token.',
      };
    }

    return {
      ok: true,
      teamId: payload.team_id,
      teamName: payload.team,
      userId: payload.user_id,
      message: `Connected bot token for workspace ${payload.team || payload.team_id || 'unknown'}.`,
    };
  } catch {
    return {
      ok: false,
      message: 'Could not reach Slack API for bot token validation.',
      nextAction: TOKEN_BOUND_NETWORK_GUIDANCE,
    };
  }
}

export async function validateSlackAppToken(
  appToken: string,
  timeoutMs = 10_000,
): Promise<SlackAppTokenValidation> {
  const trimmed = appToken.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: 'Slack app token is empty.',
      nextAction:
        'Create an app token (xapp-...) with connections:write scope.',
    };
  }

  if (!trimmed.startsWith('xapp-')) {
    return {
      ok: false,
      message: 'Slack app token must start with xapp-.',
      nextAction: 'Use an app-level token from Slack app configuration.',
    };
  }

  try {
    const response = await fetchWithTimeout(
      'https://slack.com/api/apps.connections.open',
      timeoutMs,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${trimmed}`,
        },
      },
    );

    if (!response.ok) {
      return {
        ok: false,
        message: `Slack apps.connections.open returned HTTP ${response.status}.`,
        nextAction:
          'Verify the app token has connections:write and Socket Mode is enabled.',
      };
    }

    const payload = await readSlackPayload<{ url?: string }>(response);
    if (!payload.ok || !payload.url) {
      return {
        ok: false,
        message: `Slack rejected app token: ${safeSlackErrorCode(payload.error)}`,
        nextAction:
          'Enable Socket Mode, regenerate app token, and confirm connections:write scope.',
      };
    }

    return {
      ok: true,
      message: 'Slack app token validated for Socket Mode.',
    };
  } catch {
    return {
      ok: false,
      message: 'Could not reach Slack API for app token validation.',
      nextAction: TOKEN_BOUND_NETWORK_GUIDANCE,
    };
  }
}

export async function verifySlackChatAccess(options: {
  botToken: string;
  chatJid: string;
  sendTestMessage?: boolean;
  timeoutMs?: number;
}): Promise<SlackChatAccessValidation> {
  const botToken = options.botToken.trim();
  if (!botToken) {
    return {
      ok: false,
      message: 'Slack bot token is empty.',
      nextAction:
        'Run `gantry provider connect slack` or configure the Slack bot_token runtime secret ref.',
    };
  }

  const normalizedJid = normalizeSlackChatJid(options.chatJid);
  if (!normalizedJid) {
    return {
      ok: false,
      message: 'Invalid Slack chat ID format.',
      nextAction: 'Use a valid Slack channel ID (for example: C0123456789).',
    };
  }

  const channelId = normalizedJid.slice(3);
  const timeoutMs = options.timeoutMs ?? 10_000;

  try {
    const infoResponse = await fetchWithTimeout(
      `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
      timeoutMs,
      {
        headers: {
          authorization: `Bearer ${botToken}`,
        },
      },
    );

    if (!infoResponse.ok) {
      return {
        ok: false,
        message: `Slack conversations.info failed with HTTP ${infoResponse.status}.`,
        nextAction: TOKEN_BOUND_HTTP_GUIDANCE,
      };
    }

    const infoPayload = await readSlackPayload<{
      channel?: { name?: string; id?: string };
    }>(infoResponse);

    if (!infoPayload.ok || !infoPayload.channel?.id) {
      return {
        ok: false,
        message: `Slack could not resolve this conversation: ${safeSlackErrorCode(infoPayload.error)}`,
        nextAction: 'Invite the bot to the channel/DM and retry.',
      };
    }

    const chatTitle = infoPayload.channel.name || normalizedJid;
    const shouldSendProbe = options.sendTestMessage === true;

    if (shouldSendProbe) {
      const sendResponse = await fetchWithTimeout(
        'https://slack.com/api/chat.postMessage',
        timeoutMs,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${botToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            channel: channelId,
            text: 'Gantry setup check: Slack channel access verified.',
          }),
        },
      );

      if (!sendResponse.ok) {
        return {
          ok: false,
          chatTitle,
          message: `Slack chat.postMessage failed with HTTP ${sendResponse.status}.`,
          nextAction: TOKEN_BOUND_HTTP_GUIDANCE,
        };
      }

      const sendPayload = await readSlackPayload<{ ts?: string }>(sendResponse);
      if (!sendPayload.ok || !sendPayload.ts) {
        return {
          ok: false,
          chatTitle,
          message: `Slack rejected test message: ${safeSlackErrorCode(sendPayload.error)}`,
          nextAction: 'Ensure bot is in conversation and has chat:write scope.',
        };
      }
    }

    return {
      ok: true,
      chatTitle,
      sentTestMessage: shouldSendProbe,
      message: shouldSendProbe
        ? `Slack chat access verified for ${chatTitle}; test message sent.`
        : `Slack chat access verified for ${chatTitle}.`,
    };
  } catch {
    return {
      ok: false,
      message: 'Could not reach Slack API for chat verification.',
      nextAction: TOKEN_BOUND_NETWORK_GUIDANCE,
    };
  }
}

export async function registerSlackMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
  conversationDisplayName?: string;
  approverIds?: string[];
  agentId?: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = await openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = await db.getAllConversationRoutes();
    const existingGroup = existing[options.chatJid];
    // An already-registered conversation keeps its owning agent; agentId
    // only binds conversations that are not routed yet.
    const folder =
      existingGroup?.folder ||
      options.agentId?.trim() ||
      allocateDefaultAgentFolder(options.runtimeHome, existing);

    // A conversation owned by a DIFFERENT agent than the requested one is
    // reused as-is: rewriting its display name would rename someone else's
    // route with no rollback path in the route DB.
    const requestedAgentId = options.agentId?.trim();
    const keepExistingRoute = Boolean(
      existingGroup &&
      requestedAgentId &&
      existingGroup.folder !== requestedAgentId,
    );
    const groupName = keepExistingRoute
      ? existingGroup!.name
      : normalizeDefaultAgentName(options.displayName);

    const route = {
      name: groupName,
      folder,
      trigger: existingGroup?.trigger || defaultTriggerForAgentName(groupName),
      added_at: existingGroup?.added_at || nowIso(),
      requiresTrigger: true,
      agentConfig: existingGroup?.agentConfig,
    };
    await db.setConversationRoute(options.chatJid, route);

    const settings = loadRuntimeSettings(options.runtimeHome);
    const previousSettings = structuredClone(settings);
    ensureConfiguredConversationBinding(settings, {
      agentId: folder,
      agentName: groupName,
      agentFolder: folder,
      jid: options.chatJid,
      displayName: options.conversationDisplayName || options.displayName,
      trigger: route.trigger,
      requiresTrigger: true,
      approverIds: options.approverIds,
    });
    await writeDesiredRuntimeSettings({
      runtimeHome: options.runtimeHome,
      settings,
      previousSettings,
    });

    await new PromptProfileService({
      fileArtifactStore: () => db.getFileArtifactStore(),
      mirrorProfileFile: createProfileFileMirrorWriter(options.runtimeHome),
      mirrorFileExists: createProfileFileMirrorExists(options.runtimeHome),
    }).ensureAgentDefaults({ agentFolder: folder, agentName: groupName });

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

export async function runSlackConnectCommand(
  runtimeHome: string,
  requestedAgentId?: string,
  requestedAgentName?: string,
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  const requestedAgentDisplayName = requestedAgentName?.trim();
  const env = readEnvFile(envFilePath(runtimeHome));
  p.note(
    [
      'Create the Slack app first: create an app in the target workspace, add a bot user, then install it.',
      'Recommended bot scopes: chat:write, app_mentions:read, channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history.',
      'Enable Socket Mode and generate an app-level xapp token with connections:write.',
      'For Slack DMs, enable App Home > Messages Tab and allow users to send messages from the tab.',
      'After scope or App Home changes, reinstall the app and invite it to the target channel or DM it once before discovery.',
      'Docs: https://docs.slack.dev/apis/events-api/using-socket-mode/',
    ].join('\n'),
    'Slack app setup',
  );

  const botTokenInput = await promptForValue({
    message: 'Slack bot token (xoxb-...)',
    defaultValue: env.SLACK_BOT_TOKEN || '',
    hide: true,
    validate: (value) =>
      value?.trim() ? undefined : 'Slack bot token is required.',
  });
  if (botTokenInput === null) {
    p.outro('Slack connect cancelled.');
    return 1;
  }

  const botValidation = await validateSlackBotToken(botTokenInput);
  if (!botValidation.ok) {
    p.log.error(botValidation.message);
    if (botValidation.nextAction) p.log.info(botValidation.nextAction);
    return 1;
  }
  p.log.success(botValidation.message);

  const appTokenInput = await promptForValue({
    message: 'Slack app token (xapp-...) for Socket Mode',
    defaultValue: env.SLACK_APP_TOKEN || '',
    hide: true,
    validate: (value) =>
      value?.trim() ? undefined : 'Slack app token is required.',
  });
  if (appTokenInput === null) {
    p.outro('Slack connect cancelled.');
    return 1;
  }

  const appValidation = await validateSlackAppToken(appTokenInput);
  if (!appValidation.ok) {
    p.log.error(appValidation.message);
    if (appValidation.nextAction) p.log.info(appValidation.nextAction);
    return 1;
  }
  p.log.success(appValidation.message);

  const botSecret = await planRuntimeSecretInput({
    runtimeHome,
    name: 'SLACK_BOT_TOKEN',
    value: botTokenInput,
    actor: 'cli:slack-connect',
    label: 'Slack bot token',
  });
  if (!botSecret) {
    p.outro('Slack connect cancelled.');
    return 1;
  }
  const appSecret = await planRuntimeSecretInput({
    runtimeHome,
    name: 'SLACK_APP_TOKEN',
    value: appTokenInput,
    actor: 'cli:slack-connect',
    label: 'Slack app token',
  });
  if (!appSecret) {
    p.outro('Slack connect cancelled.');
    return 1;
  }

  const chatChoice = await chooseSlackChatForConnect(botTokenInput);
  if (chatChoice.type === 'cancel') {
    p.outro('Slack connect cancelled.');
    return 1;
  }
  const normalizedChatJid =
    chatChoice.type === 'selected' ? chatChoice.chatJid : '';
  const approverInput = normalizedChatJid
    ? await promptForValue({
        message:
          'Slack approver user IDs (comma-separated; seeds conversation approvers; must be members of this conversation)',
        defaultValue: '',
      })
    : '';
  if (normalizedChatJid && approverInput === null) {
    p.outro('Slack connect cancelled.');
    return 1;
  }
  const approverIds = parseSlackApproverIds(approverInput || '');
  let registeredFolder = '';
  let conversationRouteName = '';
  let conversationDisplayName = '';

  if (normalizedChatJid) {
    const currentSettings = loadRuntimeSettings(runtimeHome);
    const access = await verifySlackChatAccess({
      botToken: botTokenInput,
      chatJid: normalizedChatJid,
      sendTestMessage: false,
    });
    if (!access.ok) {
      p.log.error(access.message);
      if (access.nextAction) p.log.info(access.nextAction);
      return 1;
    }
    conversationDisplayName = access.chatTitle || normalizedChatJid;

    const registered = await registerSlackMainGroup({
      runtimeHome,
      chatJid: normalizedChatJid,
      displayName:
        (requestedAgentId && currentSettings.agents[requestedAgentId]?.name) ||
        requestedAgentDisplayName ||
        currentSettings.agent.name,
      conversationDisplayName,
      approverIds,
      agentId: requestedAgentId,
    });
    registeredFolder = registered.folder;
    conversationRouteName = registered.groupName;

    p.log.success(
      `Registered ${registered.groupName} for Slack conversation ${normalizedChatJid} in folder ${registered.folder}.`,
    );
  }

  await Promise.all([botSecret.persist(), appSecret.persist()]);
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  settings.providers.slack.enabled = true;
  let providerAccountId = 'slack_default';
  // The registered route's owner wins: reusing an existing conversation
  // must not hand its provider account to the requesting agent.
  const providerAgentId =
    registeredFolder || requestedAgentId || DEFAULT_AGENT_FOLDER;
  ensureConfiguredAgent(settings, {
    agentId: providerAgentId,
    agentName:
      settings.agents[providerAgentId]?.name ||
      requestedAgentDisplayName ||
      conversationRouteName ||
      settings.agent.name,
    agentFolder: providerAgentId,
  });
  if (registeredFolder) {
    const binding = ensureConfiguredConversationBinding(settings, {
      agentId: registeredFolder,
      agentName: conversationRouteName || settings.agent.name,
      agentFolder: registeredFolder,
      jid: normalizedChatJid,
      displayName:
        conversationDisplayName || conversationRouteName || settings.agent.name,
      trigger: `@${conversationRouteName || settings.agent.name}`,
      requiresTrigger: true,
      approverIds,
    });
    providerAccountId = binding.providerConnectionId;
  } else {
    providerAccountId = providerAccountIdForAgent(settings, {
      providerId: 'slack',
      agentId: providerAgentId,
      defaultAccountId: providerAccountId,
    });
  }
  settings.providerAccounts[providerAccountId] = {
    agentId: providerAgentId,
    provider: 'slack',
    label:
      settings.providerAccounts[providerAccountId]?.label || 'Slack Default',
    runtimeSecretRefs: {
      ...(settings.providerAccounts[providerAccountId]?.runtimeSecretRefs ||
        {}),
      bot_token: botSecret.ref,
      app_token: appSecret.ref,
    },
  };
  const result = await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
  });
  noteRestartRequired(result);

  if (normalizedChatJid) {
    p.outro('Slack connected. Secret stored encrypted in Gantry.');
  } else {
    p.outro(
      'Slack connected. Secret stored encrypted in Gantry. Next: run `gantry provider connect slack` to register a conversation.',
    );
  }

  return 0;
}
