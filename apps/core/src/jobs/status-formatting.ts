import type { Job } from '../domain/types.js';
import {
  parseAutonomousToolDenial,
  type AutonomousToolDenial,
} from '../shared/autonomous-tool-denial.js';
import { formatDuration } from '../shared/human-format.js';
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
  const duration =
    args.durationMs === undefined
      ? ''
      : ` · ${formatDuration(args.durationMs)}`;
  const summary = notificationOutcome(displaySummary, args.runStatus, denial);
  const action = notificationAction(args.runStatus, displaySummary, denial);
  const lines = [
    `**${statusEmoji(statusText)} ${statusText}** · ${args.job.name}${duration}`,
    summary,
  ];
  // A "Completed with issues" header must carry its blocker even when the
  // compacted summary truncates it away.
  const attention = hasMeaningfulReceiptValue(action)
    ? action
    : statusText === 'Completed with issues'
      ? realNeedsAttention(displaySummary)
      : null;
  if (hasMeaningfulReceiptValue(attention)) lines.push(attention);
  const next = nextRunLabel(args.nextRun, args.runStatus);
  if (next) lines.push(next);
  return lines.join('\n');
}

function statusEmoji(statusText: string): string {
  switch (statusText) {
    case 'Completed':
    case 'Completed, no report':
      return '✅';
    case 'Completed with issues':
      return '⚠️';
    case 'Needs permission':
      return '🔐';
    case 'Needs memory review':
      return '📝';
    case 'Timed out':
      return '⏱️';
    case 'Interrupted':
    case 'Paused after failures':
      return '⏸️';
    default:
      return '❌';
  }
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
  return stripTrailingEmptyReceiptLines(selected).trim() || summary;
}

function statusLabel(
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  summary: string,
  denial: AutonomousToolDenial | null,
): string {
  if (denial) return 'Needs permission';
  if (status === 'completed') {
    if (realNeedsAttention(summary)) return 'Completed with issues';
    if (hasPendingMemoryReviewSummary(summary)) return 'Needs memory review';
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
  return (
    trimmed
      .replace(/^#+\s*/gm, '')
      .replace(/^Final Job Report\s*$/gim, '')
      // Normalize markup FIRST so labeled lines wrapped in emphasis or list
      // markers ("- **Needs attention:** X") are still recognized below.
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '')
      // Needs-attention content is re-carried on its own line by
      // realNeedsAttention - drop the whole line here to avoid duplicates.
      .replace(/^Needs attention:.*$/gim, '')
      // Tool/delegation lists are details-on-request in the new voice.
      .replace(/^(?:Used|Delegated):.*$/gim, '')
      // Change summaries carry meaning - keep them, but as plain prose.
      .replace(/^Changed:\s*(?:none\s*)?$/gim, '')
      .replace(/^Changed:\s*/gim, 'Updated ')
      .replace(/^Completed:\s*/gim, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:])/g, '$1')
      .trim()
  );
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
  if (status === 'completed') {
    return hasReportableSummary(summary)
      ? compactSummary(summary, 360)
      : 'I finished the job, but it had no reportable output.';
  }
  if (status === 'timeout') {
    return "I couldn't finish before the job's time limit.";
  }
  if (status === 'dead_lettered') {
    return 'I paused this job after repeated failures.';
  }
  // A failed run's summary is often the raw runner error, and humanizeSummary
  // only presentation-cleans it - it is NOT safe for chat. The raw reason
  // stays in logs/runtime events; the notification carries the plain outcome
  // plus the recovery action line.
  return "I couldn't finish this job.";
}

function notificationAction(
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  summary: string,
  denial: AutonomousToolDenial | null,
): string | null {
  if (denial) {
    if (denial.toolName.startsWith('mcp__gantry__browser_')) {
      return 'Browser access needs approval.';
    }
    return 'Approve the missing access, then retry the job.';
  }
  if (hasPendingMemoryReviewSummary(summary)) {
    const count = pendingMemoryReviewCount(summary);
    return count
      ? `${count} memory changes need your review.`
      : 'Memory changes need your review.';
  }
  if (status === 'timeout' && isRestartInterruptedRun(summary)) {
    return 'Rerun the job when ready. If this repeats without restarts, increase the job timeout.';
  }
  if (status === 'timeout') {
    return 'Rerun with a longer job timeout if this work is expected to take more time.';
  }
  if (status === 'dead_lettered') {
    return 'Fix the blocker, then resume the job.';
  }
  if (status === 'failed') {
    return 'Ask me to retry once the underlying issue is addressed.';
  }
  return null;
}

function isRestartInterruptedRun(summary: string): boolean {
  return /runtime restarted|gantry restarted/i.test(summary);
}

function hasPendingMemoryReviewSummary(summary: string): boolean {
  return (
    /\b\d+\s+sent to review\b/i.test(summary) ||
    /\b\d+\s+(?:pending\s+)?memory reviews?\s+(?:are\s+)?(?:waiting|pending|needs? review)\b/i.test(
      summary,
    )
  );
}

function pendingMemoryReviewCount(summary: string): number | null {
  const match =
    summary.match(/\b(\d+)\s+sent to review\b/i) ||
    summary.match(/\b(\d+)\s+(?:pending\s+)?memory reviews?\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nextRunLabel(
  nextRun: string | null,
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
): string | null {
  const formattedNextRun = nextRun ? formatNextRun(nextRun) : null;
  if (formattedNextRun) return `Runs again ${formattedNextRun}.`;
  if (status === 'completed') return null;
  return 'Stopped until the job is fixed or rerun.';
}

function formatNextRun(nextRun: string): string | null {
  const date = new Date(nextRun);
  if (Number.isNaN(date.getTime())) return null;
  return `at ${new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)}`;
}

function stripTrailingEmptyReceiptLines(summary: string): string {
  const lines = summary.split('\n');
  const emptyReceipt =
    /^(?:Used:\s*none(?: reported)?|Changed:\s*none|Delegated:\s*no|Needs attention:\s*(?:none|no|n[/-]a))\.?$/i;
  while (lines.length) {
    const tail = lines.at(-1)?.trim() ?? '';
    if (tail !== '' && !emptyReceipt.test(tail)) break;
    lines.pop();
  }
  return lines.join('\n');
}

function realNeedsAttention(summary: string): string | null {
  for (const match of summary.matchAll(/^Needs attention:\s*(.*?)\s*$/gim)) {
    if (hasMeaningfulReceiptValue(match[1])) return match[1]!.trim();
  }
  return null;
}

function hasMeaningfulReceiptValue(
  value: string | null | undefined,
): value is string {
  return (
    Boolean(value?.trim()) && !/^(?:none|no|n[/-]a)\.?$/i.test(value!.trim())
  );
}

function hasReportableSummary(summary: string): boolean {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  return Boolean(normalized) && normalized.toLowerCase() !== 'completed';
}
