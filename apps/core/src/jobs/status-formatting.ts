import type { Job } from '../domain/types.js';
import {
  parseAutonomousToolDenial,
  type AutonomousToolDenial,
} from '../shared/autonomous-tool-denial.js';
import { formatDuration, formatRunLabel } from '../shared/human-format.js';
import { humanizeTechnicalIdentifier } from '../shared/user-visible-messages.js';

export function formatRunStatusMessage(args: {
  job: Job;
  runId: string;
  runShortId?: number | null;
  runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason?: string | null;
  durationMs?: number;
}): string {
  const denial = parseAutonomousToolDenial(args.summary);
  const displaySummary = selectJobNotificationSummary(args.summary);
  const statusText = statusLabel(args.runStatus, displaySummary, denial);
  const runLabel = formatRunLabel({
    id: args.runId,
    shortId: args.runShortId,
  });
  const duration =
    args.durationMs === undefined ? '' : `, ${formatDuration(args.durationMs)}`;
  const summary = notificationOutcome(displaySummary, args.runStatus, denial);
  const lines = [
    `${statusText}: ${args.job.name} (${runLabel}${duration})`,
    `Outcome: ${summary}`,
  ];
  const action = notificationAction(
    args.runStatus,
    displaySummary,
    denial,
    args.pauseReason,
  );
  if (action) lines.push(`Action: ${action}`);
  lines.push(`Next: ${nextRunLabel(args.nextRun, args.runStatus)}`);
  return lines.join('\n');
}

export function selectJobNotificationSummary(summary: string): string {
  const normalized = summary.replace(
    /^\[output truncated; showing tail\]\s*/i,
    '',
  );
  const markers = [
    '## Final Job Report',
    '# Final Job Report',
    'Final Job Report',
    'Final Report',
  ];
  const lower = normalized.toLowerCase();
  let markerIndex = -1;
  for (const marker of markers) {
    const index = lower.lastIndexOf(marker.toLowerCase());
    if (index > markerIndex) markerIndex = index;
  }
  const selected =
    markerIndex >= 0 ? normalized.slice(markerIndex) : normalized;
  return selected.trim() || summary;
}

function statusLabel(
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  summary: string,
  denial: AutonomousToolDenial | null,
): string {
  if (denial) return 'Needs permission';
  if (status === 'completed') {
    return hasReportableSummary(summary) ? 'Completed' : 'Completed, no report';
  }
  if (status === 'timeout' && isRestartInterruptedRun(summary)) {
    return 'Interrupted';
  }
  if (status === 'timeout') return 'Timed out';
  if (status === 'dead_lettered') return 'Paused after failures';
  return 'Failed';
}

function compactSummary(summary: string, max = 180): string {
  const normalized = humanizeSummary(summary);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function humanizeSummary(summary: string): string {
  const trimmed = stripDiagnosticSuffix(summary).trim();
  if (!trimmed) return '';
  const jsonOutcome = humanizeJsonSummary(trimmed);
  if (jsonOutcome) return jsonOutcome;
  return trimmed
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function stripDiagnosticSuffix(summary: string): string {
  return summary.replace(/\nDiagnostics:[\s\S]*$/i, '');
}

function humanizeJsonSummary(summary: string): string | null {
  if (!summary.startsWith('{') && !summary.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length === 0
        ? 'Job returned no items.'
        : `Job returned ${parsed.length} item${parsed.length === 1 ? '' : 's'}.`;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      'queued' in record &&
      'pending' in record &&
      'deduped' in record &&
      Object.keys(record).every((key) =>
        ['queued', 'pending', 'deduped'].includes(key),
      )
    ) {
      return record.deduped
        ? 'Memory maintenance was already running for this conversation.'
        : 'Memory maintenance completed.';
    }
    const usefulEntries = Object.entries(record).filter(
      ([, value]) =>
        value !== null &&
        value !== undefined &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'),
    );
    if (usefulEntries.length === 0) return null;
    return usefulEntries
      .slice(0, 6)
      .map(([key, value]) => `${labelFromKey(key)}: ${String(value)}`)
      .join(', ');
  } catch {
    return null;
  }
}

function labelFromKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function notificationOutcome(
  summary: string,
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  denial: AutonomousToolDenial | null,
): string {
  if (denial) {
    if (denial.toolName.startsWith('mcp__gantry__browser_')) {
      return 'Could not use the browser for this job.';
    }
    return `Missing ${humanizeTechnicalIdentifier(denial.toolName)} access for this job.`;
  }
  if (status === 'timeout' && isRestartInterruptedRun(summary)) {
    return 'Gantry restarted while this job was running, so the run could not finish.';
  }
  if (hasReportableSummary(summary)) return compactSummary(summary, 360);
  if (status === 'completed') return 'Completed, no reportable output.';
  if (status === 'timeout') {
    return 'The job exceeded its configured runtime budget.';
  }
  return 'The job did not finish successfully.';
}

function notificationAction(
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  summary: string,
  denial: AutonomousToolDenial | null,
  pauseReason?: string | null,
): string | null {
  if (denial) {
    if (denial.toolName.startsWith('mcp__gantry__browser_')) {
      return 'Browser access needs approval.';
    }
    return 'Approve the missing access, then retry the job.';
  }
  if (status === 'timeout' && isRestartInterruptedRun(summary)) {
    return 'Rerun the job when ready. If this repeats without restarts, increase the job timeout.';
  }
  if (status === 'timeout') {
    return 'Rerun with a longer job timeout if this work is expected to take more time.';
  }
  if (status === 'completed' && hasPendingMemoryReviewSummary(summary)) {
    return 'Review pending memory candidates with memory_review_pending.';
  }
  if (status === 'dead_lettered') {
    return pauseReason
      ? compactSummary(pauseReason, 160)
      : 'Fix the blocker, then resume the job.';
  }
  return null;
}

function isRestartInterruptedRun(summary: string): boolean {
  return /runtime restarted|gantry restarted/i.test(summary);
}

function hasPendingMemoryReviewSummary(summary: string): boolean {
  return /\b\d+\s+sent to review\b/i.test(summary);
}

function nextRunLabel(
  nextRun: string | null,
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
): string {
  if (nextRun) return `Runs again ${formatNextRun(nextRun)}.`;
  if (status === 'completed') return 'No next run.';
  return 'Stopped until the job is fixed or rerun.';
}

function formatNextRun(nextRun: string): string {
  const date = new Date(nextRun);
  if (Number.isNaN(date.getTime())) return 'after the schedule is repaired';
  return `at ${new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)}`;
}

function hasReportableSummary(summary: string): boolean {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  return Boolean(normalized) && normalized.toLowerCase() !== 'completed';
}
