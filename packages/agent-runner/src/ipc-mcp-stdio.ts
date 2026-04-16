/**
 * Stdio MCP Server for MyClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { MemoryIpcAction } from './memory-ipc-contract.js';
import { BrowserIpcAction } from './browser-ipc-contract.js';

const IPC_DIR = process.env.MYCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEMORY_REQUESTS_DIR = path.join(IPC_DIR, 'memory-requests');
const MEMORY_RESPONSES_DIR = path.join(IPC_DIR, 'memory-responses');
const BROWSER_REQUESTS_DIR = path.join(IPC_DIR, 'browser-requests');
const BROWSER_RESPONSES_DIR = path.join(IPC_DIR, 'browser-responses');
const PLAN_EVENTS_DIR = path.join(IPC_DIR, 'plan-events');
const PLAN_RESPONSES_DIR = path.join(IPC_DIR, 'plan-responses');
const TASK_RESPONSES_DIR = path.join(IPC_DIR, 'task-responses');
const CURRENT_PLANS_FILE = path.join(IPC_DIR, 'current_plans.json');
const IPC_AUTH_TOKEN = process.env.MYCLAW_IPC_AUTH_TOKEN || '';
const MINI_APP_API_URL = (process.env.MYCLAW_MINI_APP_API_URL || '').trim();
const MINI_APP_FRONTEND_URL = (
  process.env.MYCLAW_MINI_APP_FRONTEND_URL || 'https://app.myclaw.dev'
).trim();
const PLAN_EVENT_CONSUMER_ID = (
  process.env.CLAUDE_SESSION_ID || `pid-${process.pid}`
).trim();
const consumedPlanEventFiles = new Set<string>();
const USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const USER_QUESTION_POLL_INTERVAL_MS = 100;
const USER_QUESTION_MAX_ANSWER_LENGTH = 500;
const USER_QUESTION_MAX_ANSWERED_BY_LENGTH = 120;

// Context from environment variables (set by the agent runner)
const chatJid = process.env.MYCLAW_CHAT_JID!;
const groupFolder = process.env.MYCLAW_GROUP_FOLDER!;
const isMain = process.env.MYCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  const envelope = IPC_AUTH_TOKEN
    ? { ...data, authToken: IPC_AUTH_TOKEN }
    : data;
  fs.writeFileSync(tempPath, JSON.stringify(envelope, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function readJsonArraySnapshot(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return Array.isArray(parsed) ? parsed : [];
}

async function requestMemoryAction(
  action: MemoryIpcAction,
  payload: Record<string, unknown>,
): Promise<{
  ok: boolean;
  provider?: string;
  data?: unknown;
  error?: string;
}> {
  fs.mkdirSync(MEMORY_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(MEMORY_RESPONSES_DIR, { recursive: true });

  const requestId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reqPath = path.join(MEMORY_REQUESTS_DIR, `${requestId}.json`);
  const tmpReqPath = `${reqPath}.tmp`;
  fs.writeFileSync(
    tmpReqPath,
    JSON.stringify(
      {
        requestId,
        action,
        payload,
        ...(IPC_AUTH_TOKEN ? { authToken: IPC_AUTH_TOKEN } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpReqPath, reqPath);

  const deadline = Date.now() + 15000;
  const responsePath = path.join(MEMORY_RESPONSES_DIR, `${requestId}.json`);

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
          ok: boolean;
          provider?: string;
          data?: unknown;
          error?: string;
        };
        fs.unlinkSync(responsePath);
        return data;
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse memory response',
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, error: 'Timed out waiting for memory service response' };
}

async function requestBrowserAction(
  action: BrowserIpcAction,
  payload: Record<string, unknown>,
): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  fs.mkdirSync(BROWSER_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(BROWSER_RESPONSES_DIR, { recursive: true });

  const requestId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reqPath = path.join(BROWSER_REQUESTS_DIR, `${requestId}.json`);
  const tmpReqPath = `${reqPath}.tmp`;

  fs.writeFileSync(
    tmpReqPath,
    JSON.stringify(
      {
        requestId,
        action,
        payload,
        ...(IPC_AUTH_TOKEN ? { authToken: IPC_AUTH_TOKEN } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpReqPath, reqPath);

  const deadline = Date.now() + 30_000;
  const responsePath = path.join(BROWSER_RESPONSES_DIR, `${requestId}.json`);

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        fs.unlinkSync(responsePath);
        return data;
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse browser response',
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, error: 'Timed out waiting for browser service response' };
}

function formatMemoryToolResponse(response: {
  provider?: string;
  data?: unknown;
}): string {
  return JSON.stringify(
    {
      provider: response.provider || 'unknown',
      ...(typeof response.data === 'object' &&
      response.data !== null &&
      !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : { data: response.data }),
    },
    null,
    2,
  );
}

function formatBrowserToolResponse(response: { data?: unknown }): string {
  if (
    typeof response.data === 'object' &&
    response.data !== null &&
    !Array.isArray(response.data)
  ) {
    return JSON.stringify(response.data, null, 2);
  }
  return JSON.stringify({ data: response.data }, null, 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeExecutionMode(
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

function filterSchedulerEvents(
  events: unknown[],
  args: {
    job_id?: string;
    run_id?: string;
    event_type?: string;
    since_id?: number;
    since?: string;
  },
): Array<{
  id?: number;
  job_id?: string;
  run_id?: string | null;
  event_type?: string;
  payload?: string | null;
  created_at?: string;
}> {
  const sinceTimestamp = args.since ? Date.parse(args.since) : NaN;
  return events.filter((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const row = item as {
      id?: number;
      job_id?: string;
      run_id?: string | null;
      event_type?: string;
      created_at?: string;
    };
    if (args.job_id && row.job_id !== args.job_id) return false;
    if (args.run_id && row.run_id !== args.run_id) return false;
    if (args.event_type && row.event_type !== args.event_type) return false;
    if (
      typeof args.since_id === 'number' &&
      Number.isFinite(args.since_id) &&
      typeof row.id === 'number' &&
      row.id <= args.since_id
    ) {
      return false;
    }
    if (!Number.isNaN(sinceTimestamp) && row.created_at) {
      const created = Date.parse(row.created_at);
      if (Number.isFinite(created) && created <= sinceTimestamp) return false;
    }
    return true;
  }) as Array<{
    id?: number;
    job_id?: string;
    run_id?: string | null;
    event_type?: string;
    payload?: string | null;
    created_at?: string;
  }>;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return false;
  }
  if (signal.aborted) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getMiniAppPlanUrl(planId: string): string {
  const normalized = (
    MINI_APP_FRONTEND_URL || 'https://app.myclaw.dev'
  ).replace(/\/+$/, '');
  const base = `${normalized}/plans/${planId}`;
  if (!MINI_APP_API_URL) return base;
  return `${base}?api=${encodeURIComponent(MINI_APP_API_URL)}`;
}

function readCurrentPlansSnapshot(): Array<Record<string, unknown>> {
  if (!fs.existsSync(CURRENT_PLANS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(CURRENT_PLANS_FILE, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    );
  } catch {
    return [];
  }
}

function findPlanInSnapshot(planId: string): Record<string, unknown> | null {
  const plans = readCurrentPlansSnapshot();
  return (
    plans.find(
      (entry) => typeof entry.id === 'string' && String(entry.id) === planId,
    ) || null
  );
}

async function waitForPlanSnapshot(
  planId: string,
  timeoutMs = 7_500,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plan = findPlanInSnapshot(planId);
    if (plan) return plan;
    await sleep(150);
  }
  return findPlanInSnapshot(planId);
}

interface PlanTaskResponseEnvelope {
  taskId: string;
  ok: boolean;
  planId?: string;
  plan?: Record<string, unknown> | null;
  url?: string;
  error?: string;
  warning?: string;
  timestamp?: string;
}

interface TaskResponseEnvelope {
  taskId: string;
  ok: boolean;
  message?: string;
  error?: string;
  details?: string[];
  timestamp?: string;
}

function parsePlanTaskResponseEnvelope(
  raw: unknown,
): PlanTaskResponseEnvelope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
  if (!taskId || typeof row.ok !== 'boolean') return null;
  const plan =
    typeof row.plan === 'object' &&
    row.plan !== null &&
    !Array.isArray(row.plan)
      ? (row.plan as Record<string, unknown>)
      : undefined;
  return {
    taskId,
    ok: row.ok,
    ...(typeof row.planId === 'string' ? { planId: row.planId } : {}),
    ...(plan ? { plan } : {}),
    ...(typeof row.url === 'string' ? { url: row.url } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    ...(typeof row.warning === 'string' ? { warning: row.warning } : {}),
    ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
  };
}

function parseTaskResponseEnvelope(raw: unknown): TaskResponseEnvelope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
  if (!taskId || typeof row.ok !== 'boolean') return null;
  const details = Array.isArray(row.details)
    ? row.details
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : undefined;
  return {
    taskId,
    ok: row.ok,
    ...(typeof row.message === 'string' ? { message: row.message } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    ...(details ? { details } : {}),
    ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
  };
}

async function waitForPlanTaskResponse(
  taskId: string,
  timeoutMs = 15_000,
): Promise<PlanTaskResponseEnvelope | null> {
  fs.mkdirSync(PLAN_RESPONSES_DIR, { recursive: true });
  const responsePath = path.join(PLAN_RESPONSES_DIR, `task-${taskId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const parsed = parsePlanTaskResponseEnvelope(
          JSON.parse(fs.readFileSync(responsePath, 'utf-8')),
        );
        fs.unlinkSync(responsePath);
        if (!parsed) {
          return {
            taskId,
            ok: false,
            error: 'Invalid plan task response payload',
          };
        }
        return parsed;
      } catch (err) {
        try {
          fs.unlinkSync(responsePath);
        } catch {
          // ignore
        }
        return {
          taskId,
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse plan task response',
        };
      }
    }
    await sleep(150);
  }
  return null;
}

async function waitForTaskResponse(
  taskId: string,
  timeoutMs = 15_000,
): Promise<TaskResponseEnvelope | null> {
  fs.mkdirSync(TASK_RESPONSES_DIR, { recursive: true });
  const responsePath = path.join(TASK_RESPONSES_DIR, `task-${taskId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const parsed = parseTaskResponseEnvelope(
          JSON.parse(fs.readFileSync(responsePath, 'utf-8')),
        );
        fs.unlinkSync(responsePath);
        if (!parsed) {
          return {
            taskId,
            ok: false,
            error: 'Invalid task response payload',
          };
        }
        return parsed;
      } catch (err) {
        try {
          fs.unlinkSync(responsePath);
        } catch {
          // ignore
        }
        return {
          taskId,
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Failed to parse task response',
        };
      }
    }
    await sleep(150);
  }
  return null;
}

interface PlanEventEnvelope {
  type: string;
  planId: string;
  sectionIndex?: number;
  userId?: string;
  reason?: string;
  newContent?: string;
  timestamp?: string;
}

function parsePlanEventEnvelope(raw: unknown): PlanEventEnvelope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.trim() : '';
  const planId = typeof row.planId === 'string' ? row.planId.trim() : '';
  if (!type || !planId) return null;
  const sectionIndex =
    typeof row.sectionIndex === 'number'
      ? Math.trunc(row.sectionIndex)
      : undefined;
  return {
    type,
    planId,
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
    ...(typeof row.userId === 'string' ? { userId: row.userId } : {}),
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    ...(typeof row.newContent === 'string'
      ? { newContent: row.newContent }
      : {}),
    ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
  };
}

function consumePlanEvents(planId: string): PlanEventEnvelope[] {
  fs.mkdirSync(PLAN_EVENTS_DIR, { recursive: true });
  const files = fs
    .readdirSync(PLAN_EVENTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const events: PlanEventEnvelope[] = [];
  for (const file of files) {
    const sourcePath = path.join(PLAN_EVENTS_DIR, file);
    const consumeKey = `${PLAN_EVENT_CONSUMER_ID}:${planId}:${file}`;
    if (consumedPlanEventFiles.has(consumeKey)) {
      continue;
    }
    try {
      const parsed = parsePlanEventEnvelope(
        JSON.parse(fs.readFileSync(sourcePath, 'utf-8')),
      );
      if (parsed && parsed.planId === planId) {
        consumedPlanEventFiles.add(consumeKey);
        events.push(parsed);
      }
    } catch {
      // ignore malformed events and keep polling
    }
  }

  if (consumedPlanEventFiles.size > 10_000) {
    let drop = consumedPlanEventFiles.size - 5_000;
    for (const key of consumedPlanEventFiles) {
      consumedPlanEventFiles.delete(key);
      drop -= 1;
      if (drop <= 0) break;
    }
  }

  return events;
}

async function waitForPlanEvents(
  planId: string,
  timeoutMs: number,
): Promise<PlanEventEnvelope[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = consumePlanEvents(planId);
    if (events.length > 0) return events;
    await sleep(250);
  }
  return [];
}

const server = new McpServer({
  name: 'myclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (
    args,
    context?: {
      signal?: AbortSignal;
    },
  ) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'ask_user_question',
  'Ask the user a structured multiple-choice question. Shows interactive buttons in Telegram. Use when you need the user to pick between discrete options (e.g. which database, which approach, which config). Returns the selected option(s).',
  {
    questions: z
      .array(
        z.object({
          question: z
            .string()
            .describe('The question to ask (must end with ?)'),
          header: z
            .string()
            .max(12)
            .describe('Short label displayed as tag, e.g. "Deploy", "Config"'),
          options: z
            .array(
              z.object({
                label: z.string().describe('Option text (1-5 words)'),
                description: z.string().describe('What this option means'),
              }),
            )
            .min(2)
            .max(4),
          multiSelect: z
            .boolean()
            .default(false)
            .describe('Allow selecting multiple options'),
        }),
      )
      .min(1)
      .max(4),
  },
  async (
    args,
    context?: {
      signal?: AbortSignal;
    },
  ) => {
    const userQuestionRequestsDir = path.join(IPC_DIR, 'user-questions');
    const userQuestionResponsesDir = path.join(IPC_DIR, 'user-answers');
    fs.mkdirSync(userQuestionRequestsDir, { recursive: true });
    fs.mkdirSync(userQuestionResponsesDir, { recursive: true });

    const requestId = `userq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = path.join(userQuestionRequestsDir, `${requestId}.json`);
    const responsePath = path.join(
      userQuestionResponsesDir,
      `${requestId}.json`,
    );
    const tmpPath = `${requestPath}.tmp`;

    const envelope = {
      requestId,
      sourceGroup: groupFolder,
      questions: args.questions,
      ...(IPC_AUTH_TOKEN ? { authToken: IPC_AUTH_TOKEN } : {}),
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, requestPath);

    const deadline = Date.now() + USER_QUESTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (context?.signal?.aborted) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Question cancelled before an answer was received.',
            },
          ],
        };
      }
      if (fs.existsSync(responsePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
            answers?: Record<string, unknown>;
            answeredBy?: unknown;
          };
          fs.unlinkSync(responsePath);
          if (raw?.answers && typeof raw.answers === 'object') {
            const lines: string[] = [];
            for (const [q, answer] of Object.entries(raw.answers)) {
              const normalizedAnswer = Array.isArray(answer)
                ? answer.map((item) => String(item)).join(', ')
                : String(answer);
              lines.push(
                `${q}: ${truncateText(normalizedAnswer, USER_QUESTION_MAX_ANSWER_LENGTH)}`,
              );
            }
            if (typeof raw.answeredBy === 'string' && raw.answeredBy.trim()) {
              lines.push(
                `(answered by ${truncateText(raw.answeredBy.trim(), USER_QUESTION_MAX_ANSWERED_BY_LENGTH)})`,
              );
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: lines.join('\n') || 'No answer received.',
                },
              ],
            };
          }
        } catch {
          return {
            content: [
              { type: 'text' as const, text: 'Failed to read answer.' },
            ],
          };
        }
      }
      const aborted = await sleepWithAbort(
        USER_QUESTION_POLL_INTERVAL_MS,
        context?.signal,
      );
      if (aborted) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Question cancelled before an answer was received.',
            },
          ],
        };
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Question timed out — no answer received within 5 minutes.',
        },
      ],
    };
  },
);

server.tool(
  'scheduler_upsert_job',
  'Create or update a scheduler job. Idempotent by job ID.',
  {
    job_id: z.string().optional(),
    name: z.string(),
    prompt: z.string(),
    model: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once', 'manual']),
    schedule_value: z.string().default(''),
    linked_sessions: z.array(z.string()).optional(),
    deliver_to: z.array(z.string()).optional(),
    thread_id: z.string().optional(),
    silent: z.boolean().optional(),
    cleanup_after_ms: z.number().optional(),
    group_scope: z.string().optional(),
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
    retry_backoff_ms: z.number().optional(),
    max_consecutive_failures: z.number().optional(),
    execution_mode: z.enum(['parallel', 'serialized']).optional(),
    serialize: z.boolean().optional(),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            { type: 'text' as const, text: 'Invalid cron expression.' },
          ],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            { type: 'text' as const, text: 'Invalid interval milliseconds.' },
          ],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid once timestamp.' }],
          isError: true,
        };
      }
    }

    const data = {
      type: 'scheduler_upsert_job',
      jobId: args.job_id,
      name: args.name,
      prompt: args.prompt,
      model: args.model,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      linkedSessions: args.linked_sessions,
      deliverTo: args.deliver_to,
      threadId: args.thread_id,
      silent: args.silent,
      cleanupAfterMs: args.cleanup_after_ms,
      groupScope: args.group_scope,
      timeoutMs: args.timeout_ms,
      maxRetries: args.max_retries,
      retryBackoffMs: args.retry_backoff_ms,
      maxConsecutiveFailures: args.max_consecutive_failures,
      executionMode: normalizeExecutionMode(
        args.execution_mode,
        args.serialize,
      ),
      serialize: args.serialize,
      createdBy: 'agent',
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [
        { type: 'text' as const, text: 'Scheduler job upsert requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_once',
  'Schedule a one-time task and deliver the result back to chat.',
  {
    name: z.string(),
    prompt: z.string(),
    run_at: z
      .string()
      .describe('ISO timestamp, e.g. 2026-04-14T15:00:00+05:30'),
    deliver_to: z.array(z.string()).optional(),
    thread_id: z.string().optional(),
    cleanup_after_ms: z.number().default(86_400_000),
    timeout_ms: z.number().default(300_000),
    silent: z.boolean().default(false),
    model: z.string().optional(),
    group_scope: z.string().optional(),
    max_retries: z.number().optional(),
    retry_backoff_ms: z.number().optional(),
    max_consecutive_failures: z.number().optional(),
    execution_mode: z.enum(['parallel', 'serialized']).optional(),
    serialize: z.boolean().optional(),
  },
  async (args) => {
    const runAtDate = new Date(args.run_at);
    if (isNaN(runAtDate.getTime())) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid run_at timestamp.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_once',
      name: args.name,
      prompt: args.prompt,
      model: args.model,
      run_at: runAtDate.toISOString(),
      deliverTo:
        args.deliver_to && args.deliver_to.length > 0
          ? args.deliver_to
          : [chatJid],
      threadId: args.thread_id,
      groupScope: args.group_scope ?? groupFolder,
      silent: args.silent,
      cleanupAfterMs: args.cleanup_after_ms,
      timeoutMs: args.timeout_ms,
      maxRetries: args.max_retries,
      retryBackoffMs: args.retry_backoff_ms,
      maxConsecutiveFailures: args.max_consecutive_failures,
      executionMode: normalizeExecutionMode(
        args.execution_mode,
        args.serialize,
      ),
      serialize: args.serialize,
      createdBy: 'agent',
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        { type: 'text' as const, text: 'One-time scheduler job requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_get_job',
  'Get one scheduler job by ID from host snapshots.',
  { job_id: z.string() },
  async (args) => {
    const jobs = readJsonArraySnapshot(path.join(IPC_DIR, 'current_jobs.json'));
    const job =
      jobs.find(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'id' in item &&
          (item as { id?: string }).id === args.job_id,
      ) || null;
    return {
      content: [
        {
          type: 'text' as const,
          text: job ? JSON.stringify(job, null, 2) : 'Job not found.',
        },
      ],
    };
  },
);

server.tool(
  'scheduler_list_jobs',
  'List scheduler jobs from host snapshots.',
  {
    statuses: z.array(z.string()).optional(),
    group_scope: z.string().optional(),
  },
  async (args) => {
    const jobs = readJsonArraySnapshot(path.join(IPC_DIR, 'current_jobs.json'));
    const filtered = jobs.filter((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const row = item as { status?: string; group_scope?: string };
      if (args.statuses && args.statuses.length > 0) {
        if (!row.status || !args.statuses.includes(row.status)) return false;
      }
      if (args.group_scope && row.group_scope !== args.group_scope)
        return false;
      return true;
    });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
      ],
    };
  },
);

server.tool(
  'scheduler_update_job',
  'Update mutable fields on a scheduler job.',
  {
    job_id: z.string(),
    name: z.string().optional(),
    prompt: z.string().optional(),
    model: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once', 'manual']).optional(),
    schedule_value: z.string().optional(),
    linked_sessions: z.array(z.string()).optional(),
    deliver_to: z.array(z.string()).optional(),
    thread_id: z.string().optional(),
    silent: z.boolean().optional(),
    cleanup_after_ms: z.number().optional(),
    group_scope: z.string().optional(),
    timeout_ms: z.number().optional(),
    max_retries: z.number().optional(),
    retry_backoff_ms: z.number().optional(),
    max_consecutive_failures: z.number().optional(),
    execution_mode: z.enum(['parallel', 'serialized']).optional(),
    serialize: z.boolean().optional(),
  },
  async (args) => {
    const executionMode =
      args.execution_mode !== undefined || args.serialize !== undefined
        ? normalizeExecutionMode(args.execution_mode, args.serialize)
        : undefined;
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_update_job',
      jobId: args.job_id,
      name: args.name,
      prompt: args.prompt,
      model: args.model,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      linkedSessions: args.linked_sessions,
      deliverTo: args.deliver_to,
      threadId: args.thread_id,
      silent: args.silent,
      cleanupAfterMs: args.cleanup_after_ms,
      groupScope: args.group_scope,
      timeoutMs: args.timeout_ms,
      maxRetries: args.max_retries,
      retryBackoffMs: args.retry_backoff_ms,
      maxConsecutiveFailures: args.max_consecutive_failures,
      executionMode,
      serialize: args.serialize,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: 'Scheduler job update requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_delete_job',
  'Delete a scheduler job.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_delete_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: 'Scheduler job delete requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_pause_job',
  'Pause a scheduler job.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_pause_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: 'Scheduler job pause requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_resume_job',
  'Resume a paused scheduler job.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_resume_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: 'Scheduler job resume requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_trigger_job',
  'Trigger a scheduler job immediately.',
  { job_id: z.string() },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_trigger_job',
      jobId: args.job_id,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: 'Scheduler trigger requested.' },
      ],
    };
  },
);

server.tool(
  'scheduler_list_runs',
  'List job runs from host snapshots.',
  {
    job_id: z.string().optional(),
    limit: z.number().optional(),
  },
  async (args) => {
    const runs = readJsonArraySnapshot(
      path.join(IPC_DIR, 'current_job_runs.json'),
    );
    const filtered = runs
      .filter((item) => {
        if (typeof item !== 'object' || item === null) return false;
        if (!args.job_id) return true;
        return (item as { job_id?: string }).job_id === args.job_id;
      })
      .slice(0, args.limit ?? 50);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
      ],
    };
  },
);

server.tool(
  'scheduler_list_events',
  'List scheduler lifecycle events from host snapshots.',
  {
    job_id: z.string().optional(),
    run_id: z.string().optional(),
    event_type: z.string().optional(),
    since_id: z.number().optional(),
    since: z.string().optional(),
    limit: z.number().optional(),
  },
  async (args) => {
    const events = readJsonArraySnapshot(
      path.join(IPC_DIR, 'current_job_events.json'),
    );
    const filtered = filterSchedulerEvents(events, args).slice(
      0,
      args.limit ?? 100,
    );
    writeIpcFile(TASKS_DIR, {
      type: 'scheduler_list_events',
      jobId: args.job_id,
      runId: args.run_id,
      eventType: args.event_type,
      sinceId: args.since_id,
      limit: args.limit,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
      ],
    };
  },
);

server.tool(
  'scheduler_wait_for_events',
  'Wait for scheduler lifecycle events to arrive in host snapshots.',
  {
    job_id: z.string().optional(),
    run_id: z.string().optional(),
    event_type: z.string().optional(),
    since_id: z.number().optional(),
    since: z.string().optional(),
    limit: z.number().optional(),
    timeout_ms: z.number().optional(),
  },
  async (args) => {
    const timeoutMs = Math.max(
      1_000,
      Math.min(args.timeout_ms ?? 30_000, 120_000),
    );
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = readJsonArraySnapshot(
        path.join(IPC_DIR, 'current_job_events.json'),
      );
      const filtered = filterSchedulerEvents(events, args).slice(0, limit);
      if (filtered.length > 0) {
        writeIpcFile(TASKS_DIR, {
          type: 'scheduler_wait_for_events',
          jobId: args.job_id,
          runId: args.run_id,
          eventType: args.event_type,
          sinceId: args.since_id,
          limit,
          timestamp: new Date().toISOString(),
        });
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(filtered, null, 2) },
          ],
        };
      }
      await sleep(250);
    }
    return {
      content: [{ type: 'text' as const, text: '[]' }],
    };
  },
);

server.tool(
  'scheduler_get_dead_letter',
  'List dead-lettered job runs from host snapshots.',
  { limit: z.number().optional() },
  async (args) => {
    const runs = readJsonArraySnapshot(
      path.join(IPC_DIR, 'current_job_runs.json'),
    )
      .filter(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as { status?: string }).status === 'dead_lettered',
      )
      .slice(0, args.limit ?? 50);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(runs, null, 2) }],
    };
  },
);

server.tool(
  'memory_search',
  'Search durable memory using lexical+embedding fusion and return scoped snippets with provenance.',
  {
    query: z.string().describe('Search query'),
    group_folder: z
      .string()
      .optional()
      .describe('Optional override group folder (defaults to current group)'),
    user_id: z
      .string()
      .optional()
      .describe('Optional user id for user-scoped facts'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results'),
  },
  async (args) => {
    const response = await requestMemoryAction('memory_search', {
      query: args.query,
      group_folder: args.group_folder || groupFolder,
      user_id: args.user_id,
      limit: args.limit,
    });
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory search failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatMemoryToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'memory_save',
  'Save a durable memory fact/preference/correction item.',
  {
    scope: z.enum(['user', 'group', 'global']).optional(),
    group_folder: z.string().optional(),
    user_id: z.string().optional(),
    kind: z
      .enum(['preference', 'fact', 'context', 'correction', 'recent_work'])
      .optional(),
    key: z.string(),
    value: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('memory_save', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory save failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatMemoryToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'memory_patch',
  'Patch an existing memory item using optimistic concurrency.',
  {
    id: z.string(),
    expected_version: z.number().int().min(1),
    key: z.string().optional(),
    value: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('memory_patch', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory patch failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatMemoryToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'procedure_save',
  'Save a reusable procedure learned from successful work.',
  {
    scope: z.enum(['user', 'group', 'global']).optional(),
    group_folder: z.string().optional(),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('procedure_save', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Procedure save failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatMemoryToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'procedure_patch',
  'Patch an existing procedure using optimistic concurrency.',
  {
    id: z.string(),
    expected_version: z.number().int().min(1),
    title: z.string().optional(),
    body: z.string().optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  },
  async (args) => {
    const response = await requestMemoryAction('procedure_patch', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Procedure patch failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatMemoryToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'browser_profile_list',
  'List available browser profiles and metadata.',
  {},
  async () => {
    const response = await requestBrowserAction('browser_profile_list', {});
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Browser profile list failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatBrowserToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'browser_launch',
  'Launch or reuse the shared Chrome browser session (profile: myclaw).',
  {
    profile_name: z.string().optional().default('myclaw'),
    headless: z.boolean().optional(),
    cdp_port: z.number().optional(),
    keep_alive_ms: z.number().optional(),
  },
  async (args) => {
    const response = await requestBrowserAction('browser_launch', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Browser launch failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatBrowserToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'browser_close',
  'Close the shared Chrome browser session (profile: myclaw).',
  {
    profile_name: z.string().optional().default('myclaw'),
  },
  async (args) => {
    const response = await requestBrowserAction('browser_close', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Browser close failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: formatBrowserToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'browser_status',
  'Get status for the shared Chrome browser session (profile: myclaw).',
  {
    profile_name: z.string().optional().default('myclaw'),
  },
  async (args) => {
    const response = await requestBrowserAction('browser_status', args);
    if (!response.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Browser status failed: ${response.error || 'unknown error'}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: 'text' as const, text: formatBrowserToolResponse(response) },
      ],
    };
  },
);

server.tool(
  'create_plan',
  'Create a reviewable plan with sections and expose it to Telegram Mini App consumers.',
  {
    title: z.string(),
    sections: z.array(
      z.object({
        title: z.string(),
        content: z.string(),
      }),
    ),
    chat_jid: z
      .string()
      .optional()
      .describe('Optional target chat JID for the launch button notification'),
  },
  async (args) => {
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskId = `plan-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'plan_create',
      taskId,
      payload: {
        planId,
        title: args.title,
        sections: args.sections,
        chatJid: args.chat_jid || chatJid,
        agentSessionId: process.env.CLAUDE_SESSION_ID || undefined,
      },
      timestamp: new Date().toISOString(),
    });

    const taskResponse = await waitForPlanTaskResponse(taskId);
    if (taskResponse && !taskResponse.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: false,
                taskId,
                planId,
                error: taskResponse.error || 'Plan creation failed',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const createdPlan =
      taskResponse?.plan ||
      (await waitForPlanSnapshot(planId, taskResponse ? 2_000 : 10_000));
    if (!createdPlan) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: false,
                taskId,
                planId,
                error:
                  'Timed out waiting for host confirmation for created plan',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const url = getMiniAppPlanUrl(planId);
    const payload = {
      ok: true,
      taskId,
      planId,
      url,
      plan: createdPlan,
      ...(taskResponse?.warning ? { warning: taskResponse.warning } : {}),
      ...(!taskResponse
        ? { warning: 'Host response timed out; used snapshot fallback.' }
        : {}),
    };

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
      ],
    };
  },
);

server.tool(
  'update_plan_section',
  'Update one section in an existing plan (content/status/feedback/revision).',
  {
    plan_id: z.string(),
    section_index: z.number().int().min(0),
    title: z.string().optional(),
    content: z.string().optional(),
    status: z
      .enum(['pending', 'approved', 'rejected', 'editing', 'executing', 'done'])
      .optional(),
    user_feedback: z.string().optional(),
    agent_revision: z.string().optional(),
  },
  async (args) => {
    const taskId = `plan-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'plan_update_section',
      taskId,
      payload: {
        planId: args.plan_id,
        sectionIndex: args.section_index,
        title: args.title,
        content: args.content,
        status: args.status,
        userFeedback: args.user_feedback,
        agentRevision: args.agent_revision,
      },
      timestamp: new Date().toISOString(),
    });

    const taskResponse = await waitForPlanTaskResponse(taskId);
    if (taskResponse && !taskResponse.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: false,
                taskId,
                planId: args.plan_id,
                error: taskResponse.error || 'Plan update failed',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const updated =
      taskResponse?.plan ||
      (await waitForPlanSnapshot(args.plan_id, taskResponse ? 2_000 : 10_000));
    if (!updated) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: false,
                taskId,
                planId: args.plan_id,
                error:
                  'Timed out waiting for host confirmation for updated plan',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              taskId,
              planId: args.plan_id,
              plan: updated,
              ...(taskResponse?.warning
                ? { warning: taskResponse.warning }
                : {}),
              ...(!taskResponse
                ? {
                    warning: 'Host response timed out; used snapshot fallback.',
                  }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'wait_for_plan_feedback',
  'Wait for user feedback events (approve/reject/edit) on a specific plan.',
  {
    plan_id: z.string(),
    timeout_ms: z.number().int().min(1000).max(900000).optional(),
  },
  async (args) => {
    const timeoutMs = args.timeout_ms ?? 300_000;
    const events = await waitForPlanEvents(args.plan_id, timeoutMs);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ planId: args.plan_id, events }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'get_plan',
  'Get the current state of a plan from host snapshots.',
  {
    plan_id: z.string(),
  },
  async (args) => {
    const plan = findPlanInSnapshot(args.plan_id);
    if (!plan) {
      return {
        content: [{ type: 'text' as const, text: 'Plan not found.' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(plan, null, 2) }],
    };
  },
);

server.tool(
  'service_restart',
  'Restart the MyClaw service with config validation. Main agent only. If validation fails, returns actionable errors so you can correct settings and retry.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main agent can restart the service.',
          },
        ],
        isError: true,
      };
    }

    const taskId = `service-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'service_restart',
      taskId,
      timestamp: new Date().toISOString(),
    });

    const response = await waitForTaskResponse(taskId, 20_000);
    if (!response) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Service restart requested, but host response timed out.',
          },
        ],
        isError: true,
      };
    }

    if (!response.ok) {
      const lines = [
        response.error || 'Service restart failed.',
        ...(response.details && response.details.length > 0
          ? response.details.map((item) => `- ${item}`)
          : []),
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: response.message || 'Service restart completed.',
        },
      ],
    };
  },
);

server.tool(
  'register_agent',
  `Register a new chat/channel agent so MyClaw can respond to messages there. Main agent only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the agent'),
    folder: z
      .string()
      .describe('Channel-prefixed folder name (e.g., "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main agent can register new agents.',
          },
        ],
        isError: true,
      };
    }

    const taskId = `register-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'register_agent',
      taskId,
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const response = await waitForTaskResponse(taskId, 15_000);
    if (!response) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Agent registration requested, but host response timed out.',
          },
        ],
        isError: true,
      };
    }
    if (!response.ok) {
      const lines = [
        response.error || 'Agent registration failed.',
        ...(response.details && response.details.length > 0
          ? response.details.map((item) => `- ${item}`)
          : []),
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text:
            response.message ||
            `Agent "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
