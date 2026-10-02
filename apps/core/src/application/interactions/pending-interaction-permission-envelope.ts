import type { PermissionApprovalRequest } from '../../domain/types.js';
import {
  redactSensitiveText,
  sanitizeOutboundLlmText,
} from '../../shared/sensitive-material.js';
import { parsePermissionCardAffordances } from '../permissions/permission-card-affordances.js';

const WHY_MAX_CHARS = 200;
const MESSAGE_PATTERN = /<message\b[^>]*>([\s\S]*?)(?:<\/message>|$)/g;
// Inputs a prompt shows: the command and its programs, the friendly
// capability name, the account and the file or URL.
const DISPLAY_TOOL_INPUT_KEYS = [
  'command',
  'cmd',
  'description',
  'capabilityId',
  'capabilityDisplayName',
  'accountLabel',
  'file_path',
  'path',
  'url',
] as const;

export interface DurablePermissionFullView {
  label: string;
  title: string;
  filename: string;
  content: string;
}

export function durablePermissionRequestSnapshot(
  request: PermissionApprovalRequest,
): PermissionApprovalRequest {
  const capabilityTemplateAmendment =
    request.toolName === 'capability_template_amendment';
  const displayToolInput = durableDisplayToolInput(request.toolInput);
  return {
    requestId: request.requestId,
    appId: request.appId,
    agentId: request.agentId,
    providerAccountId: request.providerAccountId,
    personId: request.personId,
    sourceAgentFolder: request.sourceAgentFolder,
    runHandle: request.runHandle,
    jobId: request.jobId,
    setupFingerprint: request.setupFingerprint,
    runId: request.runId,
    targetJid: request.targetJid,
    approvalContextJid: request.approvalContextJid,
    threadId: request.threadId,
    toolName: request.toolName,
    toolInputSanitized: request.toolInputSanitized,
    toolInputSanitizedPaths: request.toolInputSanitizedPaths,
    suggestions: request.suggestions,
    decisionOptions: request.decisionOptions,
    cardAffordances: request.cardAffordances,
    decisionPolicy: request.decisionPolicy,
    semanticCapabilityDefinitions: request.semanticCapabilityDefinitions,
    // What, which and why survive a restart, with secrets hidden.
    displayName: request.displayName,
    title: request.title,
    jobName: request.jobName,
    risk_level: request.risk_level,
    risk_category: request.risk_category,
    turnIntentSummary: permissionRequestWhyText(request.turnIntentSummary),
    ...(displayToolInput ? { toolInput: displayToolInput } : {}),
    ...(capabilityTemplateAmendment
      ? {
          requestFamily: request.requestFamily,
          description: request.description,
          toolInput:
            typeof request.toolInput?.diffPreview === 'string'
              ? { diffPreview: request.toolInput.diffPreview }
              : undefined,
          interaction: request.interaction
            ? {
                id: request.interaction.id,
                title: request.interaction.title,
                body: request.interaction.body,
              }
            : undefined,
        }
      : {}),
  };
}

/** The "why" line: the person's own request from the turn prompt, plain and
 *  with secrets hidden. A prompt whose current message was cut off shows no
 *  why rather than an older message. */
export function permissionRequestWhyText(
  turnIntentSummary: string | undefined,
): string | undefined {
  const text = turnIntentSummary?.trim();
  if (!text) return undefined;
  // A chat turn's prompt is the formatted conversation; a job's is plain text.
  const formatted = /<(context|messages|current_message)\b/.test(text);
  const current = text.lastIndexOf('<current_message');
  if (formatted && current < 0 && /<recent_channel_context\b/.test(text)) {
    return undefined;
  }
  const scope = current < 0 ? text : text.slice(current);
  const lastMessage = [...scope.matchAll(MESSAGE_PATTERN)].at(-1);
  if (formatted && !lastMessage) return undefined;
  const plain = unescapeXml(
    (lastMessage ? lastMessage[1] : text).replace(
      /<quoted_message\b[\s\S]*?<\/quoted_message>/g,
      '',
    ),
  )
    .replace(/\s+/g, ' ')
    .trim();
  const result = sanitizeOutboundLlmText(plain);
  if (!plain || result.blocked) return undefined;
  return result.text.length <= WHY_MAX_CHARS
    ? result.text
    : `${result.text.slice(0, WHY_MAX_CHARS - 1).trimEnd()}…`;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function durableDisplayToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const display: Record<string, string> = {};
  for (const key of DISPLAY_TOOL_INPUT_KEYS) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (key === 'command' || key === 'cmd') {
      display[key] = redactSensitiveText(value);
      continue;
    }
    const result = sanitizeOutboundLlmText(value);
    if (!result.blocked) display[key] = result.text;
  }
  return Object.keys(display).length ? display : undefined;
}

export function readDurablePermissionFullView(
  value: unknown,
): DurablePermissionFullView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const label = durablePermissionFullViewString(candidate.label);
  const title = durablePermissionFullViewString(candidate.title);
  const filename = durablePermissionFullViewString(candidate.filename);
  const content = durablePermissionFullViewString(candidate.content);
  if (!label || !title || !filename || !content) return undefined;
  return { label, title, filename, content };
}

export function permissionRequestFromPayload(
  payload: Record<string, unknown>,
): PermissionApprovalRequest | null {
  return isPermissionRequest(payload.request) ? payload.request : null;
}

export function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function durablePermissionFullViewString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isPermissionRequest(
  value: unknown,
): value is PermissionApprovalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<PermissionApprovalRequest>;
  return (
    typeof request.requestId === 'string' &&
    typeof request.sourceAgentFolder === 'string' &&
    typeof request.toolName === 'string' &&
    (request.cardAffordances === undefined ||
      parsePermissionCardAffordances(request.cardAffordances) !== null)
  );
}
