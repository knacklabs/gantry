import type { PermissionMemoryListMessageView } from '../../domain/message-actions.js';
import type { MessageActionAffordance } from '../../domain/message-actions.js';
import type { PermissionDecisionMemoryRow } from '../../domain/ports/permission-decision-memory.js';
import { sha256Base64Url } from '../../shared/stable-hash.js';
import { permissionHumanToolLabel } from './permission-card-affordances.js';
import type { HumanDecisionMemoryService } from './human-decision-memory-service.js';
import type { PermissionRepository } from '../../domain/ports/repositories.js';

export const PERMISSION_MEMORY_EMPTY =
  'Nothing remembered yet. Tap Allow on a card and it shows up here.';
export const PERMISSION_MEMORY_NOT_FOUND =
  "Nothing to forget — that isn't one of your remembered decisions, or it's already gone. Send /permissions for the current list.";
export const PERMISSION_MEMORY_AMBIGUOUS =
  'That id matches more than one — send /permissions all and use the longer id.';
export const PERMISSION_MEMORY_ALREADY_FORGOTTEN = 'Already forgotten.';

export type PermissionMemoryUsedBy = {
  jobs: string[];
  more: number;
};

export type UsedByJobReader = (
  recordIds: string[],
) => Promise<Map<string, PermissionMemoryUsedBy>>;

export function createUsedByJobReader(input: {
  appId: string;
  permissions: PermissionRepository;
  listJobs: () => Promise<Array<{ id: string; name?: string; title?: string }>>;
}): UsedByJobReader {
  return async (recordIds) => {
    const rows = await input.permissions.listDecisionsByHumanDecisionRecordId({
      appId: input.appId,
      recordIds,
    });
    const jobIdsByRecordId = new Map<string, string[]>();
    for (const row of rows) {
      const jobIds = jobIdsByRecordId.get(row.recordId) ?? [];
      if (!jobIds.includes(row.jobId)) jobIds.push(row.jobId);
      jobIdsByRecordId.set(row.recordId, jobIds);
    }
    if (!rows.length) return new Map();
    const jobsById = new Map(
      (await input.listJobs()).map((job) => [job.id, job]),
    );
    const result = new Map<string, PermissionMemoryUsedBy>();
    for (const recordId of recordIds) {
      const jobs = (jobIdsByRecordId.get(recordId) ?? []).flatMap((jobId) => {
        const job = jobsById.get(jobId);
        const name = job?.name ?? job?.title;
        return name ? [name] : [];
      });
      if (jobs.length)
        result.set(recordId, {
          jobs: jobs.slice(0, 2),
          more: Math.max(0, jobs.length - 2),
        });
    }
    return result;
  };
}

export async function permissionMemoryCommandResponse(input: {
  command:
    | { kind: 'permissions_show' }
    | { kind: 'permissions_all' }
    | { kind: 'permissions_forget'; prefix: string };
  modeLine: string;
  conversationKind: 'dm' | 'group';
  resolvePersonId: () => Promise<string | undefined>;
  service: HumanDecisionMemoryService;
  appId: string;
  agentFolder: string;
  agentId: string;
  timezone: string;
  usedBy: UsedByJobReader;
}): Promise<{ text: string; actionAffordances?: MessageActionAffordance[] }> {
  if (input.conversationKind !== 'dm') {
    return {
      text: `${input.modeLine}\nRemembered decisions are a DM feature — nothing is remembered in groups. Send /permissions to me directly to see yours.`,
    };
  }
  const personId = await input.resolvePersonId();
  if (!personId)
    return { text: `${input.modeLine}\n${PERMISSION_MEMORY_EMPTY}` };
  const rows = await input.service.list({
    appId: input.appId,
    agentFolder: input.agentFolder,
    actingPersonId: personId,
  });
  if (input.command.kind === 'permissions_forget') {
    const prefix = input.command.prefix.toLowerCase();
    const matches = rows.filter((row) =>
      row.id.toLowerCase().startsWith(prefix),
    );
    if (matches.length !== 1)
      return {
        text: matches.length
          ? PERMISSION_MEMORY_AMBIGUOUS
          : PERMISSION_MEMORY_NOT_FOUND,
      };
    const result = await input.service.revoke({
      appId: input.appId,
      agentFolder: input.agentFolder,
      actingPersonId: personId,
      recordId: matches[0].id,
    });
    return {
      text:
        result === 'applied'
          ? permissionMemoryForgot(permissionMemoryScopeLabel(matches[0]))
          : result === 'already_revoked'
            ? PERMISSION_MEMORY_ALREADY_FORGOTTEN
            : PERMISSION_MEMORY_NOT_FOUND,
    };
  }
  const renderedRows =
    input.command.kind === 'permissions_all' ? rows : rows.slice(0, 10);
  const view = permissionMemoryListView({
    modeLine: input.modeLine,
    rows,
    agentId: input.agentId,
    timezone: input.timezone,
    usedBy: await input.usedBy(renderedRows.map((row) => row.id)),
    all: input.command.kind === 'permissions_all',
  });
  return {
    text: view.text,
    ...(view.affordances.length
      ? {
          actionAffordances: view.affordances.map((action) => ({
            kind: 'memory_forget' as const,
            ...action,
          })),
        }
      : {}),
  };
}

const CATEGORY_NOUNS: Record<string, string> = {
  read_only_command: 'read-only reads',
  file_read: 'file reads',
  virtual_file_read: 'file reads',
  web_search: 'web searches',
  web_read: 'web reads',
};

export function permissionMemoryAgentRouteKey(agentId: string): string {
  return sha256Base64Url(agentId).slice(0, 12);
}

export function resolvePermissionMemoryAgentRouteKey(
  agentRouteKey: string,
  agentIds: Iterable<string>,
): string | undefined {
  const matches = [...agentIds].filter(
    (agentId) => permissionMemoryAgentRouteKey(agentId) === agentRouteKey,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function permissionMemoryScopeNoun(
  row: Pick<PermissionDecisionMemoryRow, 'scope' | 'scopeKey' | 'principal'>,
): string {
  if (row.scope === 'exact') {
    return `${memoryToolLabel(row.principal)}, this exact call`;
  }
  return categoryNoun(scopeCategory(row.scopeKey), row.principal);
}

export function permissionMemoryScopeLabel(
  row: Pick<PermissionDecisionMemoryRow, 'scope' | 'scopeKey' | 'principal'>,
): string {
  return row.scope === 'place'
    ? `only in ${permissionMemoryPlace(row)}`
    : permissionMemoryScopeNoun(row);
}

export function permissionMemoryPlace(
  row: Pick<PermissionDecisionMemoryRow, 'scope' | 'scopeKey'>,
): string {
  if (row.scope !== 'place') return 'anywhere';
  const value = (row.scopeKey ?? '').slice('place:'.length);
  const separator = value.startsWith('tool:')
    ? value.indexOf(':', 'tool:'.length)
    : value.indexOf(':');
  return separator >= 0 ? value.slice(separator + 1) || 'anywhere' : 'anywhere';
}

export function formatPermissionMemoryDate(
  value: string,
  timezone: string,
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).formatToParts(new Date(value));
  return `${parts.find((part) => part.type === 'day')?.value ?? ''} ${parts.find((part) => part.type === 'month')?.value ?? ''}`.trim();
}

export function permissionMemoryListView(input: {
  modeLine: string;
  rows: Array<PermissionDecisionMemoryRow & { shortId: string }>;
  agentId: string;
  timezone: string;
  usedBy?: Map<string, PermissionMemoryUsedBy>;
  all?: boolean;
}): PermissionMemoryListMessageView {
  if (input.rows.length === 0)
    return {
      text: `${input.modeLine}\n${PERMISSION_MEMORY_EMPTY}`,
      affordances: [],
    };
  const shown = input.all ? input.rows : input.rows.slice(0, 10);
  const agentRouteKey = permissionMemoryAgentRouteKey(input.agentId);
  const rows = shown.map((row) =>
    permissionMemoryRow({
      row,
      timezone: input.timezone,
      usedBy: input.usedBy?.get(row.id),
      includeShortId: input.all === true,
    }),
  );
  const older = input.rows.length - shown.length;
  const footer =
    input.all || older === 0
      ? []
      : [
          `Showing the 10 newest with buttons. ${older} older.`,
          'Send /permissions all for the full list, or /permissions forget <id>.',
        ];
  return {
    text: [input.modeLine, ...rows, ...footer].join('\n'),
    affordances: input.all
      ? []
      : shown.map((row) => ({
          recordId: row.id,
          agentRouteKey,
          label: `Forget ${row.shortId}`,
        })),
  };
}

export function permissionMemoryForgot(scope: string): string {
  return `Forgot: ${scope}. I'll ask next time.`;
}

function permissionMemoryRow(input: {
  row: PermissionDecisionMemoryRow & { shortId: string };
  timezone: string;
  usedBy?: PermissionMemoryUsedBy;
  includeShortId: boolean;
}): string {
  const fields = [
    ...(input.includeShortId ? [input.row.shortId] : []),
    input.row.outcome === 'deny' ? 'No' : 'Allow',
    permissionMemoryScopeNoun(input.row),
    permissionMemoryPlace(input.row),
    formatPermissionMemoryDate(input.row.createdAt, input.timezone),
    input.row.actingPersonLabel?.trim() || 'someone',
  ];
  const usedBy = input.usedBy;
  if (usedBy && (usedBy.jobs.length > 0 || usedBy.more > 0)) {
    fields.push(
      `used by job ${usedBy.jobs.join(', ')}${usedBy.more > 0 ? `${usedBy.jobs.length > 0 ? ', ' : ''}+${usedBy.more} jobs` : ''}`,
    );
  }
  return fields.join(' · ');
}

function scopeCategory(scopeKey: string | undefined): string | undefined {
  if (!scopeKey) return undefined;
  const value = scopeKey.replace(/^(kind|place):/, '');
  return value.split(':')[0];
}

function categoryNoun(
  category: string | undefined,
  principal?: string,
): string {
  if (category === 'tool') return `${memoryToolLabel(principal)} actions`;
  return CATEGORY_NOUNS[category ?? ''] ?? 'this kind of action';
}

function memoryToolLabel(toolName: string | undefined): string {
  return (
    (toolName === 'Bash' || toolName === 'RunCommand' ? 'Bash' : undefined) ??
    permissionHumanToolLabel(toolName) ??
    toolName?.trim() ??
    'Tool'
  );
}
