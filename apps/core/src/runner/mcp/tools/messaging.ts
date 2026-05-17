import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  groupFolder,
  IPC_AUTH_TOKEN,
  IPC_DIR,
  IPC_RESPONSE_KEY_ID,
  MESSAGES_DIR,
  threadId,
} from '../context.js';
import { truncateText } from '../formatting.js';
import { hasValidIpcResponseSignature, writeIpcFile } from '../ipc.js';
import { createSignedIpcRequestEnvelope } from '../signing.js';
import { makeIpcId } from '../ipc-ids.js';

const USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const USER_QUESTION_POLL_INTERVAL_MS = 100;
const USER_QUESTION_MAX_ANSWER_LENGTH = 500;
const USER_QUESTION_MAX_ANSWERED_BY_LENGTH = 120;
const INTERACTION_BOUNDARY_WAIT_MS = 2_000;

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

export function registerMessagingTools(server: McpServer): void {
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
      _context?: {
        signal?: AbortSignal;
      },
    ) => {
      const data: Record<string, string | undefined> = {
        type: 'message',
        chatJid,
        text: args.text,
        sender: args.sender || undefined,
        groupFolder,
        timestamp: nowIso(),
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
        sourceAgentFolder: groupFolder,
        questions: args.questions,
        context: {
          ...(appId ? { appId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(threadId ? { threadId } : {}),
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
                text: 'Question cancelled before an answer was received.',
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
                text: 'Question cancelled before an answer was received.',
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
            text: 'Question timed out — no answer received within 5 minutes.',
          },
        ],
      };
    },
  );
}
