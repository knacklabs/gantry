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
