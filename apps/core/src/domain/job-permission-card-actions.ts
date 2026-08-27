import type { JobPermissionCardRevision } from './ports/job-permission-durability.js';

export interface JobPermissionCardAction {
  token: string;
  label: string;
}

export type ParsedJobPermissionCardAction = {
  callbackKey: string;
  revision: number;
  rowIndex: number | null;
  decision: 'allow' | 'deny' | 'reconsider' | 'show' | 'next';
};

const ACTION_PATTERN = /^jp:([a-f0-9]{24}):([a-z0-9]+):([a-z0-9]+):([adrsn])$/;

export function jobPermissionCardActions(
  callbackKey: string,
  revision: JobPermissionCardRevision,
): JobPermissionCardAction[] {
  return revision.rows.length > 0
    ? [
        {
          token: actionToken(callbackKey, revision.revision, null, 'allow'),
          label: 'Allow',
        },
        {
          token: actionToken(callbackKey, revision.revision, null, 'deny'),
          label: 'Deny',
        },
      ]
    : [];
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
            : match[4] === 's'
              ? 'show'
              : 'next',
  };
}

export function jobPermissionCardText(
  jobId: string,
  revision: JobPermissionCardRevision,
): string {
  if (revision.operation === 'retire') {
    return `Permission requests for job ${jobId} are settled.`;
  }
  const rows = revision.rows.map((row) => {
    const scopes = row.visibleGrantAtoms
      .map((atom) => /\((.*)\)$/.exec(atom)?.[1] ?? atom)
      .join('; ');
    return `${jobPermissionToolLabel(row)}: ${scopes}`;
  });
  const hidden = revision.hiddenRowCount
    ? `\n${revision.hiddenRowCount} more permission request(s) need review.`
    : '';
  return `Permissions needed for this job\n${rows.join('\n')}${hidden}`;
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
          : decision === 'show'
            ? 's'
            : 'n';
  return `jp:${callbackKey}:${revision.toString(36)}:${rowIndex === null ? 'x' : rowIndex.toString(36)}:${code}`;
}

function jobPermissionToolLabel(
  row: JobPermissionCardRevision['rows'][number],
): string {
  const toolNames = [
    ...new Set(
      row.visibleGrantAtoms
        .map((atom) => /^([A-Za-z][A-Za-z0-9_]*)\(/.exec(atom)?.[1])
        .filter((name): name is string => Boolean(name))
        .map((name) => name.replace(/([a-z])([A-Z])/g, '$1 $2')),
    ),
  ];
  return toolNames.length > 0 ? toolNames.join(' and ') : 'access';
}
