export function schedulerJobSummary(job: unknown): string {
  const record =
    typeof job === 'object' && job !== null ? (job as Record<string, any>) : {};
  const visibility =
    typeof record.visibility === 'object' && record.visibility !== null
      ? (record.visibility as Record<string, any>)
      : {};
  const target =
    typeof visibility.target === 'object' && visibility.target !== null
      ? (visibility.target as Record<string, any>)
      : {};
  const recentErrors = Array.isArray(visibility.recentRunErrors)
    ? visibility.recentRunErrors.length
    : 0;
  const staleness =
    typeof visibility.staleness === 'string' ? visibility.staleness : 'none';
  return [
    `Job: ${String(record.name ?? record.id ?? 'unknown')}`,
    `Target: ${String(target.agentId ?? record.group_scope ?? 'unknown')} in ${String(target.conversationJids?.[0] ?? 'no conversation')}`,
    `Kind/status: ${String(record.schedule_type ?? 'unknown')} / ${String(record.status ?? 'unknown')}`,
    `Next/last run: ${String(record.next_run ?? 'none')} / ${String(record.last_run ?? 'none')}`,
    `Staleness: ${staleness}`,
    `Tools: inherited ${Array.isArray(visibility.inheritedTools) ? visibility.inheritedTools.length : 0}, job extra ${Array.isArray(visibility.jobExtraTools) ? visibility.jobExtraTools.length : 0}, effective ${Array.isArray(visibility.effectiveAllowedTools) ? visibility.effectiveAllowedTools.length : 0}`,
    `Recent run errors: ${recentErrors}`,
    '',
    'Structured JSON:',
    JSON.stringify(record, null, 2),
  ].join('\n');
}

export function schedulerJobsSummary(jobs: unknown[]): string {
  const lines = jobs.map((job) => {
    const record =
      typeof job === 'object' && job !== null
        ? (job as Record<string, any>)
        : {};
    const visibility =
      typeof record.visibility === 'object' && record.visibility !== null
        ? (record.visibility as Record<string, any>)
        : {};
    const target =
      typeof visibility.target === 'object' && visibility.target !== null
        ? (visibility.target as Record<string, any>)
        : {};
    return `- ${String(record.id ?? 'unknown')} | ${String(record.name ?? '')} | ${String(record.schedule_type ?? '')} | ${String(record.status ?? '')} | ${String(target.agentId ?? record.group_scope ?? '')}`;
  });
  return [
    `Scheduler jobs (${jobs.length})`,
    ...lines,
    '',
    'Structured JSON:',
    JSON.stringify(jobs, null, 2),
  ].join('\n');
}
