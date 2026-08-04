import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
export function sandboxBlockedRuntimeEvents(agentInput, payload) {
    return [
        {
            eventType: RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED,
            appId: agentInput.appId,
            agentId: agentInput.agentId,
            runId: agentInput.runId,
            jobId: agentInput.jobId,
            conversationId: agentInput.chatJid,
            threadId: agentInput.threadId,
            actor: 'runner',
            responseMode: 'none',
            payload,
        },
    ];
}
export function sdkSandboxBlockedRuntimeEvents(agentInput, errorMessage) {
    if (!isSandboxBlockedError(errorMessage))
        return [];
    return sandboxBlockedRuntimeEvents(agentInput, {
        decision: 'sdk_sandbox_blocked',
        reason: redactRunnerErrorText(errorMessage).slice(0, 500),
    });
}
export function isSandboxBlockedError(errorMessage) {
    return /\b(sandbox|denyWrite|unsandboxed|seatbelt|landlock|seccomp)\b/i.test(errorMessage);
}
function redactRunnerErrorText(value) {
    return value
        .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|private[_-]?key|session[_-]?id)\b\s*(?:=|:)\s*['"]?[a-z0-9._~+/-]{8,}['"]?/gi, '$1=[REDACTED_SECRET]')
        .replace(/\bbearer\s+[a-z0-9._~+/-]{16,}\b/gi, 'bearer [REDACTED_SECRET]')
        .replace(/\b(sk-[a-z0-9]{20,}|sk-ant-[a-z0-9_-]{20,}|github_pat_[a-z0-9_]{20,}|gh[opusr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi, '[REDACTED_SECRET]');
}
