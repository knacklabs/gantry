import type {
  InteractionDescriptor,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import {
  permissionDisplayText,
  permissionDisplayToolInput,
} from '../../shared/permission-display-input.js';
import { sanitizeCredentialText } from '../../shared/sensitive-material.js';
import { parsePermissionCardAffordances } from '../permissions/permission-card-affordances.js';

const WHY_MAX_CHARS = 200;
const MESSAGE_PATTERN = /<message\b[^>]*>([\s\S]*?)(?:<\/message>|$)/g;
export interface DurablePermissionFullView {
  label: string;
  title: string;
  filename: string;
  content: string;
}

/**
 * The request a permission prompt is drawn from: the stored snapshot. Live
 * prompts render it too, so a prompt recovered after a restart shows exactly
 * what the live one did, and neither shows a secret.
 */
export function durablePermissionRequestSnapshot(
  request: PermissionApprovalRequest,
): PermissionApprovalRequest {
  const capabilityTemplateAmendment =
    request.toolName === 'capability_template_amendment';
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
    ...permissionPromptDisplayFields(request),
    ...(capabilityTemplateAmendment
      ? {
          requestFamily: request.requestFamily,
          description: request.description,
        }
      : {}),
  };
}

const displayText = (value: string | undefined) =>
  value === undefined ? undefined : permissionDisplayText(value);
const asIs = <T>(value: T) => value;

/** Every request field a prompt shows (what, which and why), with the
 *  sanitizer that hides its secrets. */
const PERMISSION_PROMPT_DISPLAY_FIELDS: {
  [K in keyof PermissionApprovalRequest]?: (
    value: PermissionApprovalRequest[K],
  ) => PermissionApprovalRequest[K];
} = {
  displayName: displayText,
  title: displayText,
  jobName: displayText,
  blockedPath: displayText,
  risk_level: asIs,
  risk_category: asIs,
  promotionHintCount: asIs,
  firstAskedAt: asIs,
  turnIntentSummary: permissionRequestWhyText,
  toolInput: permissionDisplayToolInput,
  interaction: displayInteraction,
};

function permissionPromptDisplayFields(
  request: PermissionApprovalRequest,
): Partial<PermissionApprovalRequest> {
  const fields: Record<string, unknown> = {};
  for (const [key, sanitize] of Object.entries(
    PERMISSION_PROMPT_DISPLAY_FIELDS,
  )) {
    const value = request[key as keyof PermissionApprovalRequest];
    if (value === undefined) continue;
    const shown = (sanitize as (input: unknown) => unknown)(value);
    if (shown !== undefined) fields[key] = shown;
  }
  return fields as Partial<PermissionApprovalRequest>;
}

function displayInteraction(
  interaction: InteractionDescriptor | undefined,
): InteractionDescriptor | undefined {
  if (!interaction) return undefined;
  const context = interaction.requestContext;
  return {
    id: interaction.id,
    title: permissionDisplayText(interaction.title),
    ...(interaction.body !== undefined
      ? { body: permissionDisplayText(interaction.body) }
      : {}),
    ...(context?.capabilityId || context?.capabilityDisplayName
      ? {
          requestContext: {
            capabilityId: displayText(context.capabilityId),
            capabilityDisplayName: displayText(context.capabilityDisplayName),
          },
        }
      : {}),
    ...(interaction.details
      ? {
          details: interaction.details.map((detail) => ({
            ...detail,
            label: permissionDisplayText(detail.label),
            value: permissionDisplayText(detail.value),
          })),
        }
      : {}),
    ...(interaction.files
      ? {
          files: interaction.files.map((file) => ({
            ...file,
            path: permissionDisplayText(file.path),
            ...(file.preview !== undefined
              ? { preview: permissionDisplayText(file.preview) }
              : {}),
          })),
        }
      : {}),
  };
}

/** What a permission request carries for its "why" line: the person's own
 *  request in this turn (a chat message, or a job's prompt). Every producer of
 *  a permission request goes through this, and no internal reason does. */
export function permissionTurnIntent(
  turnPrompt: string | undefined,
): Pick<PermissionApprovalRequest, 'turnIntentSummary'> {
  const why = permissionRequestWhyText(turnPrompt);
  return why ? { turnIntentSummary: why } : {};
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
  const result = sanitizeCredentialText(plain);
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
