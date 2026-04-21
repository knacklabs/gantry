import { ChannelOwnershipPort, NewMessage } from '../core/types.js';
import { formatLocalTime } from '../core/timezone.js';
import '../channels/register-builtins.js';
import { getChannelProvider } from '../channels/provider-registry.js';
import { parseTextStyles } from '../text-styles.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function stripInternalTagsPreserveWhitespace(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
}

export function formatOutboundForChannel(
  rawText: string,
  channelId?: string,
): string {
  const text = stripInternalTags(rawText);
  if (!text || !channelId) {
    return text;
  }
  const provider = getChannelProvider(channelId);
  if (!provider || provider.formatting === 'none') {
    return text;
  }
  return parseTextStyles(text, provider.formatting);
}

export function findChannel<T extends ChannelOwnershipPort>(
  channels: T[],
  jid: string,
): T | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
