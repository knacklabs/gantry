import { isSenderControlAllowed, loadSenderControlAllowlist, } from '../../platform/sender-allowlist.js';
import { extractSessionCommand, isSessionCommandAllowed, } from '../../session/session-commands.js';
import { buildTriggerPattern } from '../../shared/trigger-pattern.js';
import { liveTurnScopeForQueue, } from './live-recovery-coordinator.js';
import { controlAckMessageOptions } from './runtime-services-active-new.js';
const activeCompactReceipts = new Set();
export async function handleActiveCompactRouteMessage(input) {
    if (!isActiveCompactRouteMessage(input))
        return false;
    return input.handleActiveControlCommand({
        chatJid: input.chatJid,
        queueJid: input.queueJid,
        group: input.route,
        message: input.message,
        command: extractSessionCommand(input.message.content, buildTriggerPattern(input.route.trigger ?? '')),
    });
}
export function isActiveCompactRouteMessage(input) {
    const { message, route } = input;
    const command = extractSessionCommand(message.content, buildTriggerPattern(route.trigger ?? ''));
    if (command?.kind !== 'compact' || !input.handleActiveControlCommand) {
        return false;
    }
    const controlAllowlistCfg = loadSenderControlAllowlist();
    if (!isSessionCommandAllowed(message.is_from_me === true, isSenderControlAllowed(input.chatJid, message.sender, controlAllowlistCfg, route.folder))) {
        return false;
    }
    return true;
}
export function createActiveCompactRouteHandlers(input) {
    return {
        isActiveControlMessage: (message) => isActiveCompactRouteMessage({ ...input, message }),
        handleActiveControlMessage: (message) => handleActiveCompactRouteMessage({ ...input, message }),
    };
}
export async function queueActiveCompaction(input) {
    const hasActiveTurn = input.hasActiveTurn || (await input.findActiveLiveTurn());
    if (!hasActiveTurn) {
        if (input.receiptDedupeKey) {
            activeCompactReceipts.delete(input.receiptDedupeKey);
        }
        return false;
    }
    if (input.receiptDedupeKey &&
        activeCompactReceipts.has(input.receiptDedupeKey)) {
        return true;
    }
    if (input.receiptDedupeKey) {
        activeCompactReceipts.add(input.receiptDedupeKey);
    }
    input.enqueueMessageCheck();
    await input.sendQueuedReceipt();
    return true;
}
export function queueActiveCompactionForRuntime(input) {
    const messageKey = input.message?.id || input.message?.timestamp;
    return queueActiveCompaction({
        hasActiveTurn: input.hasActiveTurn,
        findActiveLiveTurn: async () => {
            if (!input.liveTurnAuthority)
                return false;
            const scope = await liveTurnScopeForQueue(input);
            return (!!scope && !!(await input.liveTurnAuthority.getActiveLiveTurn(scope)));
        },
        enqueueMessageCheck: () => input.app.queue.enqueueMessageCheck(input.queueJid),
        sendQueuedReceipt: input.sendQueuedReceipt,
        receiptDedupeKey: messageKey
            ? `${input.queueJid}:${messageKey}`
            : undefined,
    });
}
export function sendActiveControlReceipt(input) {
    const messageOptions = controlAckMessageOptions(input.threadId, input.providerAccountId);
    return input.sendMessage(input.text, {
        durability: 'required',
        ...(messageOptions ? { messageOptions } : {}),
    });
}
export function sendActiveCompactionQueuedReceipt(input) {
    return sendActiveControlReceipt({
        ...input,
        text: "Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.",
    });
}
