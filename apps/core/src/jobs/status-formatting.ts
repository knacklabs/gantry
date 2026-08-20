import type { Job, JobNotificationView } from '../domain/types.js';
import type { JobToolDenial } from '../domain/events/job-tool-denial.js';
import type { JobRunDiagnostics } from './execution-diagnostics.js';
import { formatDuration } from '../shared/human-format.js';
import { humanizeTechnicalIdentifier } from '../shared/user-visible-messages.js';

const JOB_NOTIFICATION_VIEW_LIMITS = {
  jobName: 120,
  lastAction: 80,
  nextRunAt: 80,
  headline: 160,
  itemLabel: 50,
  itemDetail: 70,
  nextAction: 160,
  fallbackText: 500,
  items: 10,
} as const;

export const JOB_NOTIFICATION_VIEW_MAX_TEXT_LENGTH = 2_300;

// An empty structured result (no headline and no items) carries no meaning, so
// it is dropped and renderers fall back to fallbackText instead of a blank card.
function hasStructuredResultContent(
  result: JobNotificationView['result'],
): result is NonNullable<JobNotificationView['result']> {
  return Boolean(
    result &&
      (result.headline?.trim() ||
        result.items.length > 0 ||
        result.nextAction?.trim()),
  );
}

/**
 * Keeps provider-native job notification cards within their shared message
 * budget before channel renderers add provider-specific markup.
 */
export function boundJobNotificationView(
  view: JobNotificationView,
): JobNotificationView {
  return {
    ...view,
    jobName: truncateJobNotificationText(
      view.jobName,
      JOB_NOTIFICATION_VIEW_LIMITS.jobName,
    ),
    ...(view.stats
      ? {
          stats: {
            ...view.stats,
            ...(view.stats.lastAction
              ? {
                  lastAction: truncateJobNotificationText(
                    view.stats.lastAction,
                    JOB_NOTIFICATION_VIEW_LIMITS.lastAction,
                  ),
                }
              : {}),
          },
        }
      : {}),
    result: hasStructuredResultContent(view.result)
      ? {
          ...view.result,
            ...(view.result.headline
              ? {
                  headline: truncateJobNotificationText(
                    view.result.headline,
                    JOB_NOTIFICATION_VIEW_LIMITS.headline,
                  ),
                }
              : {}),
            items: view.result.items
              .slice(0, JOB_NOTIFICATION_VIEW_LIMITS.items)
              .map((item) => ({
                ...item,
                label: truncateJobNotificationText(
                  item.label,
                  JOB_NOTIFICATION_VIEW_LIMITS.itemLabel,
                ),
                ...(item.detail
                  ? {
                      detail: truncateJobNotificationText(
                        item.detail,
                        JOB_NOTIFICATION_VIEW_LIMITS.itemDetail,
                      ),
                    }
                  : {}),
              })),
            ...(view.result.nextAction
              ? {
                  nextAction: truncateJobNotificationText(
                    view.result.nextAction,
                    JOB_NOTIFICATION_VIEW_LIMITS.nextAction,
                  ),
                }
              : {}),
        }
      : undefined,
    fallbackText: truncateJobNotificationText(
      view.fallbackText,
      JOB_NOTIFICATION_VIEW_LIMITS.fallbackText,
    ),
    ...(view.nextRunAt
      ? {
          nextRunAt: truncateJobNotificationText(
            view.nextRunAt,
            JOB_NOTIFICATION_VIEW_LIMITS.nextRunAt,
          ),
        }
      : {}),
  };
}

function truncateJobNotificationText(value: string, max: number): string {
  if (value.length <= max) return value;
  // Budget in UTF-16 code units (what providers count) but only cut on whole
  // code points, so a surrogate pair (emoji, supplementary chars) is never
  // split into an invalid half that a provider request would reject.
  let truncated = '';
  for (const codePoint of value) {
    if (truncated.length + codePoint.length > max - 3) break;
    truncated += codePoint;
  }
  const sentenceMatch = truncated.match(/^.*[.!?](?=\s)/s);
  const wordMatch = truncated.match(/^.*\s/s);
  const boundary = sentenceMatch
    ? sentenceMatch[0].length
    : wordMatch
      ? wordMatch[0].length
      : truncated.length;
  return `${truncated
    .slice(0, boundary)
    .trimEnd()
    .replace(/[.!?]+$/, '')}...`;
}

export function formatRunStatusMessage(args: {
  job: Job;
  runId: string;
  runShortId?: number | null;
  runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  summary: string;
  nextRun: string | null;
  retryCount: number;
  pauseReason?: string | null;
  durationMs?: number;
  diagnostics?: JobRunDiagnostics;
  degradedReason?: string;
  toolDenial?: JobToolDenial | null;
}): string {
  const denial = args.toolDenial ?? null;
  const displaySummary = selectJobNotificationSummary(args.summary);
  const statusText = statusLabel(
    args.runStatus,
    displaySummary,
    denial,
    Boolean(args.degradedReason),
  );
  const duration =
    args.durationMs === undefined
      ? ''
      : ` · ${formatDuration(args.durationMs)}`;
  const summary = notificationOutcome(displaySummary, args.runStatus, denial);
  const action = notificationAction(args.runStatus, displaySummary, denial);
  const stats = terminalRunStats(args);
  const lines = [
    `**${statusEmoji(statusText)} ${statusText}** · ${args.job.name}${duration}`,
    ...(stats ? [stats] : []),
    summary,
  ];
  if (args.degradedReason) lines.push(`⚠️ Degraded: ${args.degradedReason}`);
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
    case 'Completed with limits':
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
    '## Scoring Summary',
    '# Scoring Summary',
    'Final Job Report',
    'Final Report',
    'Scoring Summary',
    'Score Summary',
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
  status: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  summary: string,
  denial: JobToolDenial | null,
  degraded: boolean,
): string {
  // A completed run that degraded reads as a completion, not a permission
  // plea — the degraded line carries the denial detail.
  if (status === 'completed' && degraded) return 'Completed with limits';
  if (denial) return 'Needs permission';
  if (status === 'paused') return 'Needs permission';
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
  const truncated = normalized.slice(0, max - 3);
  // A sentence boundary is a terminator followed by whitespace. Punctuation
  // inside a token (2.0, file.txt, a URL) is not a boundary, so fall back to the
  // last word boundary, then to a hard cut for a single over-long token.
  const sentenceMatch = truncated.match(/^.*[.!?](?=\s)/s);
  const wordMatch = truncated.match(/^.*\s/s);
  const boundary = sentenceMatch
    ? sentenceMatch[0].length
    : wordMatch
      ? wordMatch[0].length
      : truncated.length;
  return `${truncated
    .slice(0, boundary)
    .trimEnd()
    .replace(/[.!?]+$/, '')}...`;
}

function terminalRunStats(args: {
  runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  durationMs?: number;
  diagnostics?: JobRunDiagnostics;
}): string | null {
  const stats = terminalRunNotificationStats(args);
  if (!stats || args.durationMs === undefined) return null;
  return `${formatDuration(args.durationMs)}, ${stats.toolCount} tool${stats.toolCount === 1 ? '' : 's'}, ${stats.browserUsed ? 'browser used' : 'browser not used'}, last ${stats.lastAction}`;
}

export function terminalRunNotificationStats(args: {
  runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  durationMs?: number;
  diagnostics?: JobRunDiagnostics;
}): JobNotificationView['stats'] | undefined {
  if (
    (args.runStatus !== 'completed' && args.runStatus !== 'failed') ||
    !args.diagnostics ||
    args.durationMs === undefined
  ) {
    return undefined;
  }
  const { diagnostics } = args;
  const toolCount = diagnostics.totalToolCalls;
  const lastAction = diagnostics.lastTool ?? diagnostics.currentTool ?? 'none';
  return {
    toolCount,
    browserUsed: diagnostics.browserActivityCount > 0,
    lastAction,
  };
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
  status: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  denial: JobToolDenial | null,
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
  status: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  summary: string,
  denial: JobToolDenial | null,
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
  status: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered',
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
