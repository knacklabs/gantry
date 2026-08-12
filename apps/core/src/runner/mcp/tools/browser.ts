import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserBackendAction } from '../../../shared/browser-backend-actions.js';
import { z } from 'zod';
import { formatBrowserToolResponse } from '../formatting.js';
import { requestBrowserAction } from '../ipc.js';
import { formatOperatorError } from '../../../shared/operator-error.js';
import { createHash, randomUUID } from 'node:crypto';
import { nowMs } from '../../../shared/time/datetime.js';
import fs from 'node:fs';

type BrowserToolSchema = Record<string, z.ZodTypeAny>;
type PublicBrowserToolName =
  | 'browser_status'
  | 'browser_open'
  | 'browser_inspect'
  | 'browser_act'
  | 'browser_captcha_challenge'
  | 'browser_captcha_settle'
  | 'browser_close';
type BrowserMcpToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  file?: { path?: string; mimeType?: string; sizeBytes?: number };
  isError?: boolean;
  [key: string]: unknown;
};
type BrowserProfile = 'basic' | 'full' | undefined;
type BrowserInspectMode =
  | 'snapshot'
  | 'tabs'
  | 'screenshot'
  | 'console_messages'
  | 'network_requests';
type BrowserActAction =
  | 'navigate'
  | 'back'
  | 'tab_new'
  | 'tab_select'
  | 'tab_close'
  | 'click'
  | 'type'
  | 'wait_for'
  | 'screenshot'
  | 'evaluate'
  | 'press_key'
  | 'hover'
  | 'drag'
  | 'drop'
  | 'select_option'
  | 'fill_form'
  | 'file_upload'
  | 'file_attach'
  | 'handle_dialog'
  | 'resize';

const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 120_000;
const MAX_CAPTCHA_TTL_MS = 10 * 60_000;
const captchaChallenges = new Map<
  string,
  {
    jobId?: string;
    runId?: string;
    origin: string;
    inputTarget: string;
    submitTarget?: string;
    submitWithEnter: boolean;
    expiresAt: number;
  }
>();
const FULL_INSPECT_MODES = new Set<BrowserInspectMode>([
  'console_messages',
  'network_requests',
]);
const FULL_ACT_ACTIONS = new Set<BrowserActAction>([
  'evaluate',
  'press_key',
  'hover',
  'drag',
  'drop',
  'select_option',
  'fill_form',
  'file_upload',
  'file_attach',
  'handle_dialog',
  'resize',
]);

function formatBrowserFailure(action: string, error: string | undefined) {
  return {
    content: [
      {
        type: 'text' as const,
        text: formatOperatorError({
          summary: 'Browser action failed.',
          cause: `${action}: ${error || 'unknown error'}`,
          recover: 'run gantry status and retry after the browser is ready.',
        }),
      },
    ],
    isError: true,
  };
}

function browserTimeoutMs(args: Record<string, unknown>): number {
  const raw = args.timeout_ms;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_BROWSER_TOOL_TIMEOUT_MS;
  }
  return Math.max(
    1_000,
    Math.min(DEFAULT_BROWSER_TOOL_TIMEOUT_MS, Math.trunc(raw)),
  );
}

async function callBrowserBackend(
  publicToolName: PublicBrowserToolName,
  action: BrowserBackendAction,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<BrowserMcpToolResult> {
  const response = await requestBrowserAction(action, payload, {
    timeoutMs,
    publicToolName,
  });
  if (!response.ok) return formatBrowserFailure(action, response.error);
  if (isBrowserMcpResult(response.data)) {
    return response.data;
  }
  return {
    content: [
      { type: 'text' as const, text: formatBrowserToolResponse(response) },
    ],
  };
}

function isBrowserMcpResult(value: unknown): value is BrowserMcpToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content);
}

function requireFullProfile(input: {
  publicToolName: PublicBrowserToolName;
  profile: BrowserProfile;
  reason: unknown;
}): BrowserMcpToolResult | null {
  if (
    input.profile === 'full' &&
    typeof input.reason === 'string' &&
    input.reason.trim()
  ) {
    return null;
  }
  return formatBrowserFailure(
    input.publicToolName,
    'profile="full" and a non-empty reason are required for this browser operation',
  );
}

function register(
  server: McpServer,
  name: PublicBrowserToolName,
  description: string,
  schema: BrowserToolSchema,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
): void {
  server.tool(
    name,
    `${description} Uses the host-derived Gantry browser profile. Add timeout_ms only to change the IPC/backend deadline.`,
    { ...schema, timeout_ms: z.number().optional() },
    async (args) => (await handler(args)) as never,
  );
}

const profile = z
  .enum(['basic', 'full'])
  .optional()
  .describe('Use full only for higher-risk browser inspection or actions.');
const reason = z
  .string()
  .optional()
  .describe('Required with profile="full" for higher-risk browser operations.');
const fileName = z
  .string()
  .optional()
  .describe('Relative file name under the run browser artifact root.');
const target = z
  .string()
  .optional()
  .describe(
    'Target handle from the latest browser inspection, or a unique selector.',
  );
const payload = z
  .record(z.string(), z.unknown())
  .describe('Action-specific payload for the selected compact browser action.');
const recipeIntent = z
  .enum([
    'listing',
    'pagination',
    'filter',
    'detail',
    'document',
    'modal_close',
    'captcha',
  ])
  .optional()
  .describe(
    'Required for state-changing controls in recipe-authoring jobs; describes the bounded tender-navigation purpose.',
  );
const inspectMode = z.enum([
  'snapshot',
  'tabs',
  'screenshot',
  'console_messages',
  'network_requests',
]);
const actAction = z.enum([
  'navigate',
  'back',
  'tab_new',
  'tab_select',
  'tab_close',
  'click',
  'type',
  'wait_for',
  'screenshot',
  'evaluate',
  'press_key',
  'hover',
  'drag',
  'drop',
  'select_option',
  'fill_form',
  'file_upload',
  'file_attach',
  'handle_dialog',
  'resize',
]);

export function registerBrowserTools(server: McpServer): void {
  register(
    server,
    'browser_status',
    'Inspect browser status without launching Chrome.',
    {},
    async (args) =>
      callBrowserBackend(
        'browser_status',
        'status',
        {},
        browserTimeoutMs(args),
      ),
  );

  register(
    server,
    'browser_open',
    'Launch or reuse the headed browser profile, then optionally navigate.',
    {
      url: z.string().optional(),
      keep_alive_ms: z.number().optional(),
    },
    async (args) => {
      const timeoutMs = browserTimeoutMs(args);
      const openPayload =
        typeof args.keep_alive_ms === 'number'
          ? { keep_alive_ms: args.keep_alive_ms }
          : {};
      const openResult = await callBrowserBackend(
        'browser_open',
        'open',
        openPayload,
        timeoutMs,
      );
      if (isBrowserErrorResult(openResult) || typeof args.url !== 'string') {
        return openResult;
      }
      return callBrowserBackend(
        'browser_open',
        'navigate',
        { url: args.url },
        timeoutMs,
      );
    },
  );

  register(
    server,
    'browser_inspect',
    'Inspect the current browser state through compact public modes.',
    {
      mode: inspectMode,
      profile,
      target,
      filename: fileName,
      reason,
    },
    async (args) => {
      const mode = args.mode as BrowserInspectMode;
      if (FULL_INSPECT_MODES.has(mode)) {
        const failure = requireFullProfile({
          publicToolName: 'browser_inspect',
          profile: args.profile as BrowserProfile,
          reason: args.reason,
        });
        if (failure) return failure;
      }
      return callBrowserBackend(
        'browser_inspect',
        inspectBackendAction(mode),
        inspectBackendPayload(mode, args),
        browserTimeoutMs(args),
      );
    },
  );

  register(
    server,
    'browser_act',
    'Perform a compact public browser action.',
    {
      action: actAction,
      profile,
      payload,
      recipe_intent: recipeIntent,
      reason,
    },
    async (args) => {
      const action = args.action as BrowserActAction;
      if (FULL_ACT_ACTIONS.has(action)) {
        const failure = requireFullProfile({
          publicToolName: 'browser_act',
          profile: args.profile as BrowserProfile,
          reason: args.reason,
        });
        if (failure) return failure;
      }
      const actionPayload =
        args.payload && typeof args.payload === 'object'
          ? (args.payload as Record<string, unknown>)
          : {};
      if (typeof args.recipe_intent === 'string') {
        actionPayload.recipe_intent = args.recipe_intent;
      }
      return callBrowserBackend(
        'browser_act',
        actBackendAction(action),
        actBackendPayload(action, actionPayload),
        browserTimeoutMs(args),
      );
    },
  );

  register(
    server,
    'browser_close',
    'Close the browser profile session.',
    {},
    async (args) =>
      callBrowserBackend('browser_close', 'close', {}, browserTimeoutMs(args)),
  );

  register(
    server,
    'browser_captcha_challenge',
    'Capture a CAPTCHA challenge from the active page and bind a short-lived settlement to this job, run, and origin. Use the returned image with the current vision-capable model.',
    {
      image_target: z.string(),
      input_target: z.string(),
      submit_target: z.string().optional(),
      submit_with_enter: z.boolean().optional(),
      ttl_ms: z.number().int().min(10_000).max(MAX_CAPTCHA_TTL_MS).optional(),
    },
    async (args) => {
      const timeoutMs = browserTimeoutMs(args);
      const page = await callBrowserBackend(
        'browser_captcha_challenge',
        'snapshot',
        {},
        timeoutMs,
      );
      if (isBrowserErrorResult(page)) return page;
      const origin = browserResultOrigin(page);
      if (!origin) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'the active page origin could not be verified',
        );
      }
      const screenshot = await callBrowserBackend(
        'browser_captcha_challenge',
        'screenshot',
        { target: args.image_target },
        timeoutMs,
      );
      if (isBrowserErrorResult(screenshot)) return screenshot;
      const image = captchaImageContent(screenshot);
      if (!image) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'the captured challenge image could not be loaded',
        );
      }
      const challengeId = `captcha_${randomUUID()}`;
      const expiresAt =
        nowMs() +
        Math.min(
          MAX_CAPTCHA_TTL_MS,
          typeof args.ttl_ms === 'number' ? args.ttl_ms : 120_000,
        );
      captchaChallenges.set(challengeId, {
        jobId: currentJobId(),
        runId: currentJobRunId(),
        origin,
        inputTarget: String(args.input_target),
        ...(typeof args.submit_target === 'string'
          ? { submitTarget: args.submit_target }
          : {}),
        submitWithEnter: args.submit_with_enter === true,
        expiresAt,
      });
      const fingerprint = createHash('sha256')
        .update(`${origin}\0${String(args.image_target)}\0${image.data}`)
        .digest('hex');
      return {
        content: [
          {
            type: 'text' as const,
            text: `CAPTCHA challenge ${challengeId}\nOrigin: ${origin}\nFingerprint: ${fingerprint}\nExpires: ${new Date(expiresAt).toISOString()}`,
          },
          image,
        ],
      };
    },
  );

  register(
    server,
    'browser_captcha_settle',
    'Apply one model- or human-supplied CAPTCHA answer to its bound active browser challenge. The answer is ephemeral and never checkpointed.',
    {
      challenge_id: z.string(),
      answer: z.string().min(1).max(512),
    },
    async (args) => {
      const challengeId = String(args.challenge_id);
      const challenge = captchaChallenges.get(challengeId);
      captchaChallenges.delete(challengeId);
      if (
        !challenge ||
        challenge.expiresAt <= nowMs() ||
        challenge.jobId !== currentJobId() ||
        challenge.runId !== currentJobRunId()
      ) {
        return formatBrowserFailure(
          'browser_captcha_settle',
          'the CAPTCHA challenge is missing, expired, or belongs to another run',
        );
      }
      const timeoutMs = browserTimeoutMs(args);
      const page = await callBrowserBackend(
        'browser_captcha_settle',
        'snapshot',
        {},
        timeoutMs,
      );
      if (browserResultOrigin(page) !== challenge.origin) {
        return formatBrowserFailure(
          'browser_captcha_settle',
          'the active page origin changed after the challenge was captured',
        );
      }
      const typed = await callBrowserBackend(
        'browser_captcha_settle',
        'type',
        {
          target: challenge.inputTarget,
          text: String(args.answer),
          submit: challenge.submitWithEnter && !challenge.submitTarget,
        },
        timeoutMs,
      );
      if (isBrowserErrorResult(typed) || !challenge.submitTarget) return typed;
      return callBrowserBackend(
        'browser_captcha_settle',
        'click',
        { target: challenge.submitTarget },
        timeoutMs,
      );
    },
  );
}

function browserResultOrigin(result: BrowserMcpToolResult): string | null {
  const text = result.content
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n');
  const match = /^URL:\s*(\S+)/mu.exec(text);
  try {
    return match?.[1] ? new URL(match[1]).origin : null;
  } catch {
    return null;
  }
}

function captchaImageContent(
  result: BrowserMcpToolResult,
): { type: 'image'; data: string; mimeType: string } | null {
  const inline = result.content.find((item) => item.type === 'image');
  if (inline?.type === 'image') return inline;
  const filePath = result.file?.path;
  const mimeType = result.file?.mimeType;
  if (
    typeof filePath !== 'string' ||
    typeof mimeType !== 'string' ||
    !mimeType.startsWith('image/')
  ) {
    return null;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
    return {
      type: 'image',
      data: fs.readFileSync(filePath).toString('base64'),
      mimeType,
    };
  } catch {
    return null;
  }
}

function currentJobId() {
  return process.env.GANTRY_JOB_ID?.trim() || undefined;
}

function currentJobRunId() {
  return process.env.GANTRY_JOB_RUN_ID?.trim() || undefined;
}

function isBrowserErrorResult(value: unknown): value is { isError: true } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { isError?: unknown }).isError === true,
  );
}

function inspectBackendAction(mode: BrowserInspectMode): BrowserBackendAction {
  switch (mode) {
    case 'snapshot':
      return 'snapshot';
    case 'tabs':
      return 'tabs';
    case 'screenshot':
      return 'screenshot';
    case 'console_messages':
      return 'console_messages';
    case 'network_requests':
      return 'network_requests';
  }
}

function inspectBackendPayload(
  mode: BrowserInspectMode,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (mode === 'tabs') return { action: 'list' };
  const payload: Record<string, unknown> = {};
  if (typeof args.target === 'string') payload.target = args.target;
  if (typeof args.filename === 'string') payload.filename = args.filename;
  return payload;
}

function actBackendAction(action: BrowserActAction): BrowserBackendAction {
  switch (action) {
    case 'navigate':
      return 'navigate';
    case 'back':
      return 'back';
    case 'tab_new':
    case 'tab_select':
    case 'tab_close':
      return 'tabs';
    case 'click':
      return 'click';
    case 'type':
      return 'type';
    case 'wait_for':
      return 'wait_for';
    case 'screenshot':
      return 'screenshot';
    case 'evaluate':
      return 'evaluate';
    case 'press_key':
      return 'press_key';
    case 'hover':
      return 'hover';
    case 'drag':
      return 'drag';
    case 'drop':
      return 'drop';
    case 'select_option':
      return 'select_option';
    case 'fill_form':
      return 'fill_form';
    case 'file_upload':
      return 'file_upload';
    case 'file_attach':
      return 'file_attach';
    case 'handle_dialog':
      return 'handle_dialog';
    case 'resize':
      return 'resize';
  }
}

function actBackendPayload(
  action: BrowserActAction,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (action) {
    case 'back':
      return {};
    case 'tab_new':
      return { ...payload, action: 'new' };
    case 'tab_select':
      return { ...payload, action: 'select' };
    case 'tab_close':
      return { ...payload, action: 'close' };
    default:
      return payload;
  }
}
