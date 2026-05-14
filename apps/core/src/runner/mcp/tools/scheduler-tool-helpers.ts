import { nowIso } from '../../../shared/time/datetime.js';
import { chatJid, threadId, TASKS_DIR } from '../context.js';
import { formatTaskFailureLines } from '../formatting.js';
import {
  waitForTaskResponse,
  writeIpcFile,
  type TaskResponseEnvelope,
} from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';
import {
  parseSchedulerTargetShortcut,
  resolveSchedulerShortcut,
  routeLabelForShortcut,
} from '../scheduler-utils.js';

const SCHEDULER_WAIT_MIN_TIMEOUT_MS = 1_000;
const SCHEDULER_WAIT_MAX_TIMEOUT_MS = 300_000;
export const SCHEDULER_WAIT_RESPONSE_GRACE_MS = 10_000;

const ambientGroupScope = process.env.MYCLAW_GROUP_FOLDER?.trim() ?? '';

export async function requestSchedulerData(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<TaskResponseEnvelope | null> {
  const taskId = makeIpcId(type.replace(/_/g, '-'));
  writeIpcFile(TASKS_DIR, {
    type,
    taskId,
    ...payload,
    targetJid: chatJid,
    chatJid,
    authThreadId: threadId,
    timestamp: nowIso(),
  });
  return waitForTaskResponse(taskId, timeoutMs);
}

export function normalizeSchedulerWaitTimeoutMs(value: unknown): number {
  const raw =
    typeof value === 'number' && Number.isFinite(value) ? value : 30_000;
  return Math.max(
    SCHEDULER_WAIT_MIN_TIMEOUT_MS,
    Math.min(raw, SCHEDULER_WAIT_MAX_TIMEOUT_MS),
  );
}

export function schedulerTaskError(
  response: TaskResponseEnvelope | null,
  fallback: string,
) {
  if (!response) {
    return {
      content: [{ type: 'text' as const, text: `${fallback} timed out.` }],
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: formatTaskFailureLines(response, fallback).join('\n'),
        },
      ],
      isError: true,
    };
  }
  return null;
}

type SchedulerMutationResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export async function submitSchedulerMutationTask(input: {
  taskType: string;
  taskId: string;
  payload: Record<string, unknown>;
  timeoutText: string;
  rejectedText: string;
  successText: string;
  timeoutMs?: number;
}): Promise<SchedulerMutationResult> {
  writeIpcFile(TASKS_DIR, {
    type: input.taskType,
    taskId: input.taskId,
    ...input.payload,
    targetJid: chatJid,
    chatJid,
    authThreadId: threadId,
    timestamp: nowIso(),
  });
  const response = await waitForTaskResponse(
    input.taskId,
    input.timeoutMs ?? 20_000,
  );
  if (!response) {
    return {
      content: [{ type: 'text', text: input.timeoutText }],
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: formatTaskFailureLines(response, input.rejectedText).join('\n'),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: response.message || input.successText }],
  };
}

export function schedulerDataRecord(
  response: TaskResponseEnvelope,
): Record<string, unknown> {
  return typeof response.data === 'object' &&
    response.data !== null &&
    !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : {};
}

function normalizeExecutionContextArg(value: unknown): {
  conversationJid: string;
  threadId: string | null;
  groupScope: string;
  sessionId?: string | null;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const conversationJid =
    typeof record.conversation_jid === 'string'
      ? record.conversation_jid.trim()
      : '';
  const groupScope =
    typeof record.group_scope === 'string' ? record.group_scope.trim() : '';
  const threadRaw = record.thread_id;
  const threadIdValue =
    threadRaw === null
      ? null
      : typeof threadRaw === 'string'
        ? threadRaw.trim()
        : undefined;
  const sessionRaw = record.session_id;
  const sessionIdValue =
    sessionRaw === null
      ? null
      : typeof sessionRaw === 'string'
        ? sessionRaw.trim()
        : undefined;
  if (!conversationJid || !groupScope || threadIdValue === undefined) {
    return null;
  }
  if (threadRaw !== null && !threadIdValue) return null;
  if (
    sessionRaw !== undefined &&
    sessionRaw !== null &&
    (!sessionIdValue || sessionIdValue.length === 0)
  ) {
    return null;
  }
  return {
    conversationJid,
    threadId: threadIdValue,
    groupScope,
    ...(sessionRaw !== undefined ? { sessionId: sessionIdValue ?? null } : {}),
  };
}

function normalizeNotificationRoutesArg(value: unknown): Array<{
  conversationJid: string;
  threadId: string | null;
  label: string;
}> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const routes: Array<{
    conversationJid: string;
    threadId: string | null;
    label: string;
  }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const conversationJid =
      typeof record.conversation_jid === 'string'
        ? record.conversation_jid.trim()
        : '';
    const threadRaw = record.thread_id;
    const threadIdValue =
      threadRaw === null
        ? null
        : typeof threadRaw === 'string'
          ? threadRaw.trim()
          : undefined;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!conversationJid || !label || threadIdValue === undefined) {
      return null;
    }
    if (threadRaw !== null && !threadIdValue) return null;
    routes.push({ conversationJid, threadId: threadIdValue, label });
  }
  return routes;
}

export function canonicalTargetFromArgs(
  args: Record<string, unknown>,
  useAmbientDefault: boolean,
): {
  executionContext: {
    conversationJid: string;
    threadId: string | null;
    groupScope: string;
    sessionId?: string | null;
  };
  notificationRoutes: Array<{
    conversationJid: string;
    threadId: string | null;
    label: string;
  }>;
  error?: string;
} {
  const defaultExecutionContext = {
    conversationJid: chatJid,
    threadId: threadId ?? null,
    groupScope: ambientGroupScope,
  };
  const executionContext = normalizeExecutionContextArg(args.execution_context);
  if (args.execution_context !== undefined && !executionContext) {
    return {
      executionContext: defaultExecutionContext,
      notificationRoutes: [],
      error:
        'execution_context must include conversation_jid, group_scope, and thread_id.',
    };
  }
  const notificationRoutes = normalizeNotificationRoutesArg(
    args.notification_routes,
  );
  if (args.notification_routes !== undefined && !notificationRoutes) {
    return {
      executionContext: executionContext ?? defaultExecutionContext,
      notificationRoutes: [],
      error:
        'notification_routes entries require conversation_jid, thread_id, and label.',
    };
  }
  const shortcut = parseSchedulerTargetShortcut(args.target);
  if (args.target !== undefined && !shortcut) {
    return {
      executionContext: executionContext ?? defaultExecutionContext,
      notificationRoutes: [],
      error: 'target must be one of here, this_thread, this_topic, or me_dm.',
    };
  }
  const shortcutResolution = shortcut
    ? resolveSchedulerShortcut(shortcut)
    : undefined;
  if (shortcutResolution?.error) {
    return {
      executionContext: executionContext ?? defaultExecutionContext,
      notificationRoutes: [],
      error: shortcutResolution.error,
    };
  }

  const defaultThread = useAmbientDefault ? (threadId ?? null) : null;
  const baseExecutionContext =
    executionContext ??
    (shortcut
      ? {
          conversationJid: chatJid,
          threadId: shortcutResolution?.threadId ?? null,
          groupScope: ambientGroupScope,
        }
      : {
          conversationJid: chatJid,
          threadId: defaultThread,
          groupScope: ambientGroupScope,
        });
  if (shortcut && executionContext) {
    const shortcutThreadId = shortcutResolution?.threadId ?? null;
    if ((executionContext.threadId ?? null) !== shortcutThreadId) {
      return {
        executionContext: baseExecutionContext,
        notificationRoutes: [],
        error:
          'execution_context.thread_id conflicts with the selected target shortcut.',
      };
    }
  }
  const baseNotificationRoutes = notificationRoutes ?? [
    {
      conversationJid: baseExecutionContext.conversationJid,
      threadId: baseExecutionContext.threadId,
      label: shortcut ? routeLabelForShortcut(shortcut) : 'primary',
    },
  ];
  return {
    executionContext: baseExecutionContext,
    notificationRoutes: baseNotificationRoutes,
  };
}
