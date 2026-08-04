import { writeOutput } from './output.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { permissionRequestToolName } from './permission-suggestions.js';
export function yoloDenylistPromptReason(match) {
    return `A YOLO-mode denylist rule matched "${match.pattern}", so this tool needs explicit approval.`;
}
export function emitYoloDenylistHit(input) {
    writeOutput({
        status: 'success',
        result: null,
        newSessionId: input.getNewSessionId(),
        runtimeEvents: [
            {
                appId: input.agentInput.appId,
                agentId: input.agentInput.agentId,
                runId: input.agentInput.runId,
                jobId: input.agentInput.jobId,
                conversationId: input.agentInput.chatJid,
                threadId: input.agentInput.threadId,
                eventType: RUNTIME_EVENT_TYPES.PERMISSION_YOLO_DENYLIST_HIT,
                actor: 'runner',
                responseMode: 'none',
                payload: {
                    decision: 'yolo_denylist_hit',
                    matchedPattern: input.match.pattern,
                    matchKind: input.match.kind,
                    tool: input.match.toolName,
                    principal: input.principal,
                    reason: input.reason,
                    conversationId: input.agentInput.chatJid,
                },
            },
        ],
    });
}
export function emitJobToolActivity(agentInput, getNewSessionId, phase, toolName, payload = {}) {
    if (!agentInput.isScheduledJob || !agentInput.jobId)
        return;
    const publicToolName = permissionRequestToolName(toolName);
    writeOutput({
        status: 'success',
        result: null,
        newSessionId: getNewSessionId(),
        runtimeEvents: [
            {
                appId: agentInput.appId,
                agentId: agentInput.agentId,
                runId: agentInput.runId,
                jobId: agentInput.jobId,
                conversationId: agentInput.chatJid,
                threadId: agentInput.threadId,
                eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
                actor: 'runner',
                responseMode: 'none',
                payload: {
                    phase,
                    tool: publicToolName,
                    sdk_tool: toolName,
                    ...payload,
                },
            },
        ],
    });
}
