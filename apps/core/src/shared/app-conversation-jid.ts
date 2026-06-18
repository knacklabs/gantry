import { isValidControlId } from './control-id.js';

const APP_CONVERSATION_JID_PREFIX = 'app:';

export function appIdFromConversationJid(
  conversationJid: string,
): string | null {
  if (!conversationJid.startsWith(APP_CONVERSATION_JID_PREFIX)) return null;
  const rest = conversationJid.slice(APP_CONVERSATION_JID_PREFIX.length);
  const delimiterIndex = rest.indexOf(':');
  if (delimiterIndex <= 0 || rest.indexOf(':', delimiterIndex + 1) !== -1) {
    return null;
  }
  const appId = rest.slice(0, delimiterIndex);
  const conversationId = rest.slice(delimiterIndex + 1);
  if (!isValidControlId(appId) || !isValidControlId(conversationId)) {
    return null;
  }
  return appId;
}
