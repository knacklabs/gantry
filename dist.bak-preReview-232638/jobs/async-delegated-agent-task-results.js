export function activeChildCount(counts) {
    return counts.reduce((total, entry) => ['queued', 'running', 'needs_attention'].includes(entry.status)
        ? total + entry.count
        : total, 0);
}
function statusCount(counts, status) {
    return counts.find((entry) => entry.status === status)?.count ?? 0;
}
export function childTaskResult(counts, terminalChildren) {
    const completed = 1 + statusCount(counts, 'completed');
    const failed = statusCount(counts, 'failed') + statusCount(counts, 'timed_out');
    const cancelled = statusCount(counts, 'cancelled');
    return {
        summary: `${completed} completed, ${failed} failed, ${cancelled} cancelled`,
        hasFailure: failed > 0 || cancelled > 0,
        terminalChildren,
    };
}
