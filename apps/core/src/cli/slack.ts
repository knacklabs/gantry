import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import { readEnvFile, upsertEnvFile } from './env-file.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from './runtime-settings.js';

export interface SlackTokenValidation {
  ok: boolean;
  teamId?: string;
  teamName?: string;
  userId?: string;
  message: string;
  nextAction?: string;
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

function defaultGroupClaudeMarkdown(): string {
  return [
    '# MyClaw Agent',
    '',
    'You are the assistant for this Slack chat.\nKeep responses clear, short, and useful.',
    '',
    '## Static Chat Guidance\n\nThis file is for stable, Slack-specific instructions only.\nDynamic task state, open commitments, and remembered facts come from the injected memory/continuity brief.\nDo not duplicate current task progress, raw logs, or remembered facts here.',
    '',
    'Rules:',
    '- Answer directly unless the user asks for detail.\n- Be explicit when an action failed and what to do next.\n- Avoid exposing secrets, tokens, or local machine paths unless requested.\n- When the user says "continue", use the injected memory/continuity brief before guessing.',
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
    '- Use the injected memory/continuity brief for remembered context.',
    '',
    '## Identity',
    `- **Name:** ${agentName}`,
    '',
  ].join('\n');
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
        message: `Slack rejected bot token: ${payload.error || 'unknown_error'}`,
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
  } catch (err) {
    return {
      ok: false,
      message: 'Could not reach Slack API for bot token validation.',
      nextAction: `Check internet access and retry. Details: ${err instanceof Error ? err.message : String(err)}`,
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
        message: `Slack rejected app token: ${payload.error || 'unknown_error'}`,
        nextAction:
          'Enable Socket Mode, regenerate app token, and confirm connections:write scope.',
      };
    }

    return {
      ok: true,
      message: 'Slack app token validated for Socket Mode.',
    };
  } catch (err) {
    return {
      ok: false,
      message: 'Could not reach Slack API for app token validation.',
      nextAction: `Check internet access and retry. Details: ${err instanceof Error ? err.message : String(err)}`,
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
      nextAction: 'Set SLACK_BOT_TOKEN before checking chat access.',
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
      const body = await infoResponse.text();
      return {
        ok: false,
        message: `Slack conversations.info failed with HTTP ${infoResponse.status}.`,
        nextAction: `Confirm channel ID and bot scopes. Response: ${body.slice(0, 160)}`,
      };
    }

    const infoPayload = await readSlackPayload<{
      channel?: { name?: string; id?: string };
    }>(infoResponse);

    if (!infoPayload.ok || !infoPayload.channel?.id) {
      return {
        ok: false,
        message: `Slack could not resolve this conversation: ${infoPayload.error || 'unknown_error'}`,
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
            text: 'MyClaw setup check: Slack channel access verified.',
          }),
        },
      );

      if (!sendResponse.ok) {
        const body = await sendResponse.text();
        return {
          ok: false,
          chatTitle,
          message: `Slack chat.postMessage failed with HTTP ${sendResponse.status}.`,
          nextAction: `Invite the app to this conversation and grant posting scope. Response: ${body.slice(0, 160)}`,
        };
      }

      const sendPayload = await readSlackPayload<{ ts?: string }>(sendResponse);
      if (!sendPayload.ok || !sendPayload.ts) {
        return {
          ok: false,
          chatTitle,
          message: `Slack rejected test message: ${sendPayload.error || 'unknown_error'}`,
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
  } catch (err) {
    return {
      ok: false,
      message: 'Could not reach Slack API for chat verification.',
      nextAction: `Check internet access and retry. Details: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function buildGroupFolder(
  runtimeHome: string,
  existing: Record<string, { folder: string }>,
): string {
  const used = new Set(Object.values(existing).map((group) => group.folder));
  const hasOnDiskFolder = (folder: string): boolean =>
    fs.existsSync(path.join(runtimeHome, 'agents', folder));

  if (!used.has('slack_main') && !hasOnDiskFolder('slack_main')) {
    return 'slack_main';
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `slack_main_${i}`;
    if (!used.has(candidate) && !hasOnDiskFolder(candidate)) return candidate;
  }
  return `slack_main_${Date.now()}`;
}

export async function registerSlackMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = db.getAllRegisteredGroups();
    const existingGroup = existing[options.chatJid];
    const folder =
      existingGroup?.folder || buildGroupFolder(options.runtimeHome, existing);

    const groupName = options.displayName.trim() || 'Slack Main';

    const groupDir = path.join(options.runtimeHome, 'agents', folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    const claudePath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) {
      fs.writeFileSync(claudePath, defaultGroupClaudeMarkdown(), 'utf-8');
    }
    const soulPath = path.join(groupDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(soulPath, defaultSoulMarkdown(groupName), 'utf-8');
    }

    db.setRegisteredGroup(options.chatJid, {
      name: groupName,
      folder,
      trigger: '@Andy',
      added_at: existingGroup?.added_at || new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
      agentConfig: existingGroup?.agentConfig,
    });

    return { folder, groupName };
  } finally {
    db.close();
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
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));

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

  const chatIdInput = await p.text({
    message:
      'Slack conversation ID for main group (optional, e.g. C0123456789)',
    placeholder: 'Press Enter to skip registration now',
    validate: (value) => {
      const trimmed = (value || '').trim();
      if (!trimmed) return undefined;
      return normalizeSlackChatJid(trimmed)
        ? undefined
        : 'Use a valid Slack conversation ID (C..., G..., D...).';
    },
  });

  if (p.isCancel(chatIdInput)) {
    p.outro('Slack connect cancelled.');
    return 1;
  }

  const normalizedChatJid = normalizeSlackChatJid(
    String(chatIdInput).trim() || '',
  );

  if (normalizedChatJid) {
    const access = await verifySlackChatAccess({
      botToken: botTokenInput,
      chatJid: normalizedChatJid,
      sendTestMessage: true,
    });
    if (!access.ok) {
      p.log.error(access.message);
      if (access.nextAction) p.log.info(access.nextAction);
      return 1;
    }

    const registered = await registerSlackMainGroup({
      runtimeHome,
      chatJid: normalizedChatJid,
      displayName: access.chatTitle || 'Slack Main',
    });

    p.log.success(
      `Registered Slack main group ${registered.groupName} (${normalizedChatJid}) in folder ${registered.folder}.`,
    );
  }

  upsertEnvFile(envFilePath(runtimeHome), {
    SLACK_BOT_TOKEN: botTokenInput,
    SLACK_APP_TOKEN: appTokenInput,
  });
  const settings = loadRuntimeSettings(runtimeHome);
  settings.channels.slack.enabled = true;
  saveRuntimeSettings(runtimeHome, settings);

  if (normalizedChatJid) {
    p.outro('Slack channel is configured and ready.');
  } else {
    p.outro(
      'Slack tokens saved. Next: run `myclaw agent add sl:<channel-id> --main --requires-trigger false`.',
    );
  }

  return 0;
}
