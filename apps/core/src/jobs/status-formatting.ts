import type { Job } from '../domain/types.js';
import {
  parseAutonomousToolDenial,
  type AutonomousToolDenial,
} from '../shared/autonomous-tool-denial.js';
import { formatDuration, formatRunLabel } from '../shared/human-format.js';

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
  const statusText = statusLabel(args.runStatus, args.summary, denial);
  const runLabel = formatRunLabel({
    id: args.runId,
    shortId: args.runShortId,
  });
  const duration =
    args.durationMs === undefined ? '' : `, ${formatDuration(args.durationMs)}`;
  const summary = notificationOutcome(args.summary, args.runStatus, denial);
  const lines = [
    `${statusText}: ${args.job.name} (${runLabel}${duration})`,
    `Outcome: ${summary}`,
  ];
  const action = notificationAction(args.runStatus, denial, args.pauseReason);
  if (action) lines.push(`Action: ${action}`);
  lines.push(`Next: ${nextRunLabel(args.nextRun, args.runStatus)}`);
  return lines.join('\n');
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
  if (status === 'timeout') return 'Timed out';
  if (status === 'dead_lettered') return 'Paused after failures';
  return 'Failed';
}

function compactSummary(summary: string, max = 180): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function notificationOutcome(
  summary: string,
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  denial: AutonomousToolDenial | null,
): string {
  if (denial) {
    if (denial.toolName.startsWith('mcp__myclaw__browser_')) {
      return 'Could not use the browser for this job.';
    }
    return `Missing ${denial.toolName} access for this job.`;
  }
  if (hasReportableSummary(summary)) return compactSummary(summary, 360);
  if (status === 'completed') return 'Completed, no reportable output.';
  if (status === 'timeout') return 'The job exceeded its timeout.';
  return 'The job did not finish successfully.';
}

function notificationAction(
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
  denial: AutonomousToolDenial | null,
  pauseReason?: string | null,
): string | null {
  if (denial) {
    if (denial.toolName.startsWith('mcp__myclaw__browser_')) {
      return 'Browser access needs approval.';
    }
    return 'The agent can update this job permission and rerun it.';
  }
  if (status === 'timeout') {
    return 'Narrow the job scope or increase the timeout before rerunning.';
  }
  if (status === 'dead_lettered') {
    return pauseReason
      ? compactSummary(pauseReason, 160)
      : 'Fix the blocker, then resume the job.';
  }
  return null;
}

function nextRunLabel(
  nextRun: string | null,
  status: 'completed' | 'failed' | 'timeout' | 'dead_lettered',
): string {
  if (nextRun) return `Runs again at ${nextRun}.`;
  if (status === 'completed') return 'No next run.';
  return 'Stopped until the job is fixed or rerun.';
}

function hasReportableSummary(summary: string): boolean {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  return Boolean(normalized) && normalized.toLowerCase() !== 'completed';
}
