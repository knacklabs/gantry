import type { Job } from '../domain/types.js';

export function formatRunStatusMessage(args: {
  job: Job;
  runId: string;
  runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason?: string | null;
}): string {
  const statusText = statusLabel(args.runStatus);
  const runSuffix = args.runId.slice(0, 8);
  const summary = compactSummary(args.summary);
  if (args.runStatus === 'completed') {
    return `Scheduler ${statusText}: ${args.job.name} (#${runSuffix}) • next=${args.nextRun || 'none'} • ${summary}`;
  }
  const retryState = args.nextRun ? 'scheduled' : 'stopped';
  const pauseState = args.runStatus === 'dead_lettered' ? 'paused' : 'active';
  const pauseReason = args.pauseReason
    ? ` • pause=${compactSummary(args.pauseReason, 120)}`
    : '';
  return `Scheduler ${statusText}: ${args.job.name} (#${runSuffix}) • retry=${args.retryCount} (${retryState}) • state=${pauseState}${pauseReason} • ${summary}`;
}

function statusLabel(
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
): string {
  if (status === 'completed') return 'completed';
  if (status === 'timeout') return 'timed out';
  if (status === 'dead_lettered') return 'dead-lettered';
  return 'failed';
}

function compactSummary(summary: string, max = 180): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}
