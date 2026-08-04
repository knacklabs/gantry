const TERMINAL_STATUSES = new Set([
    'completed',
    'failed',
    'cancelled',
    'timed_out',
]);
export function isAsyncTaskTerminal(status) {
    return TERMINAL_STATUSES.has(status);
}
export function toPublicAsyncTaskDto(task) {
    const failure = publicFailure(task.privateCorrelationJson.failure);
    const terminalChildren = publicTerminalChildren(task.privateCorrelationJson.terminalChildren);
    return {
        id: task.id,
        kind: task.kind,
        status: task.status,
        summary: task.summary,
        outputSummary: task.outputSummary,
        errorSummary: task.errorSummary,
        ...(failure ? { failure } : {}),
        ...(terminalChildren.length > 0 ? { terminalChildren } : {}),
        ...publicProgress(task),
        ...publicInspection(task),
        receiptLines: receiptLines(task.receiptJson),
        allowedActions: isAsyncTaskTerminal(task.status)
            ? ['get', 'list']
            : ['get', 'list', 'cancel'],
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        terminalAt: task.terminalAt,
    };
}
function publicFailure(value) {
    const failure = record(value);
    const type = failure.type;
    const attemptedAction = stringValue(failure.attemptedAction);
    if (!['execution', 'timeout', 'cancelled', 'child_task'].includes(typeof type === 'string' ? type : '') ||
        !attemptedAction) {
        return null;
    }
    return {
        type: type,
        attemptedAction,
        partialResult: stringValue(failure.partialResult),
    };
}
function publicTerminalChildren(value) {
    return Array.isArray(value)
        ? value.filter((entry) => Boolean(entry &&
            typeof entry === 'object' &&
            typeof entry.id === 'string' &&
            typeof entry.status === 'string'))
        : [];
}
function receiptLines(receipt) {
    if (!receipt)
        return [];
    const lines = [receipt.completed];
    if (receipt.used !== 'none')
        lines.push(`I used ${receipt.used}.`);
    if (receipt.changed !== 'none')
        lines.push(`I changed ${receipt.changed}.`);
    if (receipt.delegated === 'yes') {
        lines.push(`I delegated part of the work; ${receipt.subtasks ?? 'no subtask totals were reported'}.`);
    }
    if (receipt.needsAttention !== 'none') {
        lines.push(`I need your attention: ${receipt.needsAttention}`);
    }
    return lines;
}
function publicProgress(task) {
    const progress = record(task.privateCorrelationJson.progress);
    const steering = Array.isArray(task.privateCorrelationJson.steering)
        ? task.privateCorrelationJson.steering
        : [];
    return {
        currentPhase: stringValue(progress.phase),
        lastProgress: stringValue(progress.lastProgress),
        lastToolSummary: stringValue(progress.lastToolSummary),
        blocker: stringValue(progress.blocker),
        pendingSteeringCount: steering.filter((entry) => record(entry).status === 'pending').length,
        consumedSteeringCount: steering.filter((entry) => record(entry).status === 'consumed').length,
    };
}
function publicInspection(task) {
    if (task.status !== 'running' ||
        (task.kind !== 'async_command' && task.kind !== 'mcp_tool_call')) {
        return {
            heartbeatAt: null,
            elapsedMs: null,
            stdoutTail: null,
            stderrTail: null,
        };
    }
    const progress = record(task.privateCorrelationJson.progress);
    const startedAt = task.startedAt ?? task.createdAt;
    const startedMs = Date.parse(startedAt);
    const endMs = Date.parse(task.terminalAt ?? '') ||
        Date.parse(task.heartbeatAt ?? '') ||
        Date.parse(task.updatedAt) ||
        Date.now();
    const fallbackElapsedMs = Number.isFinite(startedMs) && endMs >= startedMs ? endMs - startedMs : null;
    return {
        heartbeatAt: task.heartbeatAt ?? null,
        elapsedMs: fallbackElapsedMs,
        stdoutTail: task.kind === 'async_command' ? stringValue(progress.stdoutTail) : null,
        stderrTail: task.kind === 'async_command' ? stringValue(progress.stderrTail) : null,
    };
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}
