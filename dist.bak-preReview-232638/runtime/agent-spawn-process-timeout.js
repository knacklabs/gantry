import fs from 'fs';
import path from 'path';
import { formatDuration } from '../shared/human-format.js';
import { nowIso } from '../shared/time/datetime.js';
import { formatScheduledJobIdleStallError, } from './agent-spawn-scheduled-idle.js';
export function writeRunnerTimeoutLog(input) {
    const ts = nowIso().replace(/[:.]/g, '-');
    const logFile = path.join(input.logsDir, `agent-${ts}.log`);
    const { runnerLabel } = input.spec;
    const timeoutTitle = input.timeoutReason === 'scheduled_job_idle_stall'
        ? 'SCHEDULED JOB IDLE STALL'
        : 'TIMEOUT';
    fs.writeFileSync(logFile, timeoutLogLines(input, logFile, timeoutTitle).join('\n'));
    const error = input.timeoutReason === 'scheduled_job_idle_stall'
        ? formatScheduledJobIdleStallError({
            timeoutMs: input.scheduledJobIdleMs,
            heartbeat: input.lastScheduledJobHeartbeat,
            logFile,
        })
        : `${runnerLabel} timed out after ${formatDuration(input.timeoutMs)}`;
    return { logFile, error };
}
function timeoutLogLines(input, logFile, timeoutTitle) {
    const { group, input: runInput, processName } = input.spec;
    return [
        `=== Agent Run Log (${timeoutTitle}) ===`,
        `Timestamp: ${nowIso()}`,
        `Group: ${group.name}`,
        `Process: ${processName}`,
        `App ID: ${runInput.appId ?? 'none'}`,
        `Agent ID: ${runInput.agentId ?? 'none'}`,
        `Session ID: ${runInput.sessionId ?? 'none'}`,
        `Job ID: ${runInput.jobId ?? 'none'}`,
        `Run ID: ${runInput.runId ?? 'none'}`,
        `Log File: ${logFile}`,
        `Duration: ${formatDuration(input.duration)}`,
        `Exit Code: ${input.code}`,
        `Had Streaming Output: ${input.hadStreamingOutput}`,
        ``,
        `=== Startup Timing ===`,
        ...input.startupLines,
        ...idleStallLines(input),
    ];
}
function idleStallLines(input) {
    if (input.timeoutReason !== 'scheduled_job_idle_stall')
        return [];
    const heartbeat = input.lastScheduledJobHeartbeat;
    return [
        `Idle Timeout: ${formatDuration(input.scheduledJobIdleMs)}`,
        `Last Tool: ${heartbeat?.lastTool ?? heartbeat?.currentTool ?? 'none'}`,
        `Last Activity At: ${heartbeat?.lastActivityAt ?? 'unknown'}`,
        `Pending Permissions: ${heartbeat?.pendingPermissionRequests ?? 0}`,
        `Pending Permission Tools: ${heartbeat?.pendingPermissionToolNames?.length
            ? heartbeat.pendingPermissionToolNames.join(', ')
            : 'none'}`,
        `Total Tool Calls: ${heartbeat?.totalToolCalls ?? 0}`,
    ];
}
