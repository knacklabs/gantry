import { randomUUID } from 'node:crypto';
import { scopedDigestMetadataForSession, } from '../domain/sessions/sessions.js';
import { nowIso } from '../shared/time/datetime.js';
import { resolveScopedMemorySubject } from './app-memory-subject-resolver.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import { MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS, runWithMemoryOperationTimeout, } from '../shared/memory-dreaming-timeout.js';
const EXTRACTION_PART_CHAR_BUDGET = 900;
const EXTRACTION_TURN_CHAR_BUDGET = 2200;
const EXTRACTION_TOTAL_CHAR_BUDGET = 16_000;
const EXTRACTION_RETRIEVED_ITEM_LIMIT = 10;
const EXTRACTION_RETRIEVED_KEY_CHAR_BUDGET = 180;
const EXTRACTION_RETRIEVED_VALUE_CHAR_BUDGET = 420;
const EXTRACTION_RETRIEVED_TOTAL_CHAR_BUDGET = 3_000;
const RETRIEVED_TOOL_RESULT_TEXT_PATTERN = /\btool[_ -]?result\b/i;
function normalizeExtractionResult(value) {
    if (Array.isArray(value)) {
        return {
            facts: value,
            status: value.length > 0 ? 'facts_extracted' : 'empty_qualified',
            ...(value.length === 0 ? { zeroFactReason: 'no_qualifying_facts' } : {}),
        };
    }
    return value;
}
export async function collectDurableMemoryFromRepositories(input) {
    input.signal?.throwIfAborted();
    const session = await input.repositories.agentSessions.getAgentSession(input.agentSessionId);
    if (!session?.conversationId)
        return { saved: 0 };
    input.signal?.throwIfAborted();
    const messages = await input.repositories.messages.listRecentMessages({
        conversationId: session.conversationId,
        threadId: session.threadId,
        limit: 80,
    });
    const candidateTurns = [];
    for (const message of messages) {
        const text = messageText(message);
        if (!text)
            continue;
        if (message.direction === 'inbound') {
            candidateTurns.push({ role: 'user', text });
        }
        else if (message.direction === 'outbound') {
            candidateTurns.push({ role: 'assistant', text });
        }
    }
    for (const turn of input.additionalTurns ?? []) {
        const text = summarizeBoundedText(turn.text, EXTRACTION_TURN_CHAR_BUDGET);
        if (!text)
            continue;
        candidateTurns.push({ role: turn.role, text });
    }
    const rawRetrievedItems = (await input.repositories.memory.listPriorMemoryItems({
        session,
        limit: 10,
        ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
    }))
        .filter((item) => !item.isDeleted)
        .map((item) => ({ id: item.id, key: item.key, value: item.value }));
    const promptPayload = applyExtractionPromptBudgets({
        turns: candidateTurns,
        retrievedItems: rawRetrievedItems,
        trigger: input.trigger,
    });
    const turns = promptPayload.turns;
    if (turns.length === 0)
        return { saved: 0 };
    input.signal?.throwIfAborted();
    const extractionTimeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS));
    const extraction = normalizeExtractionResult(await runWithMemoryOperationTimeout((signal) => Promise.resolve(input.extractFacts({
        appId: session.appId,
        turns,
        trigger: input.trigger,
        userId: session.userId,
        retrievedItems: promptPayload.retrievedItems,
        signal,
        timeoutMs: extractionTimeoutMs,
    })), {
        timeoutMs: extractionTimeoutMs,
        label: 'memory boundary extraction',
        parentSignal: input.signal,
    }));
    input.signal?.throwIfAborted();
    const facts = extraction.facts;
    const now = (input.nowIso ?? (() => nowIso()))();
    const digestId = `msd_${randomUUID().replace(/-/g, '')}`;
    const digestText = buildDigestText(input.trigger, turns, facts, extraction.generatedMemory);
    await input.repositories.sessionDigests.saveAgentSessionDigest({
        id: digestId,
        appId: session.appId,
        agentSessionId: session.id,
        trigger: input.trigger,
        digest: digestText,
        messageCount: turns.length,
        extractedFactCount: facts.length,
        metadata: {
            ...scopedDigestMetadataForSession(session),
            source: 'automatic_memory_boundary_capture',
            defaultScope: input.defaultScope ?? null,
            hasAdditionalTurns: Boolean(input.additionalTurns?.length),
            boundaryCapture: {
                status: 'digest_captured',
                trigger: input.trigger,
                turnCount: turns.length,
                plannedEvidenceCount: facts.length,
            },
            extraction: {
                status: extraction.status,
                factCount: facts.length,
                ...(extraction.zeroFactReason
                    ? { zeroFactReason: extraction.zeroFactReason }
                    : {}),
            },
        },
        createdAt: now,
    });
    let saved = 0;
    for (const fact of facts) {
        input.signal?.throwIfAborted();
        const subject = subjectForFact(fact, session, input.defaultScope);
        const candidate = toCandidateMetadata(fact, input.defaultScope);
        const evidenceText = [
            `boundary trigger=${input.trigger}`,
            `kind=${fact.kind}`,
            `key=${fact.key}`,
            `value=${fact.value}`,
            fact.why ? `why=${fact.why}` : null,
        ]
            .filter((line) => Boolean(line))
            .join('\n');
        await input.repositories.memory.saveBoundaryEvidence({
            ...subject,
            sourceId: digestId,
            text: evidenceText,
            metadata: {
                digestId,
                trigger: input.trigger,
                ...(candidate ? candidate : {}),
                loadBearing: Boolean(fact.load_bearing),
                supersedes: fact.supersedes ?? [],
            },
        });
        saved += 1;
    }
    return { saved };
}
function subjectForFact(fact, session, defaultScope) {
    const scope = resolveBoundaryScope(defaultScope, fact.scope);
    const { subject } = resolveScopedMemorySubject({
        appId: session.appId,
        agentId: session.agentId,
        groupId: session.agentId,
        conversationId: session.conversationId ?? undefined,
        userId: session.userId ?? undefined,
        defaultScope: scope,
        scope,
    });
    if (subject.subjectType !== 'user' &&
        subject.subjectType !== 'group' &&
        subject.subjectType !== 'channel') {
        throw new Error('Automatic boundary extraction must not resolve common');
    }
    return {
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        ...(subject.userId ? { userId: subject.userId } : {}),
        ...(subject.groupId ? { groupId: subject.groupId } : {}),
        ...(subject.channelId ? { channelId: subject.channelId } : {}),
    };
}
function toCandidateMetadata(fact, defaultScope) {
    const normalizedWhy = fact.why?.trim();
    if (!normalizedWhy || normalizedWhy.length < 8) {
        return null;
    }
    return {
        memoryCandidate: {
            kind: fact.kind,
            scope: resolveBoundaryScope(defaultScope, fact.scope),
            key: fact.key,
            value: fact.value,
            why: normalizedWhy,
            confidence: fact.confidence,
            safety: { status: 'safe', source: 'boundary-extraction' },
        },
    };
}
function resolveBoundaryScope(defaultScope, factScope) {
    if (defaultScope)
        return defaultScope;
    if (factScope === 'user')
        return 'user';
    return 'group';
}
function buildDigestText(trigger, turns, facts, generatedMemory) {
    const tail = turns
        .slice(-8)
        .map((turn) => `- ${turn.role === 'user' ? 'user' : 'assistant'}: ${sanitizeDigestLine(turn.text, 180)}`)
        .join('\n');
    const factLines = facts
        .slice(0, 6)
        .map((fact) => `- ${fact.kind} ${sanitizeDigestLine(fact.key, 80)}: ${sanitizeDigestLine(fact.value, 140)}`)
        .join('\n');
    const generatedMemoryLine = generatedMemory?.trim()
        ? sanitizeDigestLine(generatedMemory, 500)
        : '';
    return [
        `Memory boundary digest (${trigger})`,
        '',
        `Turns captured: ${turns.length}`,
        `Facts extracted: ${facts.length}`,
        '',
        'Recent turns:',
        tail || '- none',
        '',
        'Extracted facts:',
        factLines || '- none',
        '',
        'Generated memory:',
        generatedMemoryLine || '- none',
    ].join('\n');
}
function sanitizeDigestLine(value, maxChars) {
    const sanitized = sanitizeOutboundLlmText(value).text.trim();
    if (!sanitized)
        return '[empty]';
    return truncate(sanitized, maxChars);
}
function truncate(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function summarizeUnknownValue(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `array items=${value.length}`;
    switch (typeof value) {
        case 'string':
            return `string chars=${value.length}`;
        case 'number':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'object':
            return `object keys=${Object.keys(value).length}`;
        default:
            return typeof value;
    }
}
function summarizeBoundedText(value, maxChars, label = 'text') {
    const sanitized = sanitizeOutboundLlmText(value).text.trim();
    if (!sanitized)
        return '';
    if (sanitized.length <= maxChars)
        return sanitized;
    const excerptBudget = Math.max(80, maxChars - 64);
    const excerpt = truncate(sanitized, excerptBudget);
    return `[${label} chars=${sanitized.length} excerpt=${JSON.stringify(excerpt)}]`;
}
function summarizeRetrievedMemoryText(value, maxChars, label) {
    const sanitized = sanitizeOutboundLlmText(value).text.trim();
    if (!sanitized)
        return '';
    if (RETRIEVED_TOOL_RESULT_TEXT_PATTERN.test(sanitized)) {
        return `[${label} chars=${sanitized.length} omitted=tool_result_like]`;
    }
    if (sanitized.length <= maxChars)
        return sanitized;
    const excerptBudget = Math.max(80, maxChars - 64);
    const excerpt = truncate(sanitized, excerptBudget);
    return `[${label} chars=${sanitized.length} excerpt=${JSON.stringify(excerpt)}]`;
}
function summarizeCodePart(code, language, maxChars) {
    const sanitized = sanitizeOutboundLlmText(code).text.trim();
    if (!sanitized)
        return '[code chars=0]';
    const lines = sanitized.split('\n').length;
    const label = language?.trim() ? `code:${language.trim()}` : 'code';
    if (sanitized.length <= maxChars) {
        return `[[${label} lines=${lines} chars=${sanitized.length}]\n${sanitized}]`;
    }
    const excerptBudget = Math.max(120, maxChars - 96);
    const excerpt = truncate(sanitized, excerptBudget);
    return `[${label} lines=${lines} chars=${sanitized.length} excerpt=${JSON.stringify(excerpt)}]`;
}
function applyExtractionTurnBudgets(turns, totalCharBudget = EXTRACTION_TOTAL_CHAR_BUDGET) {
    if (turns.length === 0)
        return [];
    const bounded = turns
        .map((turn) => {
        const text = summarizeBoundedText(turn.text, EXTRACTION_TURN_CHAR_BUDGET);
        if (!text)
            return null;
        return { role: turn.role, text };
    })
        .filter((turn) => Boolean(turn));
    if (bounded.length === 0)
        return [];
    const selected = [];
    let remainingChars = totalCharBudget;
    for (let index = bounded.length - 1; index >= 0; index -= 1) {
        if (remainingChars <= 0)
            break;
        const turn = bounded[index];
        const maxChars = Math.max(0, remainingChars - 32);
        if (maxChars <= 0)
            break;
        const text = turn.text.length <= maxChars
            ? turn.text
            : summarizeBoundedText(turn.text, maxChars, 'turn');
        if (!text)
            continue;
        selected.push({ role: turn.role, text });
        remainingChars -= text.length;
    }
    return selected.reverse();
}
function applyExtractionPromptBudgets(input) {
    const retrievedItems = applyRetrievedMemoryItemBudgets(input.retrievedItems);
    const emptyTurnPayloadLength = extractionPromptPayloadLength({
        trigger: input.trigger,
        turns: [],
        retrievedItems,
    });
    const turnBudget = Math.max(EXTRACTION_TURN_CHAR_BUDGET, EXTRACTION_TOTAL_CHAR_BUDGET - emptyTurnPayloadLength - 256);
    let turns = applyExtractionTurnBudgets(input.turns, turnBudget);
    while (turns.length > 0 &&
        extractionPromptPayloadLength({
            trigger: input.trigger,
            turns,
            retrievedItems,
        }) > EXTRACTION_TOTAL_CHAR_BUDGET) {
        if (turns.length > 1) {
            turns = turns.slice(1);
            continue;
        }
        const turn = turns[0];
        const overBy = extractionPromptPayloadLength({
            trigger: input.trigger,
            turns,
            retrievedItems,
        }) - EXTRACTION_TOTAL_CHAR_BUDGET;
        const nextMaxChars = Math.max(0, turn.text.length - overBy - 128);
        if (nextMaxChars < 128) {
            turns = [];
            break;
        }
        const text = summarizeBoundedText(turn.text, nextMaxChars, 'turn');
        turns = text ? [{ role: turn.role, text }] : [];
    }
    return { turns, retrievedItems };
}
function applyRetrievedMemoryItemBudgets(items) {
    const selected = [];
    let remainingChars = EXTRACTION_RETRIEVED_TOTAL_CHAR_BUDGET;
    for (const item of items.slice(0, EXTRACTION_RETRIEVED_ITEM_LIMIT)) {
        const key = summarizeRetrievedMemoryText(item.key, EXTRACTION_RETRIEVED_KEY_CHAR_BUDGET, 'memory_key') || '[empty]';
        const value = summarizeRetrievedMemoryText(item.value, EXTRACTION_RETRIEVED_VALUE_CHAR_BUDGET, 'memory_value') || '[empty]';
        const bounded = { id: item.id, key, value };
        const itemChars = retrievedMemoryItemCharLength(bounded);
        if (itemChars > remainingChars)
            break;
        selected.push(bounded);
        remainingChars -= itemChars;
    }
    return selected;
}
function retrievedMemoryItemCharLength(item) {
    return item.id.length + item.key.length + item.value.length + 24;
}
function extractionPromptPayloadLength(input) {
    return JSON.stringify({
        session_arc: input.turns,
        trigger: input.trigger,
        retrieved_items: input.retrievedItems,
    }, null, 2).length;
}
function messagePartText(part) {
    switch (part.kind) {
        case 'text':
            return summarizeBoundedText(part.text, EXTRACTION_PART_CHAR_BUDGET);
        case 'markdown':
            return summarizeBoundedText(part.markdown, EXTRACTION_PART_CHAR_BUDGET, 'markdown');
        case 'code':
            return summarizeCodePart(part.code, part.language, EXTRACTION_PART_CHAR_BUDGET);
        case 'structured':
            return `[structured ${summarizeUnknownValue(part.value)}]`;
        case 'tool_result':
            return `[tool_result ${sanitizeDigestLine(part.toolId, 64)} payload=${summarizeUnknownValue(part.value)}]`;
        case 'redacted':
            return `[redacted: ${part.reason}]`;
    }
}
function messageText(message) {
    const parts = message.parts
        .map(messagePartText)
        .filter((partText) => partText.trim().length > 0);
    if (parts.length === 0)
        return '';
    return summarizeBoundedText(parts.join('\n'), EXTRACTION_TURN_CHAR_BUDGET);
}
