export const DEFAULT_JOB_CLEANUP_AFTER_MS = 86_400_000;
export function normalizeCleanupAfterMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_JOB_CLEANUP_AFTER_MS;
    }
    return Math.max(0, Math.round(value));
}
export async function sweepCompletedOneTimeJobs(deps) {
    const removed = await deps.opsRepository.deleteExpiredCompletedOneTimeJobs();
    return removed > 0;
}
