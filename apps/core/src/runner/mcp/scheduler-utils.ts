import { threadId } from './context.js';

export const SCHEDULER_TARGET_SHORTCUTS = [
  'here',
  'this_thread',
  'this_topic',
  'me_dm',
] as const;

export type SchedulerTargetShortcut =
  (typeof SCHEDULER_TARGET_SHORTCUTS)[number];

export function parseSchedulerTargetShortcut(
  value: unknown,
): SchedulerTargetShortcut | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return SCHEDULER_TARGET_SHORTCUTS.find((item) => item === normalized);
}

export function resolveSchedulerShortcut(shortcut: SchedulerTargetShortcut): {
  threadId: string | null;
  error?: string;
} {
  if (shortcut === 'this_thread' || shortcut === 'this_topic') {
    if (!threadId) {
      return {
        threadId: null,
        error: `${shortcut} can only be used when the current run is in a thread/topic.`,
      };
    }
    return { threadId };
  }
  if (shortcut === 'here') {
    return { threadId: threadId ?? null };
  }
  return { threadId: null };
}

export function routeLabelForShortcut(
  shortcut: SchedulerTargetShortcut,
): string {
  switch (shortcut) {
    case 'this_thread':
    case 'this_topic':
      return 'this_thread';
    case 'me_dm':
      return 'me_dm';
    case 'here':
    default:
      return 'primary';
  }
}

export function normalizeExecutionMode(
  executionMode: unknown,
  serialize: unknown,
): 'parallel' | 'serialized' {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean') {
    return serialize ? 'serialized' : 'parallel';
  }
  return 'parallel';
}

export function resolveSchedulerThreadArg(
  value: unknown,
  disallowNull: boolean,
): { threadId: string | null | undefined; error?: string } {
  if (value === undefined) return { threadId: undefined };
  if (value === null) {
    if (disallowNull) {
      return {
        threadId: undefined,
        error: 'thread_id cannot be null for this operation.',
      };
    }
    return { threadId: null };
  }
  if (typeof value !== 'string') {
    return {
      threadId: undefined,
      error: 'thread_id must be a string.',
    };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      threadId: undefined,
      error: disallowNull
        ? 'thread_id must be a non-empty string.'
        : 'thread_id must be a non-empty string or null.',
    };
  }
  const shortcut = parseSchedulerTargetShortcut(trimmed);
  if (shortcut) return resolveSchedulerShortcut(shortcut);
  return { threadId: trimmed };
}
