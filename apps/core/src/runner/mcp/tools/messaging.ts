import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import {
  nowIso,
  nowMs,
  nowMs as currentTimeMs,
  sleep,
} from '../../../shared/time/datetime.js';
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../../../shared/private-fs.js';
import {
  agentId,
  appId,
  chatJid,
  providerAccountId,
  workspaceFolder,
  IPC_AUTH_TOKEN,
  IPC_DIR,
  IPC_RESPONSE_KEY_ID,
  MESSAGES_DIR,
  threadId,
  jobId,
  jobRunId,
  jobRunLeaseToken,
  jobRunLeaseFencingVersion,
} from '../context.js';
import { truncateText } from '../formatting.js';
import { hasValidIpcResponseSignature, writeIpcFile } from '../ipc.js';
import { createSignedIpcRequestEnvelope } from '../../../shared/ipc-signing.js';
import { makeIpcId } from '../ipc-ids.js';

const USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const USER_QUESTION_POLL_INTERVAL_MS = 100;
const USER_QUESTION_MAX_ANSWER_LENGTH = 500;
const USER_QUESTION_MAX_ANSWERED_BY_LENGTH = 120;
const INTERACTION_BOUNDARY_WAIT_MS = 2_000;

const fallbackTextSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Required plain-text fallback for clients that cannot render rich UI',
  );
const richTitleSchema = z.string().trim().min(1).max(200);
const richScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const richFactSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(2000),
  })
  .strict();
const richListItemSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    detail: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
const richTableColumnSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
  })
  .strict();
const richFormFieldSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    type: z.enum(['text', 'textarea']),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();
const richMediaItemSchema = z
  .object({
    url: z.string().trim().min(1).max(2000),
    alt: z.string().trim().min(1).max(200).optional(),
    caption: z.string().trim().min(1).max(500).optional(),
    mime_type: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

type RichInteractionKind =
  | 'status'
  | 'facts'
  | 'list'
  | 'table'
  | 'form'
  | 'media'
  | 'progress';

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

async function requestUserInteractionBoundary(
  requestId: string,
  signal?: AbortSignal,
): Promise<void> {
  const boundaryDir = path.join(IPC_DIR, 'interaction-boundaries');
  ensurePrivateDirSync(boundaryDir);
  const boundaryPath = path.join(boundaryDir, `${requestId}.json`);
  const tmpPath = `${boundaryPath}.tmp`;
  writePrivateFileSync(
    tmpPath,
    JSON.stringify(
      {
        type: 'user_interaction',
        requestId,
        tool: 'ask_user_question',
        timestamp: nowIso(),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, boundaryPath);

  const deadline = nowMs() + INTERACTION_BOUNDARY_WAIT_MS;
  while (nowMs() < deadline) {
    if (!fs.existsSync(boundaryPath)) return;
    const aborted = await sleepWithAbort(
      USER_QUESTION_POLL_INTERVAL_MS,
      signal,
    );
    if (aborted) return;
  }
}

function richInteractionContext(): Record<string, unknown> {
  return {
    ...(appId ? { appId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(chatJid ? { chatJid } : {}),
    ...(threadId ? { threadId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(jobRunId ? { runId: jobRunId } : {}),
    ...(jobRunLeaseToken ? { runLeaseToken: jobRunLeaseToken } : {}),
    ...(jobRunLeaseFencingVersion
      ? { runLeaseFencingVersion: Number(jobRunLeaseFencingVersion) }
      : {}),
    ...(IPC_RESPONSE_KEY_ID ? { responseKeyId: IPC_RESPONSE_KEY_ID } : {}),
  };
}

function writeRichInteractionRequest(
  kind: RichInteractionKind,
  title: string,
  fallbackText: string,
  payload: Record<string, unknown>,
): boolean {
  if (jobId) return false;
  const requestId = makeIpcId('rich');
  writeIpcFile(path.join(IPC_DIR, 'rich-interactions'), {
    type: 'rich_interaction',
    requestId,
    sourceAgentFolder: workspaceFolder,
    chatJid,
    interaction: {
      id: requestId,
      title,
      fallbackText,
      rich: { kind, fallbackText, payload },
    },
    context: richInteractionContext(),
    nonce: randomUUID(),
    expiresAt: new Date(currentTimeMs() + 5 * 60_000).toISOString(),
    timestamp: nowIso(),
  });
  return true;
}

function richInteractionQueuedText(queued: boolean, form = false): string {
  if (!queued) return 'Rich interaction skipped for scheduled job.';
  return form ? 'Form queued.' : 'Rich interaction queued.';
}

function registerRichInteractionTools(server: McpServer): void {
  server.tool(
    'render_status',
    'Render a compact status view in the active conversation.',
    {
      title: richTitleSchema,
      status: z.enum(['info', 'success', 'warning', 'error']),
      body: z.string().trim().min(1).max(4000).optional(),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'status',
        args.title,
        args.fallback_text,
        {
          status: args.status,
          ...(args.body ? { body: args.body } : {}),
        },
      );
      return {
        content: [
          { type: 'text' as const, text: richInteractionQueuedText(queued) },
        ],
      };
    },
  );

  server.tool(
    'render_facts',
    'Render labeled facts in the active conversation.',
    {
      title: richTitleSchema,
      facts: z.array(richFactSchema).min(1).max(20),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'facts',
        args.title,
        args.fallback_text,
        {
          facts: args.facts,
        },
      );
      return {
        content: [
          { type: 'text' as const, text: richInteractionQueuedText(queued) },
        ],
      };
    },
  );

  server.tool(
    'render_list',
    'Render an ordered or unordered list in the active conversation.',
    {
      title: richTitleSchema,
      ordered: z.boolean().optional(),
      items: z.array(richListItemSchema).min(1).max(30),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'list',
        args.title,
        args.fallback_text,
        {
          ordered: Boolean(args.ordered),
          items: args.items,
        },
      );
      return {
        content: [
          { type: 'text' as const, text: richInteractionQueuedText(queued) },
        ],
      };
    },
  );

  server.tool(
    'render_table',
    'Render a small data table in the active conversation.',
    {
      title: richTitleSchema,
      columns: z.array(richTableColumnSchema).min(1).max(10),
      rows: z.array(z.record(z.string(), richScalarSchema)).min(1).max(20),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'table',
        args.title,
        args.fallback_text,
        {
          columns: args.columns,
          rows: args.rows,
        },
      );
      return {
        content: [
          { type: 'text' as const, text: richInteractionQueuedText(queued) },
        ],
      };
    },
  );

  server.tool(
    'render_form',
    'Render a form in the active conversation. Form submission is non-blocking in this runtime version.',
    {
      title: richTitleSchema,
      fields: z.array(richFormFieldSchema).min(1).max(10),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'form',
        args.title,
        args.fallback_text,
        {
          fields: args.fields,
        },
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: richInteractionQueuedText(queued, true),
          },
        ],
      };
    },
  );

  server.tool(
    'render_media',
    'Render media references in the active conversation.',
    {
      title: richTitleSchema,
      items: z.array(richMediaItemSchema).min(1).max(10),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'media',
        args.title,
        args.fallback_text,
        {
          items: args.items,
        },
      );
      return {
        content: [
          { type: 'text' as const, text: richInteractionQueuedText(queued) },
        ],
      };
    },
  );

  server.tool(
    'render_progress',
    'Render one compact progress line for a user-visible workflow. Repeated calls edit the active line in place; use it before and between meaningful steps of long installs, dependency setup, and renders.',
    {
      title: richTitleSchema,
      value: z.number().min(0).max(100).optional(),
      label: z.string().trim().min(1).max(200).optional(),
      done: z.boolean().optional(),
      fallback_text: fallbackTextSchema,
    },
    async (args) => {
      const queued = writeRichInteractionRequest(
        'progress',
        args.title,
        args.fallback_text,
        {
          ...(typeof args.value === 'number' ? { value: args.value } : {}),
          ...(args.label ? { label: args.label } : {}),
          done: Boolean(args.done),
        },
      );
      return {
        content: [
          { type: 'text' as const, text: richInteractionQueuedText(queued) },
        ],
      };
    },
  );
}

export function registerMessagingTools(server: McpServer): void {
  server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. Use this for live progress updates or to send multiple messages. In scheduled jobs, the scheduler sends the completion notification, so do not use this for job results.",
    {
      text: z.string().describe('The message text to send'),
      files: z
        .array(
          z.object({
            scope: z.string().optional().describe('FileArtifact scope'),
            path: z.string().describe('FileArtifact virtual path'),
            version: z.number().int().positive().optional(),
          }),
        )
        .max(5)
        .optional()
        .describe(
          'Owned FileArtifacts to send with the message. Gantry resolves ownership in the host and degrades safely when the channel cannot attach files.',
        ),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
        ),
    },
    async (
      args,
      _context?: {
        signal?: AbortSignal;
      },
    ) => {
      if (jobId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduled job message suppressed. The scheduler will send one completion notification when the job finishes.',
            },
          ],
        };
      }
      const data: Record<string, unknown> = {
        type: 'message',
        chatJid,
        text: args.text,
        sender: args.sender || undefined,
        providerAccountId,
        workspaceFolder,
        timestamp: nowIso(),
        files: args.files,
      };

      writeIpcFile(MESSAGES_DIR, data);

      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    },
  );

  registerRichInteractionTools(server);

  server.tool(
    'ask_user_question',
    'Ask the user a structured multiple-choice question across the active channel. Use when you need the user to pick between discrete options (e.g. which database, which approach, which config). Returns the selected option(s).',
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
              .describe(
                'Short label displayed as tag, e.g. "Deploy", "Config"',
              ),
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
      ensurePrivateDirSync(userQuestionRequestsDir);
      ensurePrivateDirSync(userQuestionResponsesDir);

      const requestId = makeIpcId('userq');
      const requestPath = path.join(
        userQuestionRequestsDir,
        `${requestId}.json`,
      );
      const responsePath = path.join(
        userQuestionResponsesDir,
        `${requestId}.json`,
      );
      const tmpPath = `${requestPath}.tmp`;

      await requestUserInteractionBoundary(requestId, context?.signal);

      const payload = {
        requestId,
        sourceAgentFolder: workspaceFolder,
        questions: args.questions,
        context: {
          ...(appId ? { appId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(providerAccountId ? { providerAccountId } : {}),
          ...(chatJid ? { chatJid } : {}),
          ...(threadId ? { threadId } : {}),
          ...(jobId ? { jobId } : {}),
          ...(jobRunId ? { runId: jobRunId } : {}),
          ...(jobRunLeaseToken ? { runLeaseToken: jobRunLeaseToken } : {}),
          ...(jobRunLeaseFencingVersion
            ? { runLeaseFencingVersion: Number(jobRunLeaseFencingVersion) }
            : {}),
          ...(IPC_RESPONSE_KEY_ID
            ? { responseKeyId: IPC_RESPONSE_KEY_ID }
            : {}),
        },
        timestamp: nowIso(),
        expiresAt: new Date(
          currentTimeMs() + USER_QUESTION_TIMEOUT_MS,
        ).toISOString(),
      };
      const envelope = createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, payload);

      writePrivateFileSync(tmpPath, JSON.stringify(envelope, null, 2));
      fs.renameSync(tmpPath, requestPath);

      const deadline = nowMs() + USER_QUESTION_TIMEOUT_MS;
      while (nowMs() < deadline) {
        if (context?.signal?.aborted) {
          fs.rmSync(requestPath, { force: true });
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Question cancelled. Nothing changed.',
              },
            ],
          };
        }
        if (fs.existsSync(responsePath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
              requestId?: unknown;
              answers?: Record<string, unknown>;
              answeredBy?: unknown;
              signature?: unknown;
            };
            fs.unlinkSync(responsePath);
            const payload: Record<string, unknown> = {
              requestId,
              answers:
                raw?.answers && typeof raw.answers === 'object'
                  ? raw.answers
                  : {},
              ...(typeof raw?.answeredBy === 'string' && raw.answeredBy.trim()
                ? { answeredBy: raw.answeredBy }
                : {}),
            };
            if (raw.requestId !== requestId) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Answer request id mismatch.',
                  },
                ],
              };
            }
            if (
              !hasValidIpcResponseSignature(
                raw as unknown as Record<string, unknown>,
                payload,
              )
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Answer verification failed.',
                  },
                ],
              };
            }
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
          fs.rmSync(requestPath, { force: true });
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Question cancelled. Nothing changed.',
              },
            ],
          };
        }
      }
      fs.rmSync(requestPath, { force: true });
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Question expired. Please ask again if this is still needed.',
          },
        ],
      };
    },
  );
}
