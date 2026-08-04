import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { nowMs } from '../../../../shared/time/datetime.js';
import { IPC_BASE_DIR } from './runtime-env.js';
import { permissionRequestToolName } from './permission-suggestions.js';
const JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export function startJobHeartbeat(input) {
    const { agentInput } = input;
    let lastActivityAtMs = nowMs();
    let currentTool;
    let lastTool;
    let totalToolCalls = 0;
    const markActivity = () => {
        lastActivityAtMs = nowMs();
        currentTool = undefined;
    };
    if (!agentInput.isScheduledJob || !agentInput.jobId) {
        return {
            markActivity,
            recordToolActivity: markActivity,
            stop: () => undefined,
        };
    }
    const emitHeartbeat = () => {
        const pendingPermissions = readPendingPermissionRequests();
        input.writeOutput({
            status: 'success',
            result: null,
            newSessionId: input.getSessionId(),
            runtimeEvents: [
                {
                    appId: agentInput.appId,
                    agentId: agentInput.agentId,
                    runId: agentInput.runId,
                    jobId: agentInput.jobId,
                    conversationId: agentInput.chatJid,
                    threadId: agentInput.threadId,
                    eventType: RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
                    actor: 'runner',
                    responseMode: 'none',
                    payload: {
                        ...(currentTool ? { currentTool } : {}),
                        ...(lastTool ? { lastTool } : {}),
                        lastActivityAt: new Date(lastActivityAtMs).toISOString(),
                        lastActivityAgoMs: Math.max(0, nowMs() - lastActivityAtMs),
                        pendingPermissionRequests: pendingPermissions.count,
                        pendingPermissionToolNames: pendingPermissions.toolNames,
                        totalToolCalls,
                    },
                },
            ],
        });
    };
    const timer = setInterval(emitHeartbeat, JOB_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return {
        markActivity,
        recordToolActivity: (toolName) => {
            totalToolCalls += 1;
            currentTool = permissionRequestToolName(toolName);
            lastTool = currentTool;
            lastActivityAtMs = nowMs();
        },
        stop: () => clearInterval(timer),
    };
}
function readPendingPermissionRequests() {
    const responsesDir = path.join(IPC_BASE_DIR, 'permission-responses');
    const responseIds = new Set(readJsonFileNames(responsesDir).map((file) => file.replace(/\.json$/, '')));
    const requests = readJsonFileNames(path.join(IPC_BASE_DIR, 'permission-requests'))
        .filter((file) => !responseIds.has(file.replace(/\.json$/, '')))
        .map((file) => readCurrentRunPermissionRequest(file))
        .filter((request) => Boolean(request));
    const toolNames = Array.from(new Set(requests
        .map((request) => request.toolName)
        .filter((toolName) => Boolean(toolName))));
    return { count: requests.length, toolNames };
}
function readJsonFileNames(dir) {
    try {
        return fs
            .readdirSync(dir)
            .filter((file) => file.endsWith('.json') && !file.endsWith('.tmp'));
    }
    catch {
        return [];
    }
}
function readCurrentRunPermissionRequest(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(IPC_BASE_DIR, 'permission-requests', file), 'utf8'));
        const payload = raw && typeof raw === 'object' && 'payload' in raw
            ? raw.payload
            : raw;
        if (!payload || typeof payload !== 'object')
            return undefined;
        const record = payload;
        const matches = (!process.env.GANTRY_JOB_ID ||
            record.jobId === process.env.GANTRY_JOB_ID) &&
            (!process.env.GANTRY_JOB_RUN_ID ||
                record.runId === process.env.GANTRY_JOB_RUN_ID);
        if (!matches)
            return undefined;
        return {
            toolName: typeof record.toolName === 'string'
                ? permissionRequestToolName(record.toolName)
                : undefined,
        };
    }
    catch {
        return undefined;
    }
}
