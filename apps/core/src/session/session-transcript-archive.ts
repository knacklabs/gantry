import type { ProviderArtifactStore } from '../domain/ports/provider-artifact-store.js';
import { isSafeProviderSessionId } from '../domain/sessions/provider-session-id.js';
import { logger } from '../infrastructure/logging/logger.js';

export type SessionArchiveCause =
  | 'new-session'
  | 'manual-compact'
  | 'stale-session'
  | 'abandoned-session';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TranscriptEntry {
  type?: string;
  message?: {
    content?: unknown;
  };
}

export interface ArchiveProviderSessionTranscriptInput {
  providerArtifactStore: ProviderArtifactStore;
  appId: string;
  agentId: string;
  agentSessionId: string;
  providerSessionId: string;
  provider?: string;
  sessionId: string;
  assistantName?: string;
  cause?: SessionArchiveCause;
  errorSummary?: string;
  writePlaceholderOnMissing?: boolean;
}

function generateTimestampName(now: Date): string {
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return `conversation-${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text as string)
    .join('');
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (entry.type === 'user') {
        const text = extractUserText(entry.message?.content).trim();
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant') {
        const text = extractAssistantText(entry.message?.content).trim();
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch (err) {
      logger.debug(
        {
          err,
          lineNumber: index + 1,
        },
        'Malformed transcript line while archiving session',
      );
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title: string | null,
  assistantName: string | undefined,
  now: Date,
): string {
  const formatDateTime = (date: Date) =>
    date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const clipped =
      msg.content.length > 2000
        ? `${msg.content.slice(0, 2000)}...`
        : msg.content;
    lines.push(`**${sender}**: ${clipped}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatPlaceholderMarkdown(input: {
  title: string;
  now: Date;
  cause: SessionArchiveCause;
  errorSummary?: string;
}): string {
  const lines: string[] = [];
  lines.push(`# ${input.title}`);
  lines.push('');
  lines.push(`Archived: ${input.now.toISOString()}`);
  lines.push(`Cause: ${input.cause}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('No valid transcript content was available for this session.');
  if (input.errorSummary) {
    lines.push('');
    lines.push(`Error: ${input.errorSummary}`);
  }
  lines.push('');
  return lines.join('\n');
}

function artifactContentToString(content: Uint8Array | string): string {
  return typeof content === 'string'
    ? content
    : Buffer.from(content).toString('utf-8');
}

export async function archiveProviderSessionTranscript(
  input: ArchiveProviderSessionTranscriptInput,
): Promise<string | null> {
  const {
    providerArtifactStore,
    appId,
    agentId,
    agentSessionId,
    providerSessionId,
    provider = 'anthropic',
    sessionId,
    assistantName,
    cause = 'new-session',
    errorSummary,
    writePlaceholderOnMissing = false,
  } = input;
  if (!isSafeProviderSessionId(sessionId)) {
    logger.warn(
      { sessionId },
      'Skipped provider transcript archive due to invalid session id',
    );
    return null;
  }

  try {
    const artifact = await providerArtifactStore.getLatestArtifact({
      appId: appId as never,
      agentId: agentId as never,
      agentSessionId: agentSessionId as never,
      providerSessionId: providerSessionId as never,
      provider,
      artifactKind: 'claude-jsonl',
    });
    const now = new Date();
    if (!artifact) {
      logger.info(
        { providerSessionId, sessionId },
        'No provider artifact found while archiving session',
      );
      if (!writePlaceholderOnMissing) return null;
      const markdown = formatPlaceholderMarkdown({
        title: `Session ${sessionId}`,
        now,
        cause,
        errorSummary,
      });
      const exported = await providerArtifactStore.putArtifact({
        appId: appId as never,
        agentId: agentId as never,
        agentSessionId: agentSessionId as never,
        providerSessionId: providerSessionId as never,
        provider,
        artifactKind: 'transcript-export',
        content: markdown,
        contentType: 'text/markdown',
        metadata: {
          externalSessionId: sessionId,
          cause,
          sourceArtifactId: null,
        },
      });
      return exported.id;
    }

    const content = artifactContentToString(
      await providerArtifactStore.getArtifact(artifact),
    );
    const messages = parseTranscript(content);
    const title = 'Conversation';
    const safeName = generateTimestampName(now);
    if (messages.length === 0) {
      if (!writePlaceholderOnMissing) return null;
      const markdown = formatPlaceholderMarkdown({
        title,
        now,
        cause,
        errorSummary,
      });
      const exported = await providerArtifactStore.putArtifact({
        appId: appId as never,
        agentId: agentId as never,
        agentSessionId: agentSessionId as never,
        providerSessionId: providerSessionId as never,
        provider,
        artifactKind: 'transcript-export',
        content: markdown,
        contentType: 'text/markdown',
        metadata: {
          externalSessionId: sessionId,
          cause,
          sourceArtifactId: artifact.id,
          slug: safeName,
        },
      });
      return exported.id;
    }

    const markdown = formatTranscriptMarkdown(
      messages,
      title,
      assistantName,
      now,
    );
    const exported = await providerArtifactStore.putArtifact({
      appId: appId as never,
      agentId: agentId as never,
      agentSessionId: agentSessionId as never,
      providerSessionId: providerSessionId as never,
      provider,
      artifactKind: 'transcript-export',
      content: markdown,
      contentType: 'text/markdown',
      metadata: {
        externalSessionId: sessionId,
        cause,
        sourceArtifactId: artifact.id,
        slug: safeName,
      },
    });
    return exported.id;
  } catch (err) {
    logger.error(
      { providerSessionId, sessionId, err },
      'Failed to archive provider session transcript',
    );
    return null;
  }
}
