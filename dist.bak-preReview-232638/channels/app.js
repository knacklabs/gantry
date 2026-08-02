import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../infrastructure/logging/logger.js';
import { RUNTIME_EVENT_TYPES, } from '../domain/events/runtime-event-types.js';
import { SessionInteractionModule } from '../application/sessions/session-interaction-module.js';
import { getRuntimeControlRepository, getRuntimeEventExchange, } from '../adapters/storage/postgres/runtime-store.js';
import { adaptSessionControlPort } from '../control/server/session-control-port.js';
import { nowIso } from '../shared/time/datetime.js';
import { richFallbackText } from './rich-interaction.js';
function canonicalTextMetadata(text) {
    const metadataContentWindowChars = 160;
    return {
        lengthChars: text.length,
        lengthBytes: Buffer.byteLength(text, 'utf8'),
        hasContent: text.trim().length > 0,
        hasTruncatedContent: text.length > metadataContentWindowChars,
        sha256: createHash('sha256').update(text).digest('hex'),
    };
}
async function emitSessionEvent(chatJid, eventType, payload) {
    const result = await createSessionInteractionModule().publishOutboundEvent({
        conversationJid: chatJid,
        eventType,
        payload,
    });
    if (!result.emitted) {
        logger.warn({ chatJid, eventType }, 'App channel event dropped without session');
    }
    return result;
}
function createSessionInteractionModule() {
    return new SessionInteractionModule({
        control: adaptSessionControlPort(getRuntimeControlRepository()),
        ops: {},
        repositories: {},
        runtimeEvents: getRuntimeEventExchange(),
        now: () => nowIso(),
        createId: randomUUID,
        stableHash: (input) => createHash('sha256').update(input).digest('hex'),
    });
}
export async function createAppChannel(_opts) {
    let connected = false;
    let outboundSequence = 0;
    const orderedEnvelope = (kind) => ({
        sequence: ++outboundSequence,
        kind,
        partIndex: 1,
        totalParts: 1,
    });
    const sendMessage = async (jid, text, options) => {
        const result = await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND, {
            text,
            threadId: options?.threadId ?? null,
            orderedEnvelope: orderedEnvelope('outbound'),
            canonicalText: canonicalTextMetadata(text),
        });
        return result.eventId !== undefined
            ? { externalMessageId: String(result.eventId) }
            : {};
    };
    return {
        name: 'app',
        async connect() {
            connected = true;
        },
        isConnected() {
            return connected;
        },
        async disconnect() {
            connected = false;
        },
        ownsJid(jid) {
            return jid.startsWith('app:');
        },
        sendMessage,
        async sendStreamingChunk(jid, text, options) {
            const result = await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING, {
                text,
                threadId: options?.threadId ?? null,
                done: options?.done === true,
                generation: options?.generation ?? null,
                orderedEnvelope: orderedEnvelope('streaming'),
                canonicalText: canonicalTextMetadata(text),
            });
            return result.emitted;
        },
        resetStreaming(_jid, _options) { },
        async setTyping(jid, isTyping) {
            await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_TYPING, {
                isTyping,
                orderedEnvelope: orderedEnvelope('typing'),
            });
        },
        async sendProgressUpdate(jid, text, options) {
            await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_PROGRESS, {
                text,
                threadId: options?.threadId ?? null,
                done: options?.done === true,
                actionOnly: options?.actionOnly === true,
                actionAffordances: options?.done
                    ? []
                    : (options?.actionAffordances ?? []),
                orderedEnvelope: orderedEnvelope('progress'),
                canonicalText: canonicalTextMetadata(text),
            });
        },
        async renderRichInteraction(jid, render) {
            const fallbackText = richFallbackText(render);
            const result = await emitSessionEvent(jid, RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND, {
                kind: 'rich_interaction',
                descriptor: render.descriptor,
                fallbackText,
                threadId: render.threadId ?? null,
                orderedEnvelope: orderedEnvelope('rich_interaction'),
                canonicalText: canonicalTextMetadata(fallbackText),
            });
            return result.emitted;
        },
    };
}
