import { ChannelOwnershipPort, NewMessage } from '../domain/types.js';
import { formatLocalTime } from '../shared/timezone.js';
import '../channels/register-builtins.js';
import { getProvider } from '../channels/provider-registry.js';
import { parseTextStyles } from './text-styles.js';

export interface ConversationContextMessages {
  recentChannelContext: NewMessage[];
  activeThreadContext: NewMessage[];
  currentMessages: NewMessage[];
}

const CONTEXT_TRUNCATION_SUFFIX = '...[truncated]';

export const CONVERSATION_CONTEXT_RENDER_LIMITS = {
  messageContentBytes: 1500,
  quotedMessageContentBytes: 300,
  renderedMessageBytes: 6000,
  renderedContextBytes: 16000,
  attributeBytes: 160,
  attachmentsPerMessage: 4,
} as const;

interface MessageLineLimits {
  messageContentBytes: number;
  quotedMessageContentBytes: number;
  renderedMessageBytes: number;
  attachmentsPerMessage: number;
}

const CURRENT_MESSAGE_LINE_LIMITS: MessageLineLimits = {
  messageContentBytes: Number.POSITIVE_INFINITY,
  quotedMessageContentBytes:
    CONVERSATION_CONTEXT_RENDER_LIMITS.quotedMessageContentBytes,
  renderedMessageBytes: Number.POSITIVE_INFINITY,
  attachmentsPerMessage:
    CONVERSATION_CONTEXT_RENDER_LIMITS.attachmentsPerMessage,
};

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

export function formatConversationContextMessages(
  context: ConversationContextMessages,
  timezone: string,
): string {
  const header = `<context timezone="${escapeXml(timezone)}" />\n`;
  return renderBoundedConversationContext({
    header,
    recentChannelLines: formatMessageLineList(
      context.recentChannelContext,
      timezone,
    ),
    activeThreadLines: formatMessageLineList(
      context.activeThreadContext,
      timezone,
    ),
    currentMessages: context.currentMessages,
    timezone,
  });
}

function formatMessageLineList(
  messages: NewMessage[],
  timezone: string,
  limits: MessageLineLimits = CONVERSATION_CONTEXT_RENDER_LIMITS,
): string[] {
  return messages
    .map((message) => formatMessageLine(message, timezone, limits))
    .filter(Boolean);
}

function renderBoundedConversationContext(input: {
  header: string;
  recentChannelLines: string[];
  activeThreadLines: string[];
  currentMessages: NewMessage[];
  timezone: string;
}): string {
  const recentChannelLines = [...input.recentChannelLines];
  const activeThreadLines = [...input.activeThreadLines];
  const currentMessageLines = formatMessageLineList(
    input.currentMessages,
    input.timezone,
    CURRENT_MESSAGE_LINE_LIMITS,
  );
  const render = () =>
    `${input.header}<recent_channel_context trust="untrusted_conversation_data">\n${recentChannelLines.join(
      '\n',
    )}\n</recent_channel_context>\n<active_thread_context trust="untrusted_conversation_data">\n${activeThreadLines.join(
      '\n',
    )}\n</active_thread_context>\n<current_message trust="untrusted_conversation_data">\n${currentMessageLines.join(
      '\n',
    )}\n</current_message>`;

  while (
    utf8Bytes(render()) >
      CONVERSATION_CONTEXT_RENDER_LIMITS.renderedContextBytes &&
    recentChannelLines.length > 0
  ) {
    recentChannelLines.shift();
  }
  while (
    utf8Bytes(render()) >
      CONVERSATION_CONTEXT_RENDER_LIMITS.renderedContextBytes &&
    activeThreadLines.length > 0
  ) {
    activeThreadLines.shift();
  }
  return render();
}

function formatMessageLine(
  m: NewMessage,
  timezone: string,
  limits: MessageLineLimits,
): string {
  const displayTime = formatLocalTime(m.timestamp, timezone);
  const replyAttr = m.reply_to_message_id
    ? ` reply_to="${escapeContextAttr(m.reply_to_message_id)}"`
    : '';
  const replySnippet =
    limits.quotedMessageContentBytes > 0 &&
    m.reply_to_message_content &&
    m.reply_to_sender_name
      ? `\n  <quoted_message from="${escapeContextAttr(m.reply_to_sender_name)}">${escapeXml(
          boundedUtf8Text(
            m.reply_to_message_content,
            limits.quotedMessageContentBytes,
          ),
        )}</quoted_message>`
      : '';
  const line = `<message sender="${escapeContextAttr(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${formatAttachmentLines(
    m.attachments,
    limits,
  )}${escapeXml(
    boundedUtf8Text(m.content, limits.messageContentBytes),
  )}</message>`;
  if (utf8Bytes(line) <= limits.renderedMessageBytes) {
    return line;
  }
  return `<message sender="${escapeContextAttr(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${escapeXml(
    boundedUtf8Text(m.content, Math.min(limits.messageContentBytes, 400)),
  )}</message>`;
}

function formatAttachmentLines(
  attachments: NewMessage['attachments'],
  limits: MessageLineLimits,
): string {
  if (!attachments?.length) return '';
  const renderedAttachments = attachments.slice(
    0,
    limits.attachmentsPerMessage,
  );
  const omittedCount = attachments.length - renderedAttachments.length;
  const lines = renderedAttachments
    .map((attachment) => {
      const attrs = [
        ['kind', attachment.kind],
        ['content_type', attachment.contentType],
        [
          'size_bytes',
          Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes! >= 0
            ? Math.trunc(attachment.sizeBytes!).toString()
            : undefined,
        ],
        ['gantry_ref', formatGantryAttachmentRef(attachment.storageRef)],
      ]
        .filter(
          (attr): attr is [string, string] =>
            typeof attr[1] === 'string' && attr[1].length > 0,
        )
        .map(
          ([name, value]) =>
            `${name}="${escapeXml(boundedAttachmentAttr(value))}"`,
        )
        .join(' ');
      return `\n  <attachment ${attrs} />`;
    })
    .join('');
  return omittedCount > 0
    ? `${lines}\n  <attachments_truncated omitted="${omittedCount}" />`
    : lines;
}

function boundedAttachmentAttr(value: string): string {
  return value.length > 160 ? value.slice(0, 160) : value;
}

function escapeContextAttr(value: string): string {
  return escapeXml(
    boundedUtf8Text(value, CONVERSATION_CONTEXT_RENDER_LIMITS.attributeBytes),
  );
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  return truncateUtf8ToByteLimit(value, maxBytes, CONTEXT_TRUNCATION_SUFFIX);
}

function truncateUtf8ToByteLimit(
  text: string,
  maxBytes: number,
  suffix: string,
): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffixBytes = utf8Bytes(suffix);
  if (maxBytes <= suffixBytes)
    return truncateUtf8ToByteLimit(suffix, maxBytes, '');
  let out = '';
  let outBytes = 0;
  const contentBytes = maxBytes - suffixBytes;
  for (const char of text) {
    const charBytes = utf8Bytes(char);
    if (outBytes + charBytes > contentBytes) break;
    out += char;
    outBytes += charBytes;
  }
  return `${out}${suffix}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function formatGantryAttachmentRef(storageRef?: string): string | undefined {
  if (!storageRef?.startsWith('attachments/')) return undefined;
  if (storageRef.includes('\\') || storageRef.includes('\0')) {
    return undefined;
  }
  if (storageRef.split('/').some((part) => part === '..')) {
    return undefined;
  }
  return storageRef;
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
  const provider = getProvider(channelId);
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
