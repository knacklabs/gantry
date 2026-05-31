import { createHash } from 'node:crypto';

import { and, eq, type SQL } from 'drizzle-orm';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type {
  MemoryBoundaryContext,
  MemorySubjectType,
  NormalizedMemorySubject,
} from './memory-types.js';

export const DEFAULT_MEMORY_APP_ID = 'default';

export function memoryAgentIdForWorkspaceFolder(
  workspaceFolder: string,
): string {
  return workspaceFolder.startsWith('agent:')
    ? workspaceFolder
    : `agent:${workspaceFolder}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function subjectIdFor(subject: NormalizedMemorySubject): string {
  return `msu_${hashText(`${subject.appId}:${subject.agentId}:${subject.subjectType}:${subject.subjectId}`).slice(0, 32)}`;
}

const DEFAULT_GROUP_ID = 'default';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function normalizeId(value: string | undefined, fallback: string): string {
  const next = value?.trim() || fallback;
  if (!ID_PATTERN.test(next)) {
    throw new Error(
      `Invalid memory id "${next}". Use letters, numbers, dot, underscore, colon, at, or dash.`,
    );
  }
  return next;
}

function normalizeRequiredId(value: string | undefined, label: string): string {
  const next = value?.trim();
  if (!next) {
    throw new Error(`memory subject requires ${label}`);
  }
  return normalizeId(next, next);
}

export function normalizeSubject(
  input: Partial<MemoryBoundaryContext> & {
    subjectType?: MemorySubjectType;
    subjectId?: string;
    visibility?: MemorySubjectType;
  },
): NormalizedMemorySubject {
  const appId = normalizeId(input.appId, DEFAULT_MEMORY_APP_ID);
  const agentId = normalizeRequiredId(input.agentId, 'agentId');
  const userId = input.userId?.trim() || undefined;
  const groupId = input.groupId?.trim() || undefined;
  const channelId = input.channelId?.trim() || undefined;
  const subjectType =
    input.subjectType ||
    input.visibility ||
    (channelId ? 'channel' : groupId ? 'group' : userId ? 'user' : 'group');
  const subjectId =
    input.subjectId?.trim() ||
    (subjectType === 'common'
      ? 'common'
      : subjectType === 'channel'
        ? channelId
        : subjectType === 'group'
          ? groupId
          : userId) ||
    DEFAULT_GROUP_ID;
  return {
    appId,
    agentId,
    subjectType,
    subjectId: normalizeId(subjectId, DEFAULT_GROUP_ID),
    ...(userId ? { userId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(channelId ? { channelId } : {}),
  };
}

function subjectFilterSql(
  i: typeof pgSchema.memoryItemsPostgres,
  subject: Pick<
    NormalizedMemorySubject,
    'appId' | 'agentId' | 'subjectType' | 'subjectId'
  >,
): SQL {
  return and(
    eq(i.agentId, subject.agentId),
    eq(i.subjectType, subject.subjectType),
    eq(i.subjectId, subjectIdFor(subject)),
  )!;
}

export function visibleSubjectFilters(
  i: typeof pgSchema.memoryItemsPostgres,
  input: Partial<MemoryBoundaryContext> & {
    includeCommon?: boolean;
    subjectTypes?: MemorySubjectType[];
  },
): SQL[] {
  const context = normalizeSubject(input);
  const allowed = new Set(
    input.subjectTypes || ['user', 'group', 'channel', 'common'],
  );
  const filters: SQL[] = [];
  if (input.includeCommon !== false && allowed.has('common')) {
    filters.push(
      subjectFilterSql(i, {
        appId: context.appId,
        agentId: context.agentId,
        subjectType: 'common',
        subjectId: 'common',
      }),
    );
  }
  if (context.userId && allowed.has('user')) {
    filters.push(
      subjectFilterSql(i, {
        appId: context.appId,
        agentId: context.agentId,
        subjectType: 'user',
        subjectId: context.userId,
      }),
    );
  }
  if (context.groupId && allowed.has('group')) {
    filters.push(
      subjectFilterSql(i, {
        appId: context.appId,
        agentId: context.agentId,
        subjectType: 'group',
        subjectId: context.groupId,
      }),
    );
  }
  if (context.channelId && allowed.has('channel')) {
    filters.push(
      subjectFilterSql(i, {
        appId: context.appId,
        agentId: context.agentId,
        subjectType: 'channel',
        subjectId: context.channelId,
      }),
    );
  }
  if (filters.length === 0 && allowed.has(context.subjectType)) {
    filters.push(
      subjectFilterSql(i, {
        appId: context.appId,
        agentId: context.agentId,
        subjectType: context.subjectType,
        subjectId: context.subjectId,
      }),
    );
  }
  return filters;
}
