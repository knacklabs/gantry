export function schedulerJobStaleness(job, nowMs) {
    if (job.status !== 'active' ||
        job.schedule_type !== 'once' ||
        job.last_run ||
        !job.next_run) {
        return null;
    }
    const nextRunMs = Date.parse(job.next_run);
    if (!Number.isFinite(nextRunMs) || nextRunMs >= nowMs)
        return null;
    return 'missed_window';
}
export function staleOnceRequeueBucket(job, nowMs, throttleMs) {
    return schedulerJobStaleness(job, nowMs) === 'missed_window'
        ? Math.floor(nowMs / throttleMs)
        : null;
}
