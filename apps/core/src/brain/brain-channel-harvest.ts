import { createHash } from 'node:crypto';

import type { RuntimeSettings } from '../config/settings/runtime-settings.js';
import { jidForConfiguredConversation } from '../config/settings/desired-state-provider-conversations.js';
import type { NewMessage } from '../domain/types.js';
import { normalizeBrainSlug } from './brain-page-ingest.js';
import type { BrainService } from './brain-service.js';
import type { BrainPage } from './brain-types.js';

export interface BrainChannelHarvestTap {
  harvest(input: {
    appId: string;
    message: NewMessage;
    settings: RuntimeSettings;
  }): Promise<void>;
}

export class BrainChannelHarvester implements BrainChannelHarvestTap {
  // ponytail: in-process per-slug chaining; the persistence queue runs 4
  // concurrent slots and harvest is a read-modify-write. Upgrade to an
  // atomic SQL append if harvest ever runs in more than one process.
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly brain: BrainService) {}

  async harvest(input: {
    appId: string;
    message: NewMessage;
    settings: RuntimeSettings;
  }): Promise<void> {
    if (!isBrainHarvestEnabled(input.settings, input.message)) return;
    const text = input.message.content.trim();
    if (!text) return;
    const target = harvestTarget(input.message);
    const key = `${input.appId}:${target.slug}`;
    const run = (this.pending.get(key) ?? Promise.resolve()).then(() =>
      this.appendToPage(input.appId, input.message, target),
    );
    const chained = run.catch(() => undefined);
    this.pending.set(key, chained);
    try {
      await run;
    } finally {
      if (this.pending.get(key) === chained) this.pending.delete(key);
    }
  }

  private async appendToPage(
    appId: string,
    message: NewMessage,
    target: { slug: string; title: string; sourceRef: string },
  ): Promise<void> {
    const existing = await this.brain.getPageBySlug(appId, target.slug);
    if (existing && existing.sourceKind !== 'channel') {
      // Never replace user/import/agent/dream pages that happen to occupy
      // the deterministic channel slug; mirror the dream collision guard.
      throw new Error(
        `harvest slug ${target.slug} collides with a ${existing.sourceKind} page`,
      );
    }
    const next = buildHarvestPage(existing, message, target);
    if (existing?.markdown === next.body && samePeople(existing, next.people)) {
      return;
    }
    await this.brain.write({
      appId,
      slug: target.slug,
      title: target.title,
      markdown: markdownWithFrontmatter(
        {
          title: target.title,
          source_kind: 'channel',
          people: next.people,
        },
        next.body,
      ),
      sourceKind: 'channel',
      sourceRef: target.sourceRef,
      embed: false,
    });
  }
}

export function isBrainHarvestEnabled(
  settings: RuntimeSettings,
  message: Pick<NewMessage, 'chat_jid' | 'providerAccountId'>,
): boolean {
  // Fail closed: opt-in is a disclosure boundary and conversation ids are
  // only unique per provider account, so an ambiguous account never harvests.
  if (!message.providerAccountId) return false;
  return Object.values(settings.conversations).some((conversation) => {
    if (!conversation.brainHarvest) return false;
    if (conversation.providerAccount !== message.providerAccountId) {
      return false;
    }
    return (
      jidForConfiguredConversation(conversation, settings.providerAccounts) ===
      message.chat_jid
    );
  });
}

function harvestTarget(message: NewMessage): {
  slug: string;
  title: string;
  sourceRef: string;
} {
  // Provider conversation ids are only unique within one provider account,
  // so the account is part of the page identity. The readable prefix is
  // truncated well under the 120-char slug cap and a stable hash anchors
  // identity, so long account/conversation ids can never truncate away the
  // thread/day suffix or collapse distinct conversations into one page.
  const account = message.providerAccountId?.trim() || 'default';
  const sourceBase = `${account}:${message.chat_jid}`;
  const prefix = normalizeBrainSlug(`${account}-${message.chat_jid}`).slice(
    0,
    60,
  );
  const threadId = message.thread_id?.trim();
  const discriminator = threadId ?? dayFromTimestamp(message.timestamp);
  const anchor = createHash('sha256')
    .update(`${sourceBase}#${discriminator}`)
    .digest('hex')
    .slice(0, 10);
  const suffix = normalizeBrainSlug(discriminator).slice(0, 24);
  return {
    slug: `chan-${prefix}-${suffix}-${anchor}`,
    title: threadId
      ? `Channel ${message.chat_jid} thread ${threadId}`
      : `Channel ${message.chat_jid} ${discriminator}`,
    sourceRef: `${sourceBase}#${discriminator}`,
  };
}

function buildHarvestPage(
  existing: BrainPage | null,
  message: NewMessage,
  target: { title: string },
): { body: string; people: string[] } {
  const line = harvestLine(message);
  const lines = existing?.markdown.trim()
    ? existing.markdown.trim().split('\n').filter(Boolean)
    : [`# ${target.title}`];
  if (!lines.includes(line)) lines.push(line);
  const body = lines.sort(compareHarvestLines).join('\n');
  const people = dedupeStrings([
    ...peopleFromMetadata(existing?.metadata),
    senderName(message),
  ]);
  return { body, people };
}

function harvestLine(message: NewMessage): string {
  // The page body is line-oriented (split/dedupe/sort on '\n'), so embedded
  // newlines must be flattened or multiline messages fragment and re-append.
  const content = message.content.trim().replace(/\s*\r?\n\s*/g, ' ');
  return `[${senderName(message)} at ${message.timestamp}] ${content}`;
}

function senderName(message: NewMessage): string {
  return message.sender_name?.trim() || message.sender?.trim() || 'unknown';
}

function compareHarvestLines(left: string, right: string): number {
  if (left.startsWith('# ')) return -1;
  if (right.startsWith('# ')) return 1;
  return timestampFromLine(left).localeCompare(timestampFromLine(right));
}

function timestampFromLine(line: string): string {
  return /^\[[^\]]+ at ([^\]]+)\]/.exec(line)?.[1] ?? '';
}

function dayFromTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp.slice(0, 10)
    : date.toISOString().slice(0, 10);
}

function peopleFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const people = (metadata as Record<string, unknown>).people;
  return Array.isArray(people)
    ? people.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function samePeople(page: BrainPage, next: string[]): boolean {
  return peopleFromMetadata(page.metadata).join('\0') === next.join('\0');
}

function dedupeStrings(values: string[]): string[] {
  const out = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) out.set(trimmed.toLowerCase(), trimmed);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

function markdownWithFrontmatter(
  frontmatter: Record<string, string | string[]>,
  body: string,
): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(quoteYaml).join(', ')}]`);
    } else {
      lines.push(`${key}: ${quoteYaml(value)}`);
    }
  }
  lines.push('---', body);
  return lines.join('\n');
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
