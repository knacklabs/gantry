import { MEMORY_IPC_ACTIONS, MemoryIpcAction } from '@gantry/contracts';

import {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
  InteractionDescriptor,
  InteractionDetail,
  UserQuestionRequest,
} from '../domain/types.js';
import {
  BROWSER_BACKEND_ACTIONS,
  type BrowserBackendAction,
} from '../shared/browser-backend-actions.js';
import { parseSemanticCapabilityDefinitionsRecord } from '../shared/semantic-capabilities.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import {
  validateBrowserIpcAuthRequest,
  validateIpcAuthRequest,
  validateMemoryIpcAuthRequest,
} from './ipc-auth-validation.js';

const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PERMISSION_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BROWSER_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const USER_QUESTION_IPC_REQUEST_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PUBLIC_BROWSER_GATEWAY_TOOL_NAMES = new Set([
  'browser_status',
  'browser_open',
  'browser_inspect',
  'browser_act',
  'browser_close',
]);

export interface ParsedIpcMessage {
  type: 'message';
  chatJid: string;
  text: string;
  sender?: string;
  threadId?: string;
}

export interface ParsedMemoryIpcRequest {
  requestId: string;
  action: MemoryIpcAction;
  payload: Record<string, unknown>;
  responseKeyId?: string;
  deadlineAtMs?: number;
  allowedActions: readonly MemoryIpcAction[];
  context?: {
    threadId?: string;
    chatJid?: string;
    userId?: string;
    defaultScope?: 'user' | 'group';
    reviewerIsControlApprover?: boolean;
  };
}

export interface ParsedBrowserIpcRequest {
  requestId: string;
  action: BrowserBackendAction;
  payload: Record<string, unknown>;
  chatJid: string;
  threadId?: string;
  responseKeyId?: string;
  jobId?: string;
  runId?: string;
  appId?: string;
  agentId?: string;
  publicToolName?: string;
  timeoutMs?: number;
  deadlineAtMs?: number;
}

const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_KEYS = 40;
const TOOL_INPUT_MAX_STRING_LENGTH = 500;
const SECRET_KEY_PATTERN =
  /(secret|token|password|credential|api[_-]?key|key)/i;
const PERMISSION_UPDATE_TYPES = new Set<PermissionApprovalUpdate['type']>([
  'addRules',
  'replaceRules',
  'removeRules',
  'setMode',
  'addDirectories',
  'removeDirectories',
]);
const PERMISSION_BEHAVIORS = new Set<
  NonNullable<PermissionApprovalUpdate['behavior']>
>(['allow', 'deny', 'ask']);
const PERMISSION_DESTINATIONS = new Set<
  NonNullable<PermissionApprovalUpdate['destination']>
>(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);
const PERMISSION_DECISION_MODES = new Set<PermissionApprovalDecisionMode>([
  'allow_once',
  'allow_persistent_rule',
  'allow_timed_grant',
  'cancel',
]);

function sanitizeToolInputValue(value: unknown, depth: number): unknown {
  if (depth > TOOL_INPUT_MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    if (value.length <= TOOL_INPUT_MAX_STRING_LENGTH) return value;
    return `${value.slice(0, TOOL_INPUT_MAX_STRING_LENGTH)}...[truncated]`;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => sanitizeToolInputValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (seen >= TOOL_INPUT_MAX_KEYS) {
        out.__omitted_keys = 'more';
        break;
      }
      seen += 1;
      const entry = (value as Record<string, unknown>)[key];
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeToolInputValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeToolInput(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  return sanitizeToolInputValue(value, 0) as Record<string, unknown>;
}

function parsePermissionRuleValues(
  raw: unknown,
): PermissionApprovalUpdate['rules'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules: NonNullable<PermissionApprovalUpdate['rules']> = [];
  for (const item of raw.slice(0, 20)) {
    if (!isPlainObject(item)) continue;
    const toolName = toTrimmedString(item.toolName, { maxLen: 120 });
    if (!toolName) continue;
    const ruleContent = toTrimmedString(item.ruleContent, {
      maxLen: 500,
      allowEmpty: true,
    });
    rules.push({
      toolName,
      ...(ruleContent !== undefined ? { ruleContent } : {}),
    });
  }
  return rules.length ? rules : undefined;
}

function parsePermissionDirectories(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const directories = raw
    .slice(0, 50)
    .map((entry) => toTrimmedString(entry, { maxLen: 2048 }))
    .filter((entry): entry is string => Boolean(entry));
  return directories.length ? directories : undefined;
}

function parsePermissionApprovalUpdates(
  raw: unknown,
): PermissionApprovalUpdate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const updates: PermissionApprovalUpdate[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!isPlainObject(item)) continue;
    const type = toTrimmedString(item.type, { maxLen: 32 });
    if (
      !PERMISSION_UPDATE_TYPES.has(type as PermissionApprovalUpdate['type'])
    ) {
      continue;
    }
    const update: PermissionApprovalUpdate = {
      type: type as PermissionApprovalUpdate['type'],
    };
    const behavior = toTrimmedString(item.behavior, { maxLen: 16 });
    if (
      PERMISSION_BEHAVIORS.has(
        behavior as NonNullable<PermissionApprovalUpdate['behavior']>,
      )
    ) {
      update.behavior = behavior as NonNullable<
        PermissionApprovalUpdate['behavior']
      >;
    }
    const destination = toTrimmedString(item.destination, { maxLen: 32 });
    if (
      PERMISSION_DESTINATIONS.has(
        destination as NonNullable<PermissionApprovalUpdate['destination']>,
      )
    ) {
      update.destination = destination as NonNullable<
        PermissionApprovalUpdate['destination']
      >;
    }
    const mode = toTrimmedString(item.mode, { maxLen: 120 });
    if (mode) update.mode = mode;
    const rules = parsePermissionRuleValues(item.rules);
    if (rules) update.rules = rules;
    const directories = parsePermissionDirectories(item.directories);
    if (directories) update.directories = directories;
    updates.push(update);
  }
  return updates.length ? updates : undefined;
}

function parseClosestPermissionRule(
  raw: unknown,
): PermissionApprovalRequest['closestRule'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const rule = toTrimmedString(raw.rule, { maxLen: 500 });
  const reason = toTrimmedString(raw.reason, { maxLen: 2000 });
  return rule && reason ? { rule, reason } : undefined;
}

function parsePermissionDecisionOptions(
  raw: unknown,
): PermissionApprovalDecisionMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw
    .slice(0, 8)
    .map((entry) => toTrimmedString(entry, { maxLen: 64 }))
    .filter((entry): entry is PermissionApprovalDecisionMode =>
      PERMISSION_DECISION_MODES.has(entry as PermissionApprovalDecisionMode),
    );
  return options.length ? [...new Set(options)] : undefined;
}

function parseInteractionDetails(
  raw: unknown,
): InteractionDetail[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const details: InteractionDetail[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!isPlainObject(item)) continue;
    const label = toTrimmedString(item.label, { maxLen: 120 });
    const value = toTrimmedString(item.value, { maxLen: 2000 });
    if (!label || !value) continue;
    details.push({
      label,
      value,
      ...(typeof item.mono === 'boolean' ? { mono: item.mono } : {}),
    });
  }
  return details.length ? details : undefined;
}

function parseInteractionDescriptor(
  raw: unknown,
): InteractionDescriptor | undefined {
  if (!isPlainObject(raw)) return undefined;
  const id = toTrimmedString(raw.id, { maxLen: 128 });
  const title = toTrimmedString(raw.title, { maxLen: 200 });
  if (!id || !title) return undefined;
  const body = toTrimmedString(raw.body, { maxLen: 4000 });
  const details = parseInteractionDetails(raw.details);
  const requestContext = isPlainObject(raw.requestContext)
    ? raw.requestContext
    : undefined;
  const capabilityId = toTrimmedString(requestContext?.capabilityId, {
    maxLen: 160,
  });
  const capabilityDisplayName = toTrimmedString(
    requestContext?.capabilityDisplayName,
    { maxLen: 200 },
  );
  const toolName = toTrimmedString(requestContext?.toolName, { maxLen: 120 });
  const capabilityType = toTrimmedString(requestContext?.capabilityType, {
    maxLen: 120,
  });
  return {
    id,
    title,
    ...(body ? { body } : {}),
    ...(details ? { details } : {}),
    ...(capabilityId || capabilityDisplayName || toolName || capabilityType
      ? {
          requestContext: {
            ...(capabilityId ? { capabilityId } : {}),
            ...(capabilityDisplayName ? { capabilityDisplayName } : {}),
            ...(toolName ? { toolName } : {}),
            ...(capabilityType ? { capabilityType } : {}),
          },
        }
      : {}),
  };
}

function normalizeBrowserBackendAction(
  rawAction: string,
): BrowserBackendAction | undefined {
  if (BROWSER_BACKEND_ACTIONS.includes(rawAction as BrowserBackendAction)) {
    return rawAction as BrowserBackendAction;
  }
  return undefined;
}

export function parseIpcMessage(
  raw: unknown,
  sourceAgentFolder: string,
): ParsedIpcMessage {
  if (!isPlainObject(raw)) throw new Error('Invalid IPC message payload');
  const { authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'IPC message',
  );
  const type = toTrimmedString(raw.type, { maxLen: 64 });
  if (type !== 'message') throw new Error('Invalid IPC message type');
  const chatJid = toTrimmedString(raw.chatJid, { maxLen: 255 });
  const text = toTrimmedString(raw.text, { maxLen: 20000 });
  if (!chatJid || !text) throw new Error('Invalid IPC message fields');
  const sender = toTrimmedString(raw.sender, { maxLen: 255 });
  return {
    type: 'message',
    chatJid,
    text,
    ...(sender ? { sender } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function parseMemoryIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): ParsedMemoryIpcRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid memory IPC payload');
  const {
    authThreadId: threadId,
    chatJid,
    responseKeyId,
    userId,
    defaultScope,
    reviewerIsControlApprover,
    allowedActions,
  } = validateMemoryIpcAuthRequest(raw, sourceAgentFolder, 'memory IPC');
  if (!responseKeyId) {
    throw new Error('memory IPC responseKeyId is required');
  }
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  const action = toTrimmedString(raw.action, { maxLen: 64 });
  if (!requestId || !action) {
    throw new Error('Invalid memory IPC request envelope');
  }
  if (!MEMORY_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid memory IPC requestId');
  }
  if (!MEMORY_IPC_ACTIONS.includes(action as MemoryIpcAction)) {
    throw new Error(`Unsupported memory IPC action: ${action}`);
  }
  if (!allowedActions.includes(action as MemoryIpcAction)) {
    throw new Error(`Memory IPC action is not allowed: ${action}`);
  }
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    throw new Error('Invalid memory IPC payload body');
  }
  const rawExpiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : '';
  const deadlineAtMs = Date.parse(rawExpiresAt);
  return {
    requestId,
    action: action as MemoryIpcAction,
    payload,
    allowedActions,
    ...(responseKeyId ? { responseKeyId } : {}),
    ...(Number.isFinite(deadlineAtMs) ? { deadlineAtMs } : {}),
    ...(threadId ||
    chatJid ||
    userId ||
    defaultScope ||
    reviewerIsControlApprover
      ? {
          context: {
            ...(threadId ? { threadId } : {}),
            ...(chatJid ? { chatJid } : {}),
            ...(userId ? { userId } : {}),
            ...(defaultScope ? { defaultScope } : {}),
            ...(reviewerIsControlApprover ? { reviewerIsControlApprover } : {}),
          },
        }
      : {}),
  };
}

export function parsePermissionIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): PermissionApprovalRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid permission IPC payload');
  const binding = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'permission IPC',
  );
  const appId = binding.appId;
  if (!appId) {
    throw new Error('permission IPC context.appId is required');
  }
  if (!binding.responseKeyId) {
    throw new Error('permission IPC responseKeyId is required');
  }
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !PERMISSION_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid permission IPC requestId');
  }
  const responseNonce = toTrimmedString(raw.responseNonce, { maxLen: 128 });
  const toolName = toTrimmedString(raw.toolName, { maxLen: 120 });
  if (!toolName) throw new Error('Permission IPC toolName is required');
  const title = toTrimmedString(raw.title, { maxLen: 2000 });
  const displayName = toTrimmedString(raw.displayName, { maxLen: 200 });
  const description = toTrimmedString(raw.description, { maxLen: 4000 });
  const decisionReason = toTrimmedString(raw.decisionReason, { maxLen: 2000 });
  const blockedPath = toTrimmedString(raw.blockedPath, { maxLen: 2048 });
  const toolUseID = toTrimmedString(raw.toolUseID, { maxLen: 200 });
  const agentID = toTrimmedString(raw.agentID, { maxLen: 200 });
  const agentId = binding.agentId;
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const payloadJobId = toTrimmedString(raw.jobId, { maxLen: 200 });
  const contextJobId = toTrimmedString(context?.jobId, { maxLen: 200 });
  if (payloadJobId && contextJobId && payloadJobId !== contextJobId) {
    throw new Error('permission IPC jobId mismatch');
  }
  const jobId = payloadJobId ?? contextJobId;
  const jobName =
    toTrimmedString(raw.jobName, { maxLen: 200 }) ??
    toTrimmedString(context?.jobName, { maxLen: 200 });
  const payloadRunId = toTrimmedString(raw.runId, { maxLen: 200 });
  const contextRunId = toTrimmedString(context?.runId, { maxLen: 200 });
  if (payloadRunId && contextRunId && payloadRunId !== contextRunId) {
    throw new Error('permission IPC runId mismatch');
  }
  const runId = payloadRunId ?? contextRunId;
  const payloadTargetJid = toTrimmedString(raw.targetJid, { maxLen: 255 });
  const contextTargetJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  if (
    payloadTargetJid &&
    contextTargetJid &&
    payloadTargetJid !== contextTargetJid
  ) {
    throw new Error('permission IPC targetJid mismatch');
  }
  const targetJid = payloadTargetJid ?? contextTargetJid;
  const subagentType = toTrimmedString(raw.subagentType, { maxLen: 200 });
  const toolInput = sanitizeToolInput(raw.toolInput);
  const suggestions = parsePermissionApprovalUpdates(raw.suggestions);
  const semanticCapabilityDefinitions =
    parseSemanticCapabilityDefinitionsRecord(raw.semanticCapabilityDefinitions);
  const decisionOptions = parsePermissionDecisionOptions(raw.decisionOptions);
  const closestRule = parseClosestPermissionRule(raw.closestRule);
  const interaction = parseInteractionDescriptor(raw.interaction);

  return {
    requestId,
    appId,
    ...(agentId ? { agentId } : {}),
    ...(responseNonce ? { responseNonce } : {}),
    sourceAgentFolder,
    ...(jobId ? { jobId } : {}),
    ...(jobName ? { jobName } : {}),
    ...(runId ? { runId } : {}),
    ...(targetJid ? { targetJid } : {}),
    ...(binding.authThreadId ? { threadId: binding.authThreadId } : {}),
    ...(binding.responseKeyId ? { responseKeyId: binding.responseKeyId } : {}),
    toolName,
    ...(toolUseID ? { toolUseID } : {}),
    ...(agentID ? { agentID } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(title ? { title } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(closestRule ? { closestRule } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(semanticCapabilityDefinitions ? { semanticCapabilityDefinitions } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(decisionOptions ? { decisionOptions } : {}),
    ...(interaction ? { interaction } : {}),
  };
}

export function parseUserQuestionIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): UserQuestionRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid user question IPC payload');
  const { authThreadId: threadId, responseKeyId } = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'user question IPC',
  );
  if (!responseKeyId) {
    throw new Error('user question IPC responseKeyId is required');
  }

  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !USER_QUESTION_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid user question IPC requestId');
  }

  if (!Array.isArray(raw.questions)) {
    throw new Error('User question IPC questions are required');
  }
  if (raw.questions.length < 1 || raw.questions.length > 4) {
    throw new Error('User question IPC must include 1-4 questions');
  }

  const questions: UserQuestionRequest['questions'] = raw.questions.map(
    (item, index) => {
      if (!isPlainObject(item)) {
        throw new Error(`Invalid question payload at index ${index}`);
      }
      const question = toTrimmedString(item.question, { maxLen: 500 });
      const header = toTrimmedString(item.header, { maxLen: 64 });
      if (!question || !header) {
        throw new Error(`Missing question/header at index ${index}`);
      }
      if (!Array.isArray(item.options)) {
        throw new Error(`Missing options at index ${index}`);
      }
      if (item.options.length < 2 || item.options.length > 4) {
        throw new Error(`Question at index ${index} must have 2-4 options`);
      }
      const options = item.options.map((option, optionIndex) => {
        if (!isPlainObject(option)) {
          throw new Error(
            `Invalid option payload at index ${index}:${optionIndex}`,
          );
        }
        const label = toTrimmedString(option.label, { maxLen: 120 });
        const description = toTrimmedString(option.description, {
          maxLen: 500,
          allowEmpty: true,
        });
        const preview = toTrimmedString(option.preview, {
          maxLen: 1200,
          allowEmpty: true,
        });
        if (!label) {
          throw new Error(
            `Option label missing at index ${index}:${optionIndex}`,
          );
        }
        return {
          label,
          description: description || '',
          ...(preview ? { preview } : {}),
        };
      });
      return {
        question,
        header,
        options,
        multiSelect: Boolean(item.multiSelect),
      };
    },
  );

  return {
    requestId,
    sourceAgentFolder,
    ...(threadId ? { threadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
    questions,
  };
}

export function parseBrowserIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): ParsedBrowserIpcRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid browser IPC payload');
  const {
    authThreadId: threadId,
    chatJid,
    responseKeyId,
  } = validateBrowserIpcAuthRequest(raw, sourceAgentFolder, 'browser IPC');
  if (!responseKeyId) {
    throw new Error('browser IPC responseKeyId is required');
  }
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  const rawAction = toTrimmedString(raw.action, { maxLen: 64 });
  if (!requestId || !rawAction) {
    throw new Error('Invalid browser IPC request envelope');
  }
  if (!BROWSER_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid browser IPC requestId');
  }
  const action = normalizeBrowserBackendAction(rawAction);
  if (!action) {
    throw new Error(`Unsupported browser IPC action: ${rawAction}`);
  }
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    throw new Error('Invalid browser IPC payload body');
  }
  const context = isPlainObject(raw.context) ? raw.context : {};
  const rawTimeoutMs = context.timeoutMs;
  const jobId = toTrimmedString(context.jobId, { maxLen: 128 });
  const runId = toTrimmedString(context.runId, { maxLen: 128 });
  const appId = toTrimmedString(context.appId, { maxLen: 128 });
  const agentId = toTrimmedString(context.agentId, { maxLen: 128 });
  const publicToolName = toTrimmedString(context.publicToolName, {
    maxLen: 128,
  });
  if (
    publicToolName &&
    !PUBLIC_BROWSER_GATEWAY_TOOL_NAMES.has(publicToolName)
  ) {
    throw new Error(`Unsupported browser public tool: ${publicToolName}`);
  }
  const timeoutMs =
    typeof rawTimeoutMs === 'number' && Number.isFinite(rawTimeoutMs)
      ? Math.max(1_000, Math.min(120_000, Math.trunc(rawTimeoutMs)))
      : undefined;
  const rawExpiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : '';
  const deadlineAtMs = Date.parse(rawExpiresAt);
  return {
    requestId,
    action,
    payload,
    chatJid,
    ...(threadId ? { threadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(runId ? { runId } : {}),
    ...(appId ? { appId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(publicToolName ? { publicToolName } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(Number.isFinite(deadlineAtMs) ? { deadlineAtMs } : {}),
  };
}
