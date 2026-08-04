import { isTriggerAllowed, loadSenderAllowlist, } from '../platform/sender-allowlist.js';
export function groupTurnHasRequiredTrigger(input) {
    if (input.group.requiresTrigger === false)
        return true;
    const allowlistCfg = loadSenderAllowlist();
    return input.messages.some((message) => input.triggerPattern.test(message.content.trim()) &&
        (message.is_from_me ||
            isTriggerAllowed(input.chatJid, message.sender, allowlistCfg, input.group.folder)));
}
