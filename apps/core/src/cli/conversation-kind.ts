export type CliConversationKind = 'dm' | 'channel';

export function telegramConversationKindForChat(input: {
  chatJid: string;
  providerChatType?: string;
}): CliConversationKind {
  const providerKind = input.providerChatType?.trim().toLowerCase();
  if (providerKind === 'private') return 'dm';
  if (
    providerKind === 'group' ||
    providerKind === 'supergroup' ||
    providerKind === 'channel'
  ) {
    return 'channel';
  }
  return input.chatJid.startsWith('tg:-') ? 'channel' : 'dm';
}

export function slackConversationKindForChat(input: {
  chatJid: string;
  providerChatType?: string;
}): CliConversationKind {
  const providerKind = input.providerChatType?.trim().toLowerCase();
  if (providerKind === 'im') return 'dm';
  if (providerKind === 'mpim') return 'channel';
  if (providerKind === 'public_channel' || providerKind === 'private_channel') {
    return 'channel';
  }
  const externalId = input.chatJid.replace(/^sl:/, '');
  if (externalId.startsWith('D')) return 'dm';
  return 'channel';
}
