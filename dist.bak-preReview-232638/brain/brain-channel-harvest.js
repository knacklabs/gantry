import { createHash } from 'node:crypto';
import { jidForConfiguredConversation } from '../config/settings/desired-state-provider-conversations.js';
import { normalizeBrainSlug } from './brain-page-ingest.js';
export class BrainChannelHarvester {
    brain;
    // ponytail: in-process per-slug chaining; the persistence queue runs 4
    // concurrent slots and harvest is a read-modify-write. Upgrade to an
    // atomic SQL append if harvest ever runs in more than one process.
    pending = new Map();
    constructor(brain) {
        this.brain = brain;
    }
    async harvest(input) {
        if (!isBrainHarvestEnabled(input.settings, input.message))
            return;
        const text = input.message.content.trim();
        if (!text)
            return;
        const target = harvestTarget(input.message);
        const key = `${input.appId}:${target.slug}`;
        const run = (this.pending.get(key) ?? Promise.resolve()).then(() => this.appendToPage(input.appId, input.message, target));
        const chained = run.catch(() => undefined);
        this.pending.set(key, chained);
        try {
            await run;
        }
        finally {
            if (this.pending.get(key) === chained)
                this.pending.delete(key);
        }
    }
    async appendToPage(appId, message, target) {
        const existing = await this.brain.getPageBySlug(appId, target.slug);
        if (existing && existing.sourceKind !== 'channel') {
            // Never replace user/import/agent/dream pages that happen to occupy
            // the deterministic channel slug; mirror the dream collision guard.
            throw new Error(`harvest slug ${target.slug} collides with a ${existing.sourceKind} page`);
        }
        const next = buildHarvestPage(existing, message, target);
        if (existing?.markdown === next.body && samePeople(existing, next.people)) {
            return;
        }
        await this.brain.write({
            appId,
            slug: target.slug,
            title: target.title,
            markdown: markdownWithFrontmatter({
                title: target.title,
                source_kind: 'channel',
                people: next.people,
            }, next.body),
            sourceKind: 'channel',
            sourceRef: target.sourceRef,
            embed: false,
        });
    }
}
export function isBrainHarvestEnabled(settings, message) {
    // Fail closed: opt-in is a disclosure boundary and conversation ids are
    // only unique per provider account, so an ambiguous account never harvests.
    if (!message.providerAccountId)
        return false;
    return Object.values(settings.conversations).some((conversation) => {
        if (!conversation.brainHarvest)
            return false;
        if (conversation.providerAccount !== message.providerAccountId) {
            return false;
        }
        return (jidForConfiguredConversation(conversation, settings.providerAccounts) ===
            message.chat_jid);
    });
}
function harvestTarget(message) {
    // Provider conversation ids are only unique within one provider account,
    // so the account is part of the page identity. The readable prefix is
    // truncated well under the 120-char slug cap and a stable hash anchors
    // identity, so long account/conversation ids can never truncate away the
    // thread/day suffix or collapse distinct conversations into one page.
    const account = message.providerAccountId?.trim() || 'default';
    const sourceBase = `${account}:${message.chat_jid}`;
    const prefix = normalizeBrainSlug(`${account}-${message.chat_jid}`).slice(0, 60);
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
function buildHarvestPage(existing, message, target) {
    const line = harvestLine(message);
    const lines = existing?.markdown.trim()
        ? existing.markdown.trim().split('\n').filter(Boolean)
        : [`# ${target.title}`];
    if (!lines.includes(line))
        lines.push(line);
    const body = lines.sort(compareHarvestLines).join('\n');
    const people = dedupeStrings([
        ...peopleFromMetadata(existing?.metadata),
        senderName(message),
    ]);
    return { body, people };
}
function harvestLine(message) {
    // The page body is line-oriented (split/dedupe/sort on '\n'), so embedded
    // newlines must be flattened or multiline messages fragment and re-append.
    const content = message.content.trim().replace(/\s*\r?\n\s*/g, ' ');
    return `[${senderName(message)} at ${message.timestamp}] ${content}`;
}
function senderName(message) {
    return message.sender_name?.trim() || message.sender?.trim() || 'unknown';
}
function compareHarvestLines(left, right) {
    if (left.startsWith('# '))
        return -1;
    if (right.startsWith('# '))
        return 1;
    return timestampFromLine(left).localeCompare(timestampFromLine(right));
}
function timestampFromLine(line) {
    return /^\[[^\]]+ at ([^\]]+)\]/.exec(line)?.[1] ?? '';
}
function dayFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? timestamp.slice(0, 10)
        : date.toISOString().slice(0, 10);
}
function peopleFromMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return [];
    const people = metadata.people;
    return Array.isArray(people)
        ? people.filter((entry) => typeof entry === 'string')
        : [];
}
function samePeople(page, next) {
    return peopleFromMetadata(page.metadata).join('\0') === next.join('\0');
}
function dedupeStrings(values) {
    const out = new Map();
    for (const value of values) {
        const trimmed = value.trim();
        if (trimmed)
            out.set(trimmed.toLowerCase(), trimmed);
    }
    return [...out.values()].sort((a, b) => a.localeCompare(b));
}
function markdownWithFrontmatter(frontmatter, body) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(frontmatter)) {
        if (Array.isArray(value)) {
            lines.push(`${key}: [${value.map(quoteYaml).join(', ')}]`);
        }
        else {
            lines.push(`${key}: ${quoteYaml(value)}`);
        }
    }
    lines.push('---', body);
    return lines.join('\n');
}
function quoteYaml(value) {
    return JSON.stringify(value);
}
