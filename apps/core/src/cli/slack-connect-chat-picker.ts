import * as p from '@clack/prompts';

import { listSlackRecentChats } from './slack-chat-discovery.js';

function normalizeSlackChatJid(raw: string): string | null {
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

export type SlackChatChoice =
  { type: 'selected'; chatJid: string } | { type: 'skip' } | { type: 'cancel' };

async function promptManualSlackChatId(
  defaultChatJid = '',
): Promise<SlackChatChoice> {
  const input = await p.text({
    message: 'Slack conversation ID (optional, e.g. C0123456789)',
    placeholder: 'Press Enter to skip registration now',
    defaultValue: defaultChatJid.replace(/^sl:/, ''),
    validate: (value) => {
      const trimmed = (value || '').trim();
      if (!trimmed) return undefined;
      return normalizeSlackChatJid(trimmed)
        ? undefined
        : 'Use a valid Slack conversation ID (C..., G..., D...).';
    },
  });
  if (p.isCancel(input)) return { type: 'cancel' };
  const normalized = normalizeSlackChatJid(String(input || '').trim());
  return normalized
    ? { type: 'selected', chatJid: normalized }
    : { type: 'skip' };
}

export async function chooseSlackChatForConnect(
  botToken: string,
  defaultChatJid = '',
): Promise<SlackChatChoice> {
  const spinner = p.spinner();
  spinner.start('Discovering Slack conversations...');
  const discovery = await listSlackRecentChats({ botToken, limit: 100 });
  if (!discovery.ok) {
    spinner.stop('Could not auto-discover Slack conversations');
    p.log.info(discovery.message);
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualSlackChatId(defaultChatJid);
  }

  if (discovery.chats.length === 0) {
    spinner.stop('No Slack conversations found for this bot');
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualSlackChatId(defaultChatJid);
  }

  spinner.stop(`Found ${discovery.chats.length} Slack conversations.`);
  const selected = await p.select({
    message: 'Choose the Slack conversation for the Default Agent',
    options: [
      ...discovery.chats.slice(0, 20).map((chat) => ({
        value: chat.chatJid,
        label: `${chat.chatTitle} (${chat.chatJid.replace(/^sl:/, '')})`,
        hint: chat.chatType,
      })),
      { value: 'manual', label: 'Enter conversation ID manually' },
      { value: 'skip', label: 'Skip registration for now' },
    ],
  });
  if (p.isCancel(selected)) return { type: 'cancel' };
  if (selected === 'manual') return promptManualSlackChatId(defaultChatJid);
  if (selected === 'skip') return { type: 'skip' };
  const normalized = normalizeSlackChatJid(String(selected || '').trim());
  return normalized
    ? { type: 'selected', chatJid: normalized }
    : { type: 'skip' };
}
