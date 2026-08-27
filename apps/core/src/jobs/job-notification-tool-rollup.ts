import type { JobNotificationView } from '../domain/types.js';
import type { RuntimeEvent } from '../domain/events/events.js';
import { parseJobToolDeniedEvent } from '../domain/events/job-tool-denial.js';
import { parseTerminalToolActivity } from '../domain/events/tool-activity.js';
import { humanizeTechnicalIdentifier } from '../shared/user-visible-messages.js';

export const JOB_NOTIFICATION_VIEW_LIMITS = {
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

type RecordedJobAction = Pick<
  RuntimeEvent,
  'eventType' | 'correlationId' | 'payload'
>;

interface RecordedToolResult {
  invocationId: string;
  key: string;
  label: string;
  outcome: 'done' | 'failed';
  detail?: string;
  seq?: number;
  precedence: number;
}

export function structuredJobResultFromRecordedActions(
  actions: readonly RecordedJobAction[],
): JobNotificationView['result'] {
  const results = actions.flatMap((event): RecordedToolResult[] => {
    const denial = parseJobToolDeniedEvent(event);
    if (denial?.invocationId) {
      return [
        {
          invocationId: denial.invocationId,
          key: `denial:${denial.toolName}`,
          label: `Could not use ${humanizeTechnicalIdentifier(denial.toolName)}`,
          outcome: 'failed',
          detail: denial.reason,
          precedence: 2,
        },
      ];
    }
    const activity = parseTerminalToolActivity(event);
    if (!activity) return [];
    return [
      {
        invocationId: activity.invocationId,
        key: `${activity.family}:${activity.tool}`,
        label:
          activity.family === 'browser'
            ? `Browser: ${humanizeTechnicalIdentifier(
                activity.tool.replace(/^browser[._-]/, ''),
              )}`
            : activity.family === 'capability'
              ? `Capability: ${humanizeTechnicalIdentifier(activity.tool)}`
              : humanizeTechnicalIdentifier(activity.tool),
        outcome: activity.outcome === 'success' ? 'done' : 'failed',
        ...(activity.detail ? { detail: activity.detail } : {}),
        ...(activity.seq !== undefined ? { seq: activity.seq } : {}),
        precedence: activity.authoritative ? 1 : 0,
      },
    ];
  });
  const byInvocation = new Map<string, RecordedToolResult>();
  for (const result of results) {
    const current = byInvocation.get(result.invocationId);
    const selected =
      !current || compareRecordedToolResult(result, current) < 0
        ? result
        : current;
    const seq = minimumSequence(current?.seq, result.seq);
    byInvocation.set(result.invocationId, {
      ...selected,
      ...(seq !== undefined ? { seq } : {}),
    });
  }
  const grouped = new Map<
    string,
    {
      key: string;
      label: string;
      outcome: RecordedToolResult['outcome'];
      count: number;
      firstSeq?: number;
      details: string[];
    }
  >();
  for (const result of byInvocation.values()) {
    if (
      result.key.startsWith('browser:') ||
      result.key.startsWith('capability:')
    ) {
      if (result.precedence === 0) continue;
    }
    const groupKey = `${result.key}\u0000${result.outcome}`;
    const group = grouped.get(groupKey) ?? {
      key: result.key,
      label: result.label,
      outcome: result.outcome,
      count: 0,
      details: [],
    };
    group.count += 1;
    group.firstSeq = minimumSequence(group.firstSeq, result.seq);
    if (result.detail) group.details.push(result.detail);
    grouped.set(groupKey, group);
  }
  for (const family of ['browser', 'capability'] as const) {
    const failures = results.filter(
      (result) =>
        result.key.startsWith(`${family}:`) && result.outcome === 'failed',
    );
    const wrapperFailures = failures.filter(
      (result) => result.precedence === 0,
    );
    const authoritativeFailures = failures.filter(
      (result) => result.precedence === 1,
    );
    const remainder = Math.max(
      0,
      wrapperFailures.length - authoritativeFailures.length,
    );
    if (remainder === 0) continue;
    const key = `${family}:pre-dispatch`;
    grouped.set(`${key}\u0000failed`, {
      key,
      label:
        family === 'browser'
          ? 'Browser: no reply in time'
          : 'Capability: failed before dispatch',
      outcome: 'failed',
      count: remainder,
      // Residual wrapper failures follow the family's concrete failures.
      firstSeq: wrapperFailures.reduce<number | undefined>(
        (maximum, { seq }) =>
          seq === undefined ? maximum : Math.max(maximum ?? seq, seq),
        undefined,
      ),
      details: [],
    });
  }
  const groups = [...grouped.values()].sort((left, right) => {
    if (left.outcome !== right.outcome) {
      return left.outcome === 'failed' ? -1 : 1;
    }
    const sequenceOrder = compareOptionalSequence(
      left.firstSeq,
      right.firstSeq,
    );
    return sequenceOrder || compareText(left.key, right.key);
  });
  if (groups.length === 0) return undefined;
  const visibleLimit =
    groups.length > JOB_NOTIFICATION_VIEW_LIMITS.items
      ? JOB_NOTIFICATION_VIEW_LIMITS.items - 1
      : JOB_NOTIFICATION_VIEW_LIMITS.items;
  const visibleGroups = groups.slice(0, visibleLimit);
  const items = visibleGroups.map((group) => ({
    outcome: group.outcome,
    label: `${group.label}${group.count > 1 ? ` ×${group.count}` : ''}`,
    ...(group.count === 1 && group.details.length > 0
      ? { detail: [...group.details].sort(compareText)[0] }
      : {}),
  }));
  if (groups.length > visibleGroups.length) {
    const overflow = groups.slice(visibleGroups.length);
    items.push({
      outcome: overflow.some((group) => group.outcome === 'failed')
        ? 'failed'
        : 'done',
      label: `+${overflow.length} more`,
    });
  }
  return { items };
}

function compareRecordedToolResult(
  left: RecordedToolResult,
  right: RecordedToolResult,
): number {
  if (left.precedence !== right.precedence) {
    return right.precedence - left.precedence;
  }
  if (left.outcome !== right.outcome) return left.outcome === 'failed' ? -1 : 1;
  return (
    compareText(left.key, right.key) ||
    compareText(left.detail ?? '', right.detail ?? '')
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function minimumSequence(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function compareOptionalSequence(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return left - right;
}
