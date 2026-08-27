import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserBackendAction } from '../../../shared/browser-backend-actions.js';
import { z } from 'zod';
import { formatBrowserToolResponse } from '../formatting.js';
import { requestBrowserAction, requestCaptchaVisionAction } from '../ipc.js';
import { formatOperatorError } from '../../../shared/operator-error.js';
import { createHash, randomUUID } from 'node:crypto';
import { nowMs } from '../../../shared/time/datetime.js';
import fs from 'node:fs';
import { handleFileToolAction } from './file.js';
import { jobArtifactScope } from '../../../domain/ports/job-semantic-checkpoints.js';

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

const MAX_BROWSER_TOOL_TIMEOUT_MS = 120_000;
// Use the backend's full supported budget by default. Slow public sites must
// not require the probabilistic model to remember a timeout override.
const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = MAX_BROWSER_TOOL_TIMEOUT_MS;
const MAX_CAPTCHA_TTL_MS = 30 * 60_000;
const CAPTCHA_IMAGE_FALLBACK_SELECTOR =
  'img[src*="captcha" i],img[src^="data:image" i],img[id*="captcha" i],img[class*="captcha" i],img[alt*="captcha" i],img[title*="captcha" i],canvas[id*="captcha" i],canvas[class*="captcha" i],svg[id*="captcha" i],svg[class*="captcha" i],input[type="image"][src*="captcha" i],[style*="background-image" i][id*="captcha" i],[style*="background-image" i][class*="captcha" i]';
const MAX_AUTOMATIC_CAPTCHA_ATTEMPTS = 4;
const CAPTCHA_BROWSER_ACTION_TIMEOUT_MS = 30_000;
const CAPTCHA_SUCCESS_PROOF_TIMEOUT_MS = 45_000;
const CAPTCHA_SUCCESS_PROOF_POLL_MS = 1_500;
const CAPTCHA_REFRESH_CAPTURE_TIMEOUT_MS = CAPTCHA_BROWSER_ACTION_TIMEOUT_MS;
const DURABLE_CAPTCHA_TARGET_EVALUATOR = [
  '(element) => {',
  'const doc = element.ownerDocument;',
  'const css = globalThis.CSS;',
  "const escapeCss = (value) => css?.escape ? css.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character);",
  "const escapeAttribute = (value) => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\"');",
  'const tag = element.tagName.toLowerCase();',
  'const unique = (selector) => { try { return doc.querySelectorAll(selector).length === 1; } catch { return false; } };',
  'const candidates = [];',
  "if (element.id) candidates.push('#' + escapeCss(element.id));",
  "for (const attribute of ['name', 'aria-label', 'placeholder', 'title', 'alt', 'src']) { const value = element.getAttribute(attribute); if (value) candidates.push(tag + '[' + attribute + '=\"' + escapeAttribute(value) + '\"]'); }",
  "const type = element.getAttribute('type');",
  "const value = element.getAttribute('value');",
  "if (type && value) candidates.push(tag + '[type=\"' + escapeAttribute(type) + '\"][value=\"' + escapeAttribute(value) + '\"]');",
  "if (type) candidates.push(tag + '[type=\"' + escapeAttribute(type) + '\"]');",
  'for (const candidate of candidates) { if (unique(candidate)) return candidate; }',
  'const path = [];',
  'let current = element;',
  'while (current && current.nodeType === 1 && current !== doc.documentElement) {',
  'const currentTag = current.tagName.toLowerCase();',
  'const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current.tagName);',
  "path.unshift(currentTag + ':nth-of-type(' + Math.max(1, siblings.indexOf(current) + 1) + ')');",
  "const selector = path.join(' > ');",
  'if (unique(selector)) return selector;',
  'current = current.parentElement;',
  '}',
  'return null;',
  '}',
].join('\n');

function captchaControlDiscoveryEvaluator(
  preferredInputTarget: string,
  preferredSubmitTarget?: string,
): string {
  return [
    '(image) => {',
    'const doc = image.ownerDocument;',
    'const preferredInputSelector = ' +
      JSON.stringify(preferredInputTarget) +
      ';',
    'const preferredSubmitSelector = ' +
      JSON.stringify(preferredSubmitTarget ?? '') +
      ';',
    'const css = globalThis.CSS;',
    "const escapeCss = (value) => css?.escape ? css.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character);",
    "const escapeAttribute = (value) => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\"');",
    'const unique = (selector) => { try { return doc.querySelectorAll(selector).length === 1; } catch { return false; } };',
    'const selectorFor = (element) => {',
    'const tag = element.tagName.toLowerCase(); const candidates = [];',
    "if (element.id) candidates.push('#' + escapeCss(element.id));",
    "for (const attribute of ['name', 'aria-label', 'placeholder', 'title', 'value']) { const value = element.getAttribute(attribute); if (value) candidates.push(tag + '[' + attribute + '=\"' + escapeAttribute(value) + '\"]'); }",
    "const type = element.getAttribute('type'); if (type) candidates.push(tag + '[type=\"' + escapeAttribute(type) + '\"]');",
    'for (const candidate of candidates) { if (unique(candidate)) return candidate; }',
    'const path = []; let current = element;',
    'while (current && current.nodeType === 1 && current !== doc.documentElement) {',
    'const currentTag = current.tagName.toLowerCase(); const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current.tagName);',
    "path.unshift(currentTag + ':nth-of-type(' + Math.max(1, siblings.indexOf(current) + 1) + ')'); const selector = path.join(' > '); if (unique(selector)) return selector; current = current.parentElement;",
    '} return null; };',
    "const visible = (element) => { if (!element) return false; const style = element.ownerDocument.defaultView?.getComputedStyle(element); const rect = element.getBoundingClientRect(); return !element.hidden && style?.display !== 'none' && style?.visibility !== 'hidden' && Number(style?.opacity ?? 1) !== 0 && rect.width > 0 && rect.height > 0; };",
    "const editable = (element) => { if (!element || !visible(element) || element.hasAttribute('disabled') || element.hasAttribute('readonly')) return false; if (element.tagName.toLowerCase() === 'textarea') return true; if (element.tagName.toLowerCase() !== 'input') return false; const type = (element.getAttribute('type') || 'text').toLowerCase(); return ['text', 'search', 'tel', 'number', 'password'].includes(type); };",
    "const submit = (element) => { if (!element || !visible(element) || element.hasAttribute('disabled')) return false; const tag = element.tagName.toLowerCase(); const type = (element.getAttribute('type') || '').toLowerCase(); return tag === 'button' || (tag === 'input' && ['submit', 'button', 'image'].includes(type)); };",
    'const safeQuery = (selector) => { try { return selector ? doc.querySelector(selector) : null; } catch { return null; } };',
    "const form = image.closest('form'); const scope = form ?? image.parentElement ?? doc; const imageRect = image.getBoundingClientRect();",
    "const descriptor = (element) => ['id', 'name', 'placeholder', 'aria-label', 'title'].map((attribute) => element.getAttribute(attribute) || '').join(' ').toLowerCase();",
    'const distance = (element) => { const rect = element.getBoundingClientRect(); return Math.hypot((rect.left + rect.width / 2) - (imageRect.left + imageRect.width / 2), (rect.top + rect.height / 2) - (imageRect.top + imageRect.height / 2)); };',
    'const preferredInput = safeQuery(preferredInputSelector);',
    "let inputCandidates = Array.from(scope.querySelectorAll('input,textarea')).filter(editable);",
    "if (inputCandidates.length === 0 && scope !== doc) inputCandidates = Array.from(doc.querySelectorAll('input,textarea')).filter(editable);",
    'const inputScore = (element) => { const text = descriptor(element); let value = element === preferredInput ? 50 : 0; if (/captcha/.test(text)) value += 1000; if (/verification|verify|security/.test(text)) value += 500; if (/code|answer/.test(text)) value += 250; if (/search|tender|published|date/.test(text)) value -= 500; value -= Math.min(distance(element), 1000) / 10; return value; };',
    'inputCandidates.sort((left, right) => inputScore(right) - inputScore(left)); const input = inputCandidates[0] ?? null;',
    "if (!editable(input)) return { error: 'no visible editable CAPTCHA input could be found near the challenge image' };",
    'const preferredSubmit = safeQuery(preferredSubmitSelector);',
    // Invalid legacy markup can leave form controls outside the form node after
    // browser HTML repair. Score every visible submit control in the document;
    // proximity and semantic penalties still keep the choice local.
    "const submitCandidates = Array.from(doc.querySelectorAll('button,input[type=submit],input[type=button],input[type=image]')).filter(submit);",
    'const inputRect = input.getBoundingClientRect(); const inputDistance = (element) => { const rect = element.getBoundingClientRect(); return Math.hypot((rect.left + rect.width / 2) - (inputRect.left + inputRect.width / 2), (rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2)); };',
    "const submitScore = (element) => { const childImage = element.querySelector?.('img'); const text = (descriptor(element) + ' ' + (element.textContent || '') + ' ' + (element.getAttribute('value') || '') + ' ' + (childImage?.getAttribute('src') || '') + ' ' + (childImage?.getAttribute('alt') || '') + ' ' + (childImage?.getAttribute('title') || '')).toLowerCase(); let value = element === preferredSubmit ? 2000 : 0; if (/search|submit|continue|go/.test(text)) value += 800; if (/captcha|verification|verify/.test(text)) value += 200; if (/refresh|reload|regenerate|new[ _-]?(captcha|code)|clear|reset|cancel|back/.test(text)) value -= 3000; value -= Math.min(inputDistance(element), 1000) / 5; return value; };",
    'submitCandidates.sort((left, right) => submitScore(right) - submitScore(left)); const submitControl = submitCandidates[0] ?? null;',
    "const resultRowCount = Array.from(doc.querySelectorAll('table tr')).filter((row) => { if (!visible(row) || row.querySelector('input,textarea,select,button,[role=button]')) return false; const cells = Array.from(row.querySelectorAll(':scope > th,:scope > td')).filter((cell) => visible(cell) && (cell.textContent || '').trim().length > 0); return cells.length >= 2 && cells.map((cell) => (cell.textContent || '').trim()).join(' ').length >= 12; }).length;",
    'return { inputTarget: selectorFor(input), submitTarget: submit(submitControl) ? selectorFor(submitControl) : null, resultRowCount };',
    '}',
  ].join('\n');
}
const captchaAttemptCounts = new Map<string, number>();
const CAPTCHA_RESULT_ROW_COUNT_EVALUATOR = [
  '() => {',
  "const visible = (element) => { const style = globalThis.getComputedStyle(element); const rect = element.getBoundingClientRect(); return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0; };",
  "return Array.from(document.querySelectorAll('table tr')).filter((row) => {",
  "if (!visible(row) || row.querySelector('input,textarea,select,button,[role=button]')) return false;",
  "const cells = Array.from(row.querySelectorAll(':scope > th,:scope > td')).filter((cell) => visible(cell) && (cell.textContent || '').trim().length > 0);",
  "return cells.length >= 2 && cells.map((cell) => (cell.textContent || '').trim()).join(' ').length >= 12;",
  '}).length;',
  '}',
].join('\n');
interface CaptchaChallenge {
  jobId?: string;
  runId?: string;
  origin: string;
  pageUrl?: string;
  imageTarget: string;
  inputTarget: string;
  submitTarget?: string;
  successTarget?: string;
  successText?: string;
  successTexts?: string[];
  resultRowCountBefore?: number;
  submitWithEnter: boolean;
  attemptNumber: number;
  expiresAt: number;
  challengeFingerprint?: string;
  screenshotEvidenceRef?: string;
  automaticAttemptEvidenceRef?: string;
}
const captchaChallenges = new Map<string, CaptchaChallenge>();
function captchaFingerprint(origin: string, target: string, data: string) {
  return `sha256:${createHash('sha256')
    .update(`${origin}\0${target}\0${data}`)
    .digest('hex')}`;
}
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
    Math.min(MAX_BROWSER_TOOL_TIMEOUT_MS, Math.trunc(raw)),
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
  if (!response.ok) {
    const failure = formatBrowserFailure(action, response.error);
    if (
      publicToolName === 'browser_act' &&
      isRepairableBrowserActionError(response.error)
    ) {
      const { isError: _isError, ...observation } = failure;
      return observation;
    }
    return failure;
  }
  if (isBrowserMcpResult(response.data)) {
    return boundBrowserObservation(response.data);
  }
  return {
    content: [
      { type: 'text' as const, text: formatBrowserToolResponse(response) },
    ],
  };
}

const MAX_BROWSER_OBSERVATION_TEXT_CHARS = 20_000;

function boundBrowserObservation(
  result: BrowserMcpToolResult,
): BrowserMcpToolResult {
  let remaining = MAX_BROWSER_OBSERVATION_TEXT_CHARS;
  return {
    ...result,
    content: result.content.map((item) => {
      if (item.type !== 'text' || item.text.length <= remaining) {
        if (item.type === 'text') remaining -= item.text.length;
        return item;
      }
      const text = `${item.text.slice(0, Math.max(0, remaining))}\n[Browser observation truncated; inspect a narrower target for more detail.]`;
      remaining = 0;
      return { ...item, text };
    }),
  };
}

function isRepairableBrowserActionError(error: string | undefined): boolean {
  return /\b(requires?|invalid|must|unsupported|not found|ambiguous|typeerror|referenceerror|syntaxerror)\b|page\.evaluate|cannot read properties/i.test(
    error ?? '',
  );
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
  .optional()
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
    'Capture a CAPTCHA challenge and run the typed automatic OCR-and-submit loop. Supply stable post-gate success selectors or all expected result-state texts; the answer remains ephemeral and is never returned to the agent.',
    {
      image_target: z.string(),
      input_target: z.string(),
      submit_target: z.string().optional(),
      success_target: z.string().optional(),
      success_text: z.string().min(1).max(256).optional(),
      success_texts: z
        .array(z.string().min(1).max(256))
        .min(1)
        .max(8)
        .optional(),
      submit_with_enter: z.boolean().optional(),
      ttl_ms: z.number().int().min(10_000).max(MAX_CAPTCHA_TTL_MS).optional(),
    },
    async (args) => {
      const timeoutMs = browserTimeoutMs(args);
      const actionTimeoutMs = Math.min(
        timeoutMs,
        CAPTCHA_BROWSER_ACTION_TIMEOUT_MS,
      );
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
      const successTexts = [
        ...new Set([
          ...(typeof args.success_text === 'string' ? [args.success_text] : []),
          ...(Array.isArray(args.success_texts) ? args.success_texts : []),
        ]),
      ];
      if (successTexts.length === 0 && !args.success_target) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'success_text, success_texts, or success_target is required so protected content, not submission alone, proves the CAPTCHA was solved',
        );
      }
      const preexistingSuccessText = successTexts.find((text) =>
        browserTextMatchesSuccessProof(browserResultText(page), text),
      );
      if (preexistingSuccessText) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          `success text ${preexistingSuccessText} is already present before CAPTCHA submission; choose text that appears only after the protected content loads`,
        );
      }
      if (typeof args.success_target === 'string') {
        const existingSuccessTarget = await browserTargetPresent(
          'browser_captcha_challenge',
          args.success_target,
          timeoutMs,
        );
        if (existingSuccessTarget) {
          return formatBrowserFailure(
            'browser_captcha_challenge',
            'success_target is already present before CAPTCHA submission; choose a target that appears only after the protected content loads',
          );
        }
      }
      // The actual fill below is both the validation and the write. A separate
      // empty fill doubled the browser round trips and could consume the full
      // action timeout before the first automatic attempt even started.
      const requestedImageTarget = String(args.image_target);
      const requestedImagePresent = await browserTargetPresent(
        'browser_captcha_challenge',
        requestedImageTarget,
        timeoutMs,
      );
      let captureMode = requestedImagePresent
        ? 'target'
        : 'auto_target_fallback';
      let capturedImageTarget = requestedImagePresent
        ? requestedImageTarget
        : CAPTCHA_IMAGE_FALLBACK_SELECTOR;
      let screenshot = await callBrowserBackend(
        'browser_captcha_challenge',
        'screenshot',
        { target: capturedImageTarget },
        actionTimeoutMs,
      );
      let image = isBrowserErrorResult(screenshot)
        ? null
        : captchaImageContent(screenshot);
      const targetedModelImage = image;
      const targetedImageUnreadable =
        image === null || isUnusableCaptchaImage(image);
      if (
        requestedImagePresent &&
        (isBrowserErrorResult(screenshot) || targetedImageUnreadable)
      ) {
        captureMode = 'auto_target_fallback';
        capturedImageTarget = CAPTCHA_IMAGE_FALLBACK_SELECTOR;
        screenshot = await callBrowserBackend(
          'browser_captcha_challenge',
          'screenshot',
          { target: CAPTCHA_IMAGE_FALLBACK_SELECTOR },
          actionTimeoutMs,
        );
        image = isBrowserErrorResult(screenshot)
          ? null
          : captchaImageContent(screenshot);
      }
      const attemptKey = captchaAttemptKey(origin);
      const completedAttempts = captchaAttemptCounts.get(attemptKey) ?? 0;
      if (completedAttempts >= MAX_AUTOMATIC_CAPTCHA_ATTEMPTS) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `All ${MAX_AUTOMATIC_CAPTCHA_ATTEMPTS} automatic CAPTCHA attempts are exhausted. Create the authorized fallback only by calling job_checkpoint_save with milestone="human_wait" and its humanInteraction CAPTCHA fields, using the latest screenshot and automatic-attempt evidence returned by attempt four. There is no separate human-request tool.`,
            },
          ],
        };
      }
      if (isBrowserErrorResult(screenshot)) return screenshot;
      if (!image) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'the captured challenge image could not be loaded',
        );
      }
      if (isUnusableCaptchaImage(image)) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'all CAPTCHA capture strategies returned a blank, low-information, or implausibly small image; wait for rendering or use a more precise image target and retry without consuming an automatic attempt',
        );
      }
      const challengeId = `captcha_${randomUUID()}`;
      const expiresAt =
        nowMs() +
        Math.min(
          MAX_CAPTCHA_TTL_MS,
          typeof args.ttl_ms === 'number' ? args.ttl_ms : MAX_CAPTCHA_TTL_MS,
        );
      const screenshotArtifact = await persistCaptchaScreenshot({
        challengeId,
        data: image.data,
        mimeType: image.mimeType,
      });
      // Snapshot refs (e1, e2, ...) are intentionally short-lived and are
      // reassigned whenever a refreshed page is inspected. Resolve them once
      // to selectors derived from stable element attributes so every
      // automatic attempt can rediscover the CAPTCHA controls after a server
      // refresh replaces the DOM.
      const durableImageTarget = await durableCaptchaTarget(
        capturedImageTarget,
        timeoutMs,
      );
      const durableInputTarget = await durableCaptchaTarget(
        String(args.input_target),
        timeoutMs,
      );
      const durableSubmitTarget =
        typeof args.submit_target === 'string'
          ? await durableCaptchaTarget(args.submit_target, timeoutMs)
          : undefined;
      const controls = await discoverCaptchaControls({
        imageTarget: durableImageTarget,
        inputTarget: durableInputTarget,
        submitTarget: durableSubmitTarget,
        timeoutMs,
      });
      if ('error' in controls) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          controls.error,
        );
      }
      const challenge: CaptchaChallenge = {
        jobId: currentJobId(),
        runId: currentJobRunId(),
        origin,
        ...(browserResultUrl(page) ? { pageUrl: browserResultUrl(page)! } : {}),
        imageTarget: durableImageTarget,
        inputTarget: controls.inputTarget,
        ...(controls.submitTarget
          ? { submitTarget: controls.submitTarget }
          : {}),
        ...(typeof args.success_target === 'string'
          ? { successTarget: args.success_target }
          : {}),
        ...(typeof args.success_text === 'string'
          ? { successText: args.success_text }
          : {}),
        ...(successTexts.length > 0 ? { successTexts } : {}),
        ...(controls.resultRowCount !== undefined
          ? { resultRowCountBefore: controls.resultRowCount }
          : {}),
        submitWithEnter: args.submit_with_enter === true,
        attemptNumber: completedAttempts + 1,
        expiresAt,
        challengeFingerprint: captchaFingerprint(
          origin,
          durableImageTarget,
          image.data,
        ),
        ...(screenshotArtifact
          ? { screenshotEvidenceRef: screenshotArtifact.id }
          : {}),
      };
      captchaChallenges.set(challengeId, challenge);
      const challengePersisted =
        !currentJobId() ||
        (await persistCaptchaChallenge(challengeId, challenge));
      let evidence: Awaited<ReturnType<typeof persistCaptchaModelAttempt>> =
        null;
      let attemptNumber = completedAttempts;
      for (
        attemptNumber = completedAttempts + 1;
        attemptNumber <= MAX_AUTOMATIC_CAPTCHA_ATTEMPTS;
        attemptNumber += 1
      ) {
        const vision = await requestCaptchaVision({
          imageBase64:
            !targetedImageUnreadable && targetedModelImage
              ? targetedModelImage.data
              : image.data,
          mimeType:
            !targetedImageUnreadable && targetedModelImage
              ? targetedModelImage.mimeType
              : image.mimeType,
          pageUrl: origin,
        });
        captchaChallenges.set(challengeId, {
          ...captchaChallenges.get(challengeId)!,
          attemptNumber,
        });
        if (vision.answer) {
          return settleCaptchaChallenge(
            challengeId,
            vision.answer,
            timeoutMs,
            'automatic',
          );
        }
        captchaAttemptCounts.set(attemptKey, attemptNumber);
        evidence = await persistCaptchaModelAttempt(
          challengeId,
          'inconclusive',
          attemptNumber,
          vision.failureCode,
        );
      }
      attemptNumber = MAX_AUTOMATIC_CAPTCHA_ATTEMPTS;
      const humanFallbackChallenge = {
        ...captchaChallenges.get(challengeId)!,
        attemptNumber: MAX_AUTOMATIC_CAPTCHA_ATTEMPTS,
        expiresAt: nowMs() + MAX_CAPTCHA_TTL_MS,
        ...(evidence ? { automaticAttemptEvidenceRef: evidence.id } : {}),
      };
      captchaChallenges.set(challengeId, humanFallbackChallenge);
      const humanFallbackPersisted =
        !currentJobId() ||
        (challengePersisted &&
          (await persistCaptchaChallenge(challengeId, humanFallbackChallenge)));
      if (!humanFallbackPersisted) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'the non-secret CAPTCHA challenge metadata could not be retained for durable human continuation',
        );
      }
      const holdFailure = await holdCaptchaSession(timeoutMs);
      if (holdFailure) {
        return formatBrowserFailure(
          'browser_captcha_challenge',
          'the browser session could not be retained for durable human continuation',
        );
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `All ${MAX_AUTOMATIC_CAPTCHA_ATTEMPTS} automatic CAPTCHA attempts were inconclusive.\nCapture: ${captureMode}\nFingerprint: ${challenge.challengeFingerprint}\nScreenshot evidence: ${screenshotArtifact ? `${screenshotArtifact.id} (${screenshotArtifact.contentHash})` : 'unavailable'}\nAutomatic CAPTCHA attempt evidence: ${evidence ? `${evidence.id} (${evidence.contentHash})` : 'unavailable'}\nAutomatic attempts are exhausted. Call job_checkpoint_save with milestone="human_wait" and humanInteraction.type="captcha" using challenge ${challengeId}. Include this fingerprint and these evidence references. That atomic call waits for authorization and submits the answer; there is no separate human-request tool.`,
          },
        ],
      };
    },
  );

  register(
    server,
    'browser_captcha_settle',
    'Submit an authorized human CAPTCHA answer to its bound active browser challenge after automatic attempts are exhausted. The answer is ephemeral and never checkpointed.',
    {
      challenge_id: z.string(),
      answer: z.string().min(1).max(512),
    },
    async (args) => {
      if (typeof args.answer !== 'string') {
        return formatBrowserFailure(
          'browser_captcha_settle',
          'inspect the challenge image and provide one best-effort answer',
        );
      }
      return settleCaptchaChallenge(
        String(args.challenge_id),
        args.answer,
        browserTimeoutMs(args),
        'human',
      );
    },
  );
}

export function captchaEvidenceForChallenge(challengeId: string): {
  challengeId: string;
  challengeFingerprint: string;
  screenshotEvidenceRef: string;
  automaticAttemptEvidenceRef: string;
} | null {
  const exactCandidate = captchaChallenges.get(challengeId);
  const exact =
    exactCandidate?.jobId === currentJobId() &&
    exactCandidate?.runId === currentJobRunId()
      ? exactCandidate
      : undefined;
  const latest = [...captchaChallenges.entries()]
    .reverse()
    .find(
      ([, candidate]) =>
        candidate.jobId === currentJobId() &&
        candidate.runId === currentJobRunId() &&
        candidate.automaticAttemptEvidenceRef,
    );
  const [resolvedChallengeId, challenge] = exact
    ? [challengeId, exact]
    : (latest ?? ['', undefined]);
  return challenge?.challengeFingerprint &&
    challenge.screenshotEvidenceRef &&
    challenge.automaticAttemptEvidenceRef
    ? {
        challengeId: resolvedChallengeId,
        challengeFingerprint: challenge.challengeFingerprint,
        screenshotEvidenceRef: challenge.screenshotEvidenceRef,
        automaticAttemptEvidenceRef: challenge.automaticAttemptEvidenceRef,
      }
    : null;
}

async function requestCaptchaVision(input: {
  imageBase64: string;
  mimeType: string;
  pageUrl: string;
}): Promise<{ answer?: string; failureCode?: string }> {
  const response = await requestCaptchaVisionAction(input, 120_000);
  if (!response?.ok || typeof response.data !== 'object' || !response.data) {
    return { failureCode: response?.code ?? 'vision_transport_failed' };
  }
  const data = response.data as { answer?: unknown; failureCode?: unknown };
  return typeof data.answer === 'string' && data.answer.trim()
    ? { answer: data.answer.trim() }
    : {
        failureCode:
          typeof data.failureCode === 'string'
            ? data.failureCode
            : 'vision_unreadable',
      };
}

export async function settleCaptchaChallenge(
  challengeId: string,
  answer: string,
  timeoutMs: number,
  mode: 'automatic' | 'human',
  attemptEvidenceRef?: string | null,
): Promise<BrowserMcpToolResult> {
  const actionTimeoutMs = Math.min(
    timeoutMs,
    CAPTCHA_BROWSER_ACTION_TIMEOUT_MS,
  );
  const evidenceChallengeId = attemptEvidenceRef
    ? await loadCaptchaAttemptChallengeId(attemptEvidenceRef)
    : null;
  const directChallenge =
    captchaChallenges.get(challengeId) ??
    (await loadCaptchaChallenge(challengeId));
  const resolvedChallengeId = directChallenge
    ? challengeId
    : (evidenceChallengeId ?? challengeId);
  const challenge =
    directChallenge ??
    captchaChallenges.get(resolvedChallengeId) ??
    (await loadCaptchaChallenge(resolvedChallengeId));
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
  const page = await callBrowserBackend(
    'browser_captcha_settle',
    'snapshot',
    {},
    actionTimeoutMs,
  );
  if (isBrowserErrorResult(page)) {
    return formatBrowserFailure(
      'browser_captcha_settle',
      'the active page could not be inspected before submitting the authorized answer',
    );
  }
  const activeOrigin = browserResultOrigin(page);
  if (activeOrigin === 'null' && challenge.pageUrl) {
    const refreshedCapture = await captureRefreshedCaptchaImage(
      challenge,
      actionTimeoutMs,
    );
    if (!refreshedCapture) {
      return formatBrowserFailure(
        'browser_captcha_settle',
        'the retained browser session was lost and a fresh CAPTCHA challenge could not be recovered',
      );
    }
    const refreshedChallengeId = `captcha_${randomUUID()}`;
    const refreshedEvidence = await persistCaptchaScreenshot({
      challengeId: refreshedChallengeId,
      data: refreshedCapture.image.data,
      mimeType: refreshedCapture.image.mimeType,
    });
    captchaAttemptCounts.delete(captchaAttemptKey(challenge.origin));
    captchaChallenges.delete(resolvedChallengeId);
    return continueAutomaticCaptchaAttempts({
      challenge: {
        ...challenge,
        imageTarget: refreshedCapture.target,
        attemptNumber: 1,
        expiresAt: nowMs() + MAX_CAPTCHA_TTL_MS,
        challengeFingerprint: captchaFingerprint(
          challenge.origin,
          refreshedCapture.target,
          refreshedCapture.image.data,
        ),
        ...(refreshedEvidence
          ? { screenshotEvidenceRef: refreshedEvidence.id }
          : {}),
        automaticAttemptEvidenceRef: undefined,
      },
      image: refreshedCapture.image,
      timeoutMs,
    });
  }
  if (activeOrigin && activeOrigin !== challenge.origin) {
    return formatBrowserFailure(
      'browser_captcha_settle',
      `the active page origin changed after the challenge was captured (${activeOrigin})`,
    );
  }
  if (mode === 'human' && challenge.challengeFingerprint) {
    const liveCapture = await captureRefreshedCaptchaImage(
      challenge,
      actionTimeoutMs,
    );
    if (!liveCapture) {
      return formatBrowserFailure(
        'browser_captcha_settle',
        'the live CAPTCHA image could not be verified before submitting the authorized answer',
      );
    }
    const liveFingerprint = captchaFingerprint(
      challenge.origin,
      liveCapture.target,
      liveCapture.image.data,
    );
    if (liveFingerprint !== challenge.challengeFingerprint) {
      const refreshedChallengeId = `captcha_${randomUUID()}`;
      const refreshedEvidence = await persistCaptchaScreenshot({
        challengeId: refreshedChallengeId,
        data: liveCapture.image.data,
        mimeType: liveCapture.image.mimeType,
      });
      captchaAttemptCounts.delete(captchaAttemptKey(challenge.origin));
      captchaChallenges.delete(resolvedChallengeId);
      return continueAutomaticCaptchaAttempts({
        challenge: {
          ...challenge,
          imageTarget: liveCapture.target,
          attemptNumber: 1,
          expiresAt: nowMs() + MAX_CAPTCHA_TTL_MS,
          challengeFingerprint: liveFingerprint,
          ...(refreshedEvidence
            ? { screenshotEvidenceRef: refreshedEvidence.id }
            : {}),
          automaticAttemptEvidenceRef: undefined,
        },
        image: liveCapture.image,
        timeoutMs,
      });
    }
  }
  captchaChallenges.delete(resolvedChallengeId);
  const typed = await callBrowserBackend(
    'browser_captcha_settle',
    'fill_form',
    {
      fields: [
        {
          target: challenge.inputTarget,
          type: 'textbox',
          value: answer,
        },
      ],
    },
    actionTimeoutMs,
  );
  if (isBrowserErrorResult(typed)) {
    return formatBrowserFailure(
      'browser_captcha_challenge',
      'the CAPTCHA input target is not an editable text field; inspect the page and retry with the exact CAPTCHA answer input',
    );
  }
  const result = challenge.submitTarget
    ? await callBrowserBackend(
        'browser_captcha_settle',
        'click',
        { target: challenge.submitTarget },
        actionTimeoutMs,
      )
    : challenge.submitWithEnter
      ? await callBrowserBackend(
          'browser_captcha_settle',
          'press_key',
          { key: 'Enter' },
          actionTimeoutMs,
        )
      : typed;
  const attemptKey = captchaAttemptKey(challenge.origin);
  let automaticAttemptEvidence: Awaited<
    ReturnType<typeof persistCaptchaModelAttempt>
  > = null;
  if (mode === 'automatic') {
    captchaAttemptCounts.set(attemptKey, challenge.attemptNumber);
    automaticAttemptEvidence = await persistCaptchaModelAttempt(
      challengeId,
      isBrowserErrorResult(result) ? 'inconclusive' : 'submitted',
      challenge.attemptNumber,
    );
    if (automaticAttemptEvidence) {
      result.content.push({
        type: 'text' as const,
        text: `Automatic CAPTCHA attempt evidence: ${automaticAttemptEvidence.id} (${automaticAttemptEvidence.contentHash})`,
      });
    }
  }
  const successDeadline =
    nowMs() + Math.min(timeoutMs, CAPTCHA_SUCCESS_PROOF_TIMEOUT_MS);
  let matchedSuccessText: string | undefined;
  let successTargetPresent = false;
  let protectedResultRowsPresent = false;
  let latestSuccessSnapshot: BrowserMcpToolResult | null = null;
  do {
    const successTexts =
      challenge.successTexts ??
      (challenge.successText ? [challenge.successText] : []);
    const successSnapshot = await callBrowserBackend(
      'browser_captcha_settle',
      'snapshot',
      {},
      actionTimeoutMs,
    );
    latestSuccessSnapshot = isBrowserErrorResult(successSnapshot)
      ? null
      : successSnapshot;
    matchedSuccessText =
      successSnapshot && !isBrowserErrorResult(successSnapshot)
        ? successTexts.find((text) =>
            browserTextMatchesSuccessProof(
              browserResultText(successSnapshot),
              text,
            ),
          )
        : undefined;
    const successProof =
      !matchedSuccessText && challenge.successTarget
        ? await browserTargetPresent(
            'browser_captcha_settle',
            challenge.successTarget,
            actionTimeoutMs,
          )
        : false;
    successTargetPresent = successProof;
    const resultRowCount =
      challenge.resultRowCountBefore !== undefined &&
      latestSuccessSnapshot !== null &&
      !browserTextIndicatesCaptchaFailure(
        browserResultText(latestSuccessSnapshot),
      )
        ? await browserResultRowCount('browser_captcha_settle', actionTimeoutMs)
        : null;
    protectedResultRowsPresent =
      resultRowCount !== null &&
      resultRowCount > challenge.resultRowCountBefore!;
    if (
      matchedSuccessText ||
      successTargetPresent ||
      protectedResultRowsPresent ||
      nowMs() >= successDeadline
    )
      break;
    await new Promise((resolve) =>
      setTimeout(resolve, CAPTCHA_SUCCESS_PROOF_POLL_MS),
    );
  } while (true);
  const captchaGateDisappeared =
    !matchedSuccessText &&
    !successTargetPresent &&
    latestSuccessSnapshot !== null &&
    browserResultOrigin(latestSuccessSnapshot) === challenge.origin &&
    browserSnapshotHasSubstantiveContent(latestSuccessSnapshot) &&
    !browserTextIndicatesCaptchaFailure(
      browserResultText(latestSuccessSnapshot),
    ) &&
    !(await browserTargetPresent(
      'browser_captcha_settle',
      challenge.imageTarget,
      actionTimeoutMs,
    )) &&
    !(await browserTargetPresent(
      'browser_captcha_settle',
      challenge.inputTarget,
      actionTimeoutMs,
    )) &&
    !(await browserTargetPresent(
      'browser_captcha_settle',
      CAPTCHA_IMAGE_FALLBACK_SELECTOR,
      actionTimeoutMs,
    ));
  if (
    matchedSuccessText ||
    successTargetPresent ||
    protectedResultRowsPresent ||
    captchaGateDisappeared
  ) {
    const successEvidence = await persistCaptchaModelAttempt(
      resolvedChallengeId,
      mode === 'automatic' ? 'solved_automatic' : 'solved_human',
      challenge.attemptNumber,
    );
    result.content.push({
      type: 'text' as const,
      text: `The CAPTCHA gate cleared: ${matchedSuccessText ? `success text ${matchedSuccessText} is present` : successTargetPresent ? `success target ${challenge.successTarget} is present` : protectedResultRowsPresent ? 'new protected data rows appeared without a CAPTCHA failure response' : 'the challenge image and answer control disappeared while a substantive same-origin protected page loaded'}. A refreshed CAPTCHA widget elsewhere on the loaded results page does not override an explicit success proof.${successEvidence ? ` Deterministic CAPTCHA success evidence: ${successEvidence.id} (${successEvidence.contentHash}).` : ''}`,
    });
    captchaAttemptCounts.delete(attemptKey);
    return result;
  }
  const refreshedChallengeId = `captcha_${randomUUID()}`;
  const refreshedCapture = await captureRefreshedCaptchaImage(
    challenge,
    actionTimeoutMs,
  );
  const refreshedImage = refreshedCapture?.image ?? null;
  const captchaTargetStillPresent = Boolean(refreshedImage);
  if (!refreshedCapture) {
    result.content.push({
      type: 'text' as const,
      text: 'The submitted CAPTCHA did not produce protected-content proof, and no usable fresh CAPTCHA image could be recovered after same-origin back/navigation recovery. No additional automatic attempt was consumed. Re-inspect the current page before deciding whether a human interaction is actually available.',
    });
    return { ...result, isError: true };
  }
  if (refreshedImage) {
    const refreshedEvidence = await persistCaptchaScreenshot({
      challengeId: refreshedChallengeId,
      data: refreshedImage.data,
      mimeType: refreshedImage.mimeType,
    });
    if (refreshedEvidence) {
      if (
        mode === 'automatic' &&
        challenge.attemptNumber === MAX_AUTOMATIC_CAPTCHA_ATTEMPTS
      ) {
        const refreshedChallenge = {
          ...challenge,
          imageTarget: refreshedCapture.target,
          attemptNumber: MAX_AUTOMATIC_CAPTCHA_ATTEMPTS,
          expiresAt: nowMs() + MAX_CAPTCHA_TTL_MS,
          challengeFingerprint: captchaFingerprint(
            challenge.origin,
            refreshedCapture.target,
            refreshedImage.data,
          ),
          screenshotEvidenceRef: refreshedEvidence.id,
          ...(automaticAttemptEvidence
            ? { automaticAttemptEvidenceRef: automaticAttemptEvidence.id }
            : {}),
        };
        captchaChallenges.set(refreshedChallengeId, refreshedChallenge);
        await persistCaptchaChallenge(refreshedChallengeId, refreshedChallenge);
        const holdFailure = await holdCaptchaSession(timeoutMs);
        if (holdFailure) return holdFailure;
      }
      result.content.push({
        type: 'text' as const,
        text:
          mode === 'human' && captchaTargetStillPresent
            ? `The authorized answer did not clear the CAPTCHA gate. Fresh CAPTCHA screenshot evidence: ${refreshedEvidence.id} (${refreshedEvidence.contentHash}). Capture this new challenge with browser_captcha_challenge so automatic solving runs before any new human fallback.`
            : `Post-attempt CAPTCHA screenshot evidence: ${refreshedEvidence.id} (${refreshedEvidence.contentHash}). ${challenge.attemptNumber < MAX_AUTOMATIC_CAPTCHA_ATTEMPTS ? 'If the CAPTCHA remains, capture the refreshed challenge with browser_captcha_challenge and retry.' : `If the CAPTCHA remains, automatic attempts are exhausted. Checkpoint, request authorized human fallback, then submit that answer with browser_captcha_settle using challenge ${refreshedChallengeId}.`}`,
      });
      if (
        mode === 'automatic' &&
        challenge.attemptNumber < MAX_AUTOMATIC_CAPTCHA_ATTEMPTS
      ) {
        return continueAutomaticCaptchaAttempts({
          challenge: {
            ...challenge,
            imageTarget: refreshedCapture.target,
            attemptNumber: challenge.attemptNumber + 1,
            expiresAt: nowMs() + MAX_CAPTCHA_TTL_MS,
            challengeFingerprint: captchaFingerprint(
              challenge.origin,
              refreshedCapture.target,
              refreshedImage.data,
            ),
            screenshotEvidenceRef: refreshedEvidence.id,
          },
          image: refreshedImage,
          timeoutMs,
        });
      }
    }
  }
  if (mode === 'human' && captchaTargetStillPresent) {
    captchaAttemptCounts.set(attemptKey, 0);
    return { ...result, isError: true };
  }
  return result;
}

async function captureRefreshedCaptchaImage(
  challenge: CaptchaChallenge,
  timeoutMs: number,
): Promise<{
  image: { data: string; mimeType: string };
  target: string;
} | null> {
  const captureTimeoutMs = Math.min(
    timeoutMs,
    CAPTCHA_REFRESH_CAPTURE_TIMEOUT_MS,
  );
  const capture = async () => {
    for (const target of [
      challenge.imageTarget,
      CAPTCHA_IMAGE_FALLBACK_SELECTOR,
    ]) {
      const screenshot = await callBrowserBackend(
        'browser_captcha_settle',
        'screenshot',
        { target },
        captureTimeoutMs,
      );
      const image = isBrowserErrorResult(screenshot)
        ? null
        : captchaImageContent(screenshot);
      if (image && !isUnusableCaptchaImage(image)) return { image, target };
    }
    return null;
  };

  const direct = await capture();
  if (direct) return direct;

  // Some sites submit CAPTCHA forms into a blank/intermediate page. Recover
  // the same browser session before asking a model or a human to solve an
  // image that is no longer present.
  await callBrowserBackend(
    'browser_captcha_settle',
    'back',
    {},
    captureTimeoutMs,
  );
  await callBrowserBackend(
    'browser_captcha_settle',
    'snapshot',
    {},
    captureTimeoutMs,
  );
  const afterBack = await capture();
  if (afterBack) return afterBack;

  if (challenge.pageUrl) {
    await callBrowserBackend(
      'browser_captcha_settle',
      'navigate',
      { url: challenge.pageUrl },
      captureTimeoutMs,
    );
    await callBrowserBackend(
      'browser_captcha_settle',
      'snapshot',
      {},
      captureTimeoutMs,
    );
    return await capture();
  }
  return null;
}

async function durableCaptchaTarget(
  target: string,
  timeoutMs: number,
): Promise<string> {
  if (!/^e\d+$/u.test(target)) return target;
  const evaluated = await callBrowserBackend(
    'browser_captcha_challenge',
    'evaluate',
    { target, function: DURABLE_CAPTCHA_TARGET_EVALUATOR },
    timeoutMs,
  );
  if (isBrowserErrorResult(evaluated)) return target;
  try {
    const selector = JSON.parse(browserResultText(evaluated)) as unknown;
    return typeof selector === 'string' && selector.trim()
      ? selector.trim()
      : target;
  } catch {
    return target;
  }
}

async function browserTargetPresent(
  publicToolName: 'browser_captcha_challenge' | 'browser_captcha_settle',
  target: string,
  timeoutMs: number,
): Promise<boolean> {
  const evaluated = await callBrowserBackend(
    publicToolName,
    'evaluate',
    {
      target,
      function: [
        '(element) => {',
        'const style = globalThis.getComputedStyle(element);',
        'const rect = element.getBoundingClientRect();',
        "return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;",
        '}',
      ].join('\n'),
    },
    timeoutMs,
  );
  if (isBrowserErrorResult(evaluated)) return false;
  try {
    return JSON.parse(browserResultText(evaluated)) === true;
  } catch {
    return false;
  }
}

async function browserResultRowCount(
  publicToolName: 'browser_captcha_challenge' | 'browser_captcha_settle',
  timeoutMs: number,
): Promise<number | null> {
  const evaluated = await callBrowserBackend(
    publicToolName,
    'evaluate',
    { function: CAPTCHA_RESULT_ROW_COUNT_EVALUATOR },
    timeoutMs,
  );
  if (isBrowserErrorResult(evaluated)) return null;
  try {
    const value = JSON.parse(browserResultText(evaluated));
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function discoverCaptchaControls(input: {
  imageTarget: string;
  inputTarget: string;
  submitTarget?: string;
  timeoutMs: number;
}): Promise<
  | {
      inputTarget: string;
      submitTarget?: string;
      resultRowCount?: number;
    }
  | { error: string }
> {
  const evaluated = await callBrowserBackend(
    'browser_captcha_challenge',
    'evaluate',
    {
      target: input.imageTarget,
      function: captchaControlDiscoveryEvaluator(
        input.inputTarget,
        input.submitTarget,
      ),
    },
    input.timeoutMs,
  );
  if (isBrowserErrorResult(evaluated)) {
    return {
      error:
        'the CAPTCHA controls could not be validated against the live page',
    };
  }
  try {
    const value = JSON.parse(browserResultText(evaluated)) as {
      inputTarget?: unknown;
      submitTarget?: unknown;
      resultRowCount?: unknown;
      error?: unknown;
    };
    if (typeof value.error === 'string') return { error: value.error };
    if (typeof value.inputTarget !== 'string' || !value.inputTarget.trim()) {
      return {
        error: 'the live page did not expose a durable editable CAPTCHA input',
      };
    }
    return {
      inputTarget: value.inputTarget.trim(),
      ...(typeof value.submitTarget === 'string' && value.submitTarget.trim()
        ? { submitTarget: value.submitTarget.trim() }
        : {}),
      ...(typeof value.resultRowCount === 'number' &&
      Number.isInteger(value.resultRowCount) &&
      value.resultRowCount >= 0
        ? { resultRowCount: value.resultRowCount }
        : {}),
    };
  } catch {
    return { error: 'the CAPTCHA control validation result was malformed' };
  }
}

async function continueAutomaticCaptchaAttempts(input: {
  challenge: CaptchaChallenge;
  image: { data: string; mimeType: string };
  timeoutMs: number;
}): Promise<BrowserMcpToolResult> {
  const attemptKey = captchaAttemptKey(input.challenge.origin);
  let latestEvidence: Awaited<ReturnType<typeof persistCaptchaModelAttempt>> =
    null;
  let latestChallengeId = '';
  for (
    let attemptNumber = input.challenge.attemptNumber;
    attemptNumber <= MAX_AUTOMATIC_CAPTCHA_ATTEMPTS;
    attemptNumber += 1
  ) {
    latestChallengeId = `captcha_${randomUUID()}`;
    const challenge = { ...input.challenge, attemptNumber };
    captchaChallenges.set(latestChallengeId, challenge);
    if (!(await persistCaptchaChallenge(latestChallengeId, challenge))) {
      return formatBrowserFailure(
        'browser_captcha_challenge',
        'the automatic CAPTCHA retry metadata could not be retained',
      );
    }
    const vision = await requestCaptchaVision({
      imageBase64: input.image.data,
      mimeType: input.image.mimeType,
      pageUrl: input.challenge.origin,
    });
    if (vision.answer) {
      return settleCaptchaChallenge(
        latestChallengeId,
        vision.answer,
        input.timeoutMs,
        'automatic',
      );
    }
    captchaAttemptCounts.set(attemptKey, attemptNumber);
    latestEvidence = await persistCaptchaModelAttempt(
      latestChallengeId,
      'inconclusive',
      attemptNumber,
      vision.failureCode,
    );
  }
  const fallback = {
    ...input.challenge,
    attemptNumber: MAX_AUTOMATIC_CAPTCHA_ATTEMPTS,
    expiresAt: nowMs() + MAX_CAPTCHA_TTL_MS,
    ...(latestEvidence
      ? { automaticAttemptEvidenceRef: latestEvidence.id }
      : {}),
  };
  captchaChallenges.set(latestChallengeId, fallback);
  if (!(await persistCaptchaChallenge(latestChallengeId, fallback))) {
    return formatBrowserFailure(
      'browser_captcha_challenge',
      'the automatic CAPTCHA fallback metadata could not be retained',
    );
  }
  const holdFailure = await holdCaptchaSession(input.timeoutMs);
  if (holdFailure) return holdFailure;
  return {
    content: [
      {
        type: 'text' as const,
        text: `All ${MAX_AUTOMATIC_CAPTCHA_ATTEMPTS} automatic CAPTCHA attempts were inconclusive. Screenshot evidence: ${input.challenge.screenshotEvidenceRef ?? 'unavailable'}. Automatic CAPTCHA attempt evidence: ${latestEvidence ? `${latestEvidence.id} (${latestEvidence.contentHash})` : 'unavailable'}. Automatic attempts are exhausted. Call job_checkpoint_save with milestone="human_wait" and humanInteraction.type="captcha" using challenge ${latestChallengeId}.`,
      },
    ],
  };
}

async function holdCaptchaSession(
  timeoutMs: number,
): Promise<BrowserMcpToolResult | null> {
  const heldSession = await callBrowserBackend(
    'browser_captcha_challenge',
    'open',
    { keep_alive_ms: MAX_CAPTCHA_TTL_MS },
    timeoutMs,
  );
  return isBrowserErrorResult(heldSession) ? heldSession : null;
}

function browserTextMatchesSuccessProof(
  browserText: string,
  expectedText: string,
): boolean {
  const normalizedBrowserText = browserText
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  const normalizedExpectedText = expectedText
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  if (!normalizedExpectedText) return false;
  if (normalizedBrowserText.includes(normalizedExpectedText)) return true;
  const expectedTokens = [...new Set(normalizedExpectedText.split(/\s+/u))];
  if (expectedTokens.length < 3) return false;
  const browserTokens = new Set(normalizedBrowserText.split(/\s+/u));
  return expectedTokens.every((token) => browserTokens.has(token));
}

function browserSnapshotHasSubstantiveContent(
  snapshot: BrowserMcpToolResult,
): boolean {
  const content = browserResultText(snapshot)
    .replace(/^URL:\s*\S+\s*/mu, '')
    .replace(/[^a-z0-9]+/giu, ' ')
    .trim();
  return content.length >= 30;
}

function browserTextIndicatesCaptchaFailure(browserText: string): boolean {
  return /(?:invalid|incorrect|wrong|expired|failed)\s+(?:captcha|verification\s*code)|(?:captcha|verification\s*code)\s+(?:is\s+)?(?:invalid|incorrect|wrong|expired|required|failed)/iu.test(
    browserText,
  );
}

async function loadCaptchaAttemptChallengeId(
  artifactId: string,
): Promise<string | null> {
  try {
    const value = JSON.parse(
      await handleFileToolAction({ action: 'read', artifactId }),
    ) as Record<string, unknown>;
    return typeof value.challengeId === 'string' ? value.challengeId : null;
  } catch {
    return null;
  }
}

function captchaAttemptKey(origin: string): string {
  return `${currentJobId() ?? ''}:${currentJobRunId() ?? ''}:${origin}`;
}

async function persistCaptchaChallenge(
  challengeId: string,
  challenge: CaptchaChallenge,
): Promise<boolean> {
  if (!currentJobId()) return false;
  try {
    const result = await handleFileToolAction({
      action: 'write',
      scope: jobArtifactScope(currentJobId()!),
      path: `captcha-challenge/${challengeId}.json`,
      content: JSON.stringify(challenge),
      encoding: 'utf8',
      contentType: 'application/json',
    });
    return result.includes('"artifact"');
  } catch {
    return false;
  }
}

async function loadCaptchaChallenge(
  challengeId: string,
): Promise<CaptchaChallenge | null> {
  if (!currentJobId()) return null;
  try {
    const value = JSON.parse(
      await handleFileToolAction({
        action: 'read',
        scope: jobArtifactScope(currentJobId()!),
        path: `captcha-challenge/${challengeId}.json`,
      }),
    ) as Record<string, unknown>;
    if (
      value.jobId !== currentJobId() ||
      value.runId !== currentJobRunId() ||
      typeof value.origin !== 'string' ||
      typeof value.imageTarget !== 'string' ||
      typeof value.inputTarget !== 'string' ||
      typeof value.submitWithEnter !== 'boolean' ||
      typeof value.attemptNumber !== 'number' ||
      typeof value.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      jobId: currentJobId(),
      ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
      origin: value.origin,
      ...(typeof value.pageUrl === 'string' ? { pageUrl: value.pageUrl } : {}),
      imageTarget: value.imageTarget,
      inputTarget: value.inputTarget,
      ...(typeof value.submitTarget === 'string'
        ? { submitTarget: value.submitTarget }
        : {}),
      ...(typeof value.successTarget === 'string'
        ? { successTarget: value.successTarget }
        : {}),
      ...(typeof value.successText === 'string'
        ? { successText: value.successText }
        : {}),
      ...(Array.isArray(value.successTexts) &&
      value.successTexts.every((item) => typeof item === 'string')
        ? { successTexts: value.successTexts }
        : {}),
      ...(typeof value.resultRowCountBefore === 'number' &&
      Number.isInteger(value.resultRowCountBefore) &&
      value.resultRowCountBefore >= 0
        ? { resultRowCountBefore: value.resultRowCountBefore }
        : {}),
      submitWithEnter: value.submitWithEnter,
      attemptNumber: value.attemptNumber,
      expiresAt: value.expiresAt,
      ...(typeof value.challengeFingerprint === 'string'
        ? { challengeFingerprint: value.challengeFingerprint }
        : {}),
      ...(typeof value.screenshotEvidenceRef === 'string'
        ? { screenshotEvidenceRef: value.screenshotEvidenceRef }
        : {}),
      ...(typeof value.automaticAttemptEvidenceRef === 'string'
        ? { automaticAttemptEvidenceRef: value.automaticAttemptEvidenceRef }
        : {}),
    };
  } catch {
    return null;
  }
}

async function persistCaptchaScreenshot(input: {
  challengeId: string;
  data: string;
  mimeType: string;
}): Promise<{ id: string; contentHash: string } | null> {
  try {
    const result = await handleFileToolAction({
      action: 'write',
      scope: currentJobId() ? jobArtifactScope(currentJobId()!) : 'default',
      path: `captcha/${input.challengeId}.png`,
      content: input.data,
      encoding: 'base64',
      contentType: input.mimeType,
    });
    const parsed = JSON.parse(result) as {
      artifact?: { id?: unknown; contentHash?: unknown };
    };
    return typeof parsed.artifact?.id === 'string' &&
      typeof parsed.artifact.contentHash === 'string'
      ? { id: parsed.artifact.id, contentHash: parsed.artifact.contentHash }
      : null;
  } catch {
    return null;
  }
}

async function persistCaptchaModelAttempt(
  challengeId: string,
  outcome: 'submitted' | 'inconclusive' | 'solved_automatic' | 'solved_human',
  attemptNumber: number,
  failureCode?: string,
): Promise<{ id: string; contentHash: string } | null> {
  try {
    const result = await handleFileToolAction({
      action: 'write',
      scope: currentJobId() ? jobArtifactScope(currentJobId()!) : 'default',
      path: `captcha-attempt/${challengeId}-${attemptNumber}-${outcome}.json`,
      content: JSON.stringify({
        challengeId,
        outcome,
        attemptNumber,
        ...(failureCode ? { failureCode } : {}),
        attemptedAt: new Date(nowMs()).toISOString(),
      }),
      encoding: 'utf8',
      contentType: 'application/json',
    });
    const parsed = JSON.parse(result) as {
      artifact?: { id?: unknown; contentHash?: unknown };
    };
    return typeof parsed.artifact?.id === 'string' &&
      typeof parsed.artifact.contentHash === 'string'
      ? { id: parsed.artifact.id, contentHash: parsed.artifact.contentHash }
      : null;
  } catch {
    return null;
  }
}

function browserResultOrigin(result: BrowserMcpToolResult): string | null {
  const url = browserResultUrl(result);
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

function browserResultUrl(result: BrowserMcpToolResult): string | null {
  return /^URL:\s*(\S+)/mu.exec(browserResultText(result))?.[1] ?? null;
}

function browserResultText(result: BrowserMcpToolResult): string {
  return result.content
    .flatMap((item) => (item.type === 'text' ? [item.text] : []))
    .join('\n');
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

function isImplausiblySmallCaptchaImage(
  image: { data: string; mimeType: string } | null,
): boolean {
  if (!image || image.mimeType !== 'image/png') return false;
  const content = Buffer.from(image.data, 'base64');
  if (
    content.length < 24 ||
    !content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return false;
  }
  return content.readUInt32BE(16) < 64 || content.readUInt32BE(20) < 20;
}

function isUnusableCaptchaImage(
  image: { data: string; mimeType: string } | null,
): boolean {
  if (isImplausiblySmallCaptchaImage(image)) return true;
  if (!image || image.mimeType !== 'image/png') return false;
  const content = Buffer.from(image.data, 'base64');
  if (
    content.length < 24 ||
    !content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return false;
  }
  const pixels = content.readUInt32BE(16) * content.readUInt32BE(20);
  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  // A CAPTCHA challenge must be an element capture, never a page screenshot.
  if (width > 1_000 || height > 500 || pixels > 500_000) return true;
  // A large screenshot compressed below ~0.67% bytes/pixel is effectively
  // blank for OCR. Reject it before spending a vision attempt.
  return pixels >= 10_000 && content.length * 150 < pixels;
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
