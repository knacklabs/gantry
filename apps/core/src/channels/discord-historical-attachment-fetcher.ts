import type {
  HistoricalAttachmentFetchIdentity,
  HistoricalAttachmentFetchResult,
  HistoricalAttachmentReader,
  HistoricalAttachmentUnreachableReason,
} from '../domain/ports/historical-attachment-fetcher.js';
import type {
  DiscordMessageAttachment,
  DiscordMessageCreate,
} from './discord-types.js';
import {
  discordHeaders,
  DiscordRestError,
  requestDiscordJson,
} from './discord-http-helpers.js';

const DISCORD_CDN_HOST = 'cdn.discordapp.com';
const DISCORD_CDN_REDIRECT_LIMIT = 5;
const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;
const DISCORD_API_ROOT = 'https://discord.com/api/v10';

type DiscordAttachmentIdentity = HistoricalAttachmentFetchIdentity & {
  provider: 'discord';
  kind: 'attachment_id';
  channelId: string;
  messageId: string;
  parentChannelId?: string;
};

type DiscordHistoricalAttachmentFetchInput = {
  identity: HistoricalAttachmentFetchIdentity;
  conversationJid: string;
  threadId?: string;
  providerAccountId?: string;
  signal?: AbortSignal;
};

export function createDiscordHistoricalAttachmentFetcher(
  botToken: string,
): (
  input: DiscordHistoricalAttachmentFetchInput,
) => Promise<HistoricalAttachmentFetchResult> {
  return (input) =>
    fetchDiscordHistoricalAttachment(input, {
      requestMessage: (channelId, messageId, signal) =>
        requestDiscordJson({
          url: `${DISCORD_API_ROOT}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
          init: {
            method: 'GET',
            headers: discordHeaders(botToken),
            signal,
          },
          errorMessage: 'Discord message lookup failed',
        }),
      download: (url, signal) => fetchDiscordCdnAttachment(url, signal),
    });
}

export async function fetchDiscordHistoricalAttachment(
  input: {
    identity: HistoricalAttachmentFetchIdentity;
    conversationJid: string;
    threadId?: string;
    providerAccountId?: string;
    signal?: AbortSignal;
  },
  deps: {
    requestMessage: (
      channelId: string,
      messageId: string,
      signal?: AbortSignal,
    ) => Promise<DiscordMessageCreate>;
    download: (url: string, signal?: AbortSignal) => Promise<Response>;
  },
): Promise<HistoricalAttachmentFetchResult> {
  if (
    !isDiscordAttachmentIdentity(input.identity) ||
    !isActiveDiscordAttachmentScope(input, input.identity)
  ) {
    return { status: 'unreachable', reason: 'incapable' };
  }

  let message: DiscordMessageCreate;
  try {
    message = await deps.requestMessage(
      input.identity.channelId,
      input.identity.messageId,
      input.signal,
    );
  } catch (error) {
    if (
      error instanceof DiscordRestError &&
      error.discordCode === DISCORD_UNKNOWN_MESSAGE_CODE
    ) {
      return { status: 'deleted' };
    }
    return { status: 'unreachable', reason: discordFailureReason(error) };
  }

  if (!isDiscordMessageResponse(message)) {
    return { status: 'unreachable', reason: 'unknown' };
  }
  if (message.attachments.length === 0) {
    return { status: 'unreachable', reason: 'not_visible' };
  }
  const attachment = message.attachments.find(
    (candidate) => candidate.id === input.identity.id,
  );
  if (!attachment) return { status: 'deleted' };
  if (((message.flags ?? 0) & 64) !== 0 || attachment.ephemeral === true) {
    return { status: 'unreachable', reason: 'not_visible' };
  }
  if (!attachment.url) {
    return { status: 'unreachable', reason: 'unknown' };
  }

  let response: Response;
  try {
    response = await deps.download(attachment.url, input.signal);
  } catch (error) {
    return { status: 'unreachable', reason: discordFailureReason(error) };
  }
  if (!response.ok) {
    await discardResponseBody(response);
    return {
      status: 'unreachable',
      reason: discordHttpFailureReason(response.status),
    };
  }

  return successfulAttachment(response, attachment, input.signal);
}

function isActiveDiscordAttachmentScope(
  input: { conversationJid: string; threadId?: string },
  identity: DiscordAttachmentIdentity,
): boolean {
  const conversationJid = input.conversationJid.trim();
  if (!conversationJid.startsWith('dc:')) return false;
  const conversationChannelId = conversationJid.slice('dc:'.length);
  if (
    !isDiscordId(conversationChannelId) ||
    conversationChannelId.includes(':')
  ) {
    return false;
  }
  if (input.threadId !== undefined) {
    return (
      isDiscordId(input.threadId) &&
      identity.channelId === input.threadId &&
      identity.parentChannelId === conversationChannelId
    );
  }
  return (
    identity.channelId === conversationChannelId &&
    (identity.parentChannelId === undefined ||
      identity.parentChannelId === conversationChannelId)
  );
}

export async function fetchDiscordCdnAttachment(
  rawUrl: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  let url = safeDiscordCdnUrl(rawUrl);
  for (
    let redirects = 0;
    redirects <= DISCORD_CDN_REDIRECT_LIMIT;
    redirects += 1
  ) {
    const response = await fetcher(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      signal,
    });
    if (!isRedirect(response.status)) return response;
    await discardResponseBody(response);
    if (redirects === DISCORD_CDN_REDIRECT_LIMIT) {
      throw new Error('Discord CDN redirect limit exceeded');
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('Discord CDN redirect missing location');
    url = safeDiscordCdnUrl(new URL(location, url).toString());
  }
  throw new Error('Discord CDN redirect limit exceeded');
}

function isDiscordMessageResponse(
  value: unknown,
): value is DiscordMessageCreate & { attachments: DiscordMessageAttachment[] } {
  if (typeof value !== 'object' || value === null) return false;
  const attachments = (value as { attachments?: unknown }).attachments;
  return Array.isArray(attachments) && attachments.every(isDiscordAttachment);
}

function isDiscordAttachment(
  value: unknown,
): value is DiscordMessageAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    url?: unknown;
    filename?: unknown;
    content_type?: unknown;
    ephemeral?: unknown;
  };
  return (
    typeof candidate.id === 'string' &&
    (candidate.url === undefined || typeof candidate.url === 'string') &&
    (candidate.filename === undefined ||
      typeof candidate.filename === 'string') &&
    (candidate.content_type === undefined ||
      typeof candidate.content_type === 'string') &&
    (candidate.ephemeral === undefined ||
      typeof candidate.ephemeral === 'boolean')
  );
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function safeDiscordCdnUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Unsafe Discord CDN URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== DISCORD_CDN_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Unsafe Discord CDN URL');
  }
  return url.toString();
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isDiscordAttachmentIdentity(
  identity: HistoricalAttachmentFetchIdentity,
): identity is DiscordAttachmentIdentity {
  return (
    identity.provider === 'discord' &&
    identity.kind === 'attachment_id' &&
    isDiscordId(identity.id) &&
    isDiscordId(identity.channelId) &&
    isDiscordId(identity.messageId) &&
    (identity.parentChannelId === undefined ||
      isDiscordId(identity.parentChannelId))
  );
}

function isDiscordId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

async function successfulAttachment(
  response: Response,
  attachment: DiscordMessageAttachment,
  signal?: AbortSignal,
): Promise<HistoricalAttachmentFetchResult> {
  const reader = response.body?.getReader();
  return {
    status: 'ok',
    content: reader
      ? abortableReader(reader, signal)
      : new Uint8Array(await response.arrayBuffer()),
    ...(attachment.filename ? { fileName: attachment.filename } : {}),
    ...(attachment.content_type
      ? { contentType: attachment.content_type }
      : {}),
  };
}

export function abortableReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): HistoricalAttachmentReader {
  let finished = false;
  const finish = () => {
    finished = true;
    signal?.removeEventListener('abort', cancelOnAbort);
  };
  const cancelOnAbort = () => {
    if (finished) return;
    finish();
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  if (signal?.aborted) cancelOnAbort();
  return {
    async read() {
      const chunk = await reader.read();
      if (chunk.done) finish();
      return chunk;
    },
    async cancel(reason?: unknown) {
      if (finished) return;
      finish();
      await reader.cancel(reason);
    },
  };
}

function discordFailureReason(
  error: unknown,
): HistoricalAttachmentUnreachableReason {
  if (error instanceof DiscordRestError) {
    return discordHttpFailureReason(error.status);
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return 'network';
  }
  return 'unknown';
}

function discordHttpFailureReason(
  status: number,
): HistoricalAttachmentUnreachableReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  return 'unknown';
}
