import type { JobPermissionCardRevision } from './ports/job-permission-durability.js';

export interface JobPermissionCardAction {
  token: string;
  label: string;
}

export type ParsedJobPermissionCardAction = {
  callbackKey: string;
  revision: number;
  rowIndex: number | null;
  decision: 'allow' | 'deny' | 'reconsider' | 'show';
};

const ACTION_PATTERN = /^jp:([a-f0-9]{24}):([a-z0-9]+):([a-z0-9]+):([adrs])$/;

export function jobPermissionCardActions(
  callbackKey: string,
  revision: JobPermissionCardRevision,
): JobPermissionCardAction[] {
  const actions: JobPermissionCardAction[] = [];
  if (revision.batchNeedIds.length > 1) {
    actions.push({
      token: actionToken(callbackKey, revision.revision, null, 'allow'),
      label: 'Allow all pending',
    });
  }
  revision.rows.forEach((row, index) => {
    if (row.actionEnabled) {
      actions.push({
        token: actionToken(
          callbackKey,
          revision.revision,
          index,
          row.action === 'reconsider'
            ? 'reconsider'
            : row.action === 'show_scope'
              ? 'show'
              : 'allow',
        ),
        label:
          row.action === 'approve_and_run_again'
            ? `Approve and run again: ${row.displayLabel}`
            : row.action === 'reconsider'
              ? `Reconsider: ${row.displayLabel}`
              : row.action === 'show_scope'
                ? `Show full scope: ${row.displayLabel}`
              : `Allow: ${row.displayLabel}`,
      });
    }
    if (row.denyEnabled) {
      actions.push({
        token: actionToken(callbackKey, revision.revision, index, 'deny'),
        label: `Deny: ${row.displayLabel}`,
      });
    }
  });
  return actions;
}

export function parseJobPermissionCardAction(
  token: string,
): ParsedJobPermissionCardAction | null {
  const match = ACTION_PATTERN.exec(token);
  if (!match) return null;
  const revision = Number.parseInt(match[2]!, 36);
  const rowIndex = match[3] === 'x' ? null : Number.parseInt(match[3]!, 36);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (rowIndex !== null && (!Number.isSafeInteger(rowIndex) || rowIndex < 0))
  ) {
    return null;
  }
  return {
    callbackKey: match[1]!,
    revision,
    rowIndex,
    decision:
      match[4] === 'a'
        ? 'allow'
        : match[4] === 'd'
          ? 'deny'
          : match[4] === 'r'
            ? 'reconsider'
            : 'show',
  };
}

function actionToken(
  callbackKey: string,
  revision: number,
  rowIndex: number | null,
  decision: ParsedJobPermissionCardAction['decision'],
): string {
  const code =
    decision === 'allow'
      ? 'a'
      : decision === 'deny'
        ? 'd'
        : decision === 'reconsider'
          ? 'r'
          : 's';
  return `jp:${callbackKey}:${revision.toString(36)}:${rowIndex === null ? 'x' : rowIndex.toString(36)}:${code}`;
}
