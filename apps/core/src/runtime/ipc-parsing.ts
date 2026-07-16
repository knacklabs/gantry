import { MEMORY_IPC_ACTIONS, MemoryIpcAction } from '@gantry/contracts';

import {
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
  type RichInteractionRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import {
  BROWSER_BACKEND_ACTIONS,
  PUBLIC_BROWSER_GATEWAY_TOOL_NAMES,
  type BrowserBackendAction,
} from '../shared/browser-backend-actions.js';
import { parseIpcMessageFiles } from './ipc-message-files.js';
import { parseSemanticCapabilityDefinitionsRecord } from '../shared/semantic-capabilities.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import {
  validateBrowserIpcAuthRequest,
  validateConversationHistoryIpcAuthRequest,
  validateIpcAuthRequest,
  validateMemoryIpcAuthRequest,
} from './ipc-auth-validation.js';
import { parseInteractionDescriptor } from './ipc-interaction-descriptor-parsing.js';
import { sanitizeIpcToolInput } from './ipc-tool-input-sanitization.js';

const IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export interface ParsedIpcMessage {
  type: 'message';
  appId?: string;
  providerAccountId?: string;
  chatJid: string;
  text: string;
  sender?: string;
  threadId?: string;
  files?: ReturnType<typeof parseIpcMessageFiles>;
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

export interface ParsedConversationHistoryIpcRequest {
  requestId: string;
  chatJid: string;
  threadId: string;
  responseKeyId?: string;
  appId?: string;
  agentId?: string;
  limit?: number;
  maxChars?: number;
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
  'cancel',
]);
function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
  const { appId, authThreadId: threadId } = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'IPC message',
  );
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const providerAccountId =
    toTrimmedString(raw.providerAccountId, { maxLen: 255 }) ??
    toTrimmedString(context?.providerAccountId, { maxLen: 255 });
  const type = toTrimmedString(raw.type, { maxLen: 64 });
  if (type !== 'message') throw new Error('Invalid IPC message type');
  const chatJid = toTrimmedString(raw.chatJid, { maxLen: 255 });
  const text = toTrimmedString(raw.text, { maxLen: 20000 });
  if (!chatJid || !text) throw new Error('Invalid IPC message fields');
  const sender = toTrimmedString(raw.sender, { maxLen: 255 });
  const files = parseIpcMessageFiles(raw.files);
  return {
    type: 'message',
    ...(appId ? { appId } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
    chatJid,
    text,
    ...(sender ? { sender } : {}),
    ...(threadId ? { threadId } : {}),
    ...(files.length > 0 ? { files } : {}),
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
  if (!IPC_REQUEST_ID_PATTERN.test(requestId)) {
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

export function parseConversationHistoryIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): ParsedConversationHistoryIpcRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid conversation history IPC payload');
  }
  const binding = validateConversationHistoryIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'conversation history IPC',
  );
  if (!binding.responseKeyId) {
    throw new Error('conversation history IPC responseKeyId is required');
  }
  if (!binding.authThreadId) {
    throw new Error('conversation history IPC threadId is required');
  }
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid conversation history IPC requestId');
  }
  const payload = isPlainObject(raw.payload) ? raw.payload : {};
  const limit = toPositiveInteger(payload.limit);
  const maxChars = toPositiveInteger(payload.maxChars);
  const rawExpiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : '';
  const deadlineAtMs = Date.parse(rawExpiresAt);
  return {
    requestId,
    chatJid: binding.chatJid,
    threadId: binding.authThreadId,
    ...(binding.responseKeyId ? { responseKeyId: binding.responseKeyId } : {}),
    ...(binding.appId ? { appId: binding.appId } : {}),
    ...(binding.agentId ? { agentId: binding.agentId } : {}),
    ...(limit ? { limit } : {}),
    ...(maxChars ? { maxChars } : {}),
    ...(Number.isFinite(deadlineAtMs) ? { deadlineAtMs } : {}),
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
  if (!requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid permission IPC requestId');
  }
  const responseNonce = toTrimmedString(raw.responseNonce, { maxLen: 128 });
  const toolName = toTrimmedString(raw.toolName, { maxLen: 120 });
  if (!toolName) throw new Error('Permission IPC toolName is required');
  const title = toTrimmedString(raw.title, { maxLen: 2000 });
  const displayName = toTrimmedString(raw.displayName, { maxLen: 200 });
  const description = toTrimmedString(raw.description, { maxLen: 4000 });
  const decisionReason = toTrimmedString(raw.decisionReason, { maxLen: 2000 });
  const intent = toTrimmedString(raw.turnIntentSummary, { maxLen: 1_500 });
  const senderId = toTrimmedString(raw.senderId, { maxLen: 255 });
  const blockedPath = toTrimmedString(raw.blockedPath, { maxLen: 2048 });
  const toolUseID = toTrimmedString(raw.toolUseID, { maxLen: 200 });
  const agentID = toTrimmedString(raw.agentID, { maxLen: 200 });
  const agentId = binding.agentId;
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const providerAccountId =
    toTrimmedString(raw.providerAccountId, { maxLen: 255 }) ??
    toTrimmedString(context?.providerAccountId, { maxLen: 255 });
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
  const payloadRunLeaseToken = toTrimmedString(raw.runLeaseToken, {
    maxLen: 200,
  });
  const contextRunLeaseToken = toTrimmedString(context?.runLeaseToken, {
    maxLen: 200,
  });
  if (
    payloadRunLeaseToken &&
    contextRunLeaseToken &&
    payloadRunLeaseToken !== contextRunLeaseToken
  ) {
    throw new Error('permission IPC runLeaseToken mismatch');
  }
  const runLeaseToken = payloadRunLeaseToken ?? contextRunLeaseToken;
  const payloadRunLeaseFencingVersion = toPositiveInteger(
    raw.runLeaseFencingVersion,
  );
  const contextRunLeaseFencingVersion = toPositiveInteger(
    context?.runLeaseFencingVersion,
  );
  if (
    payloadRunLeaseFencingVersion &&
    contextRunLeaseFencingVersion &&
    payloadRunLeaseFencingVersion !== contextRunLeaseFencingVersion
  ) {
    throw new Error('permission IPC runLeaseFencingVersion mismatch');
  }
  const runLeaseFencingVersion =
    payloadRunLeaseFencingVersion ?? contextRunLeaseFencingVersion;
  if (jobId && runId && (!runLeaseToken || !runLeaseFencingVersion)) {
    throw new Error('permission IPC scheduled job lease identity is required');
  }
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
  const {
    toolInput,
    altered: toolInputSanitized,
    alteredPaths: toolInputSanitizedPaths,
  } = sanitizeIpcToolInput(raw.toolInput);
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
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(responseNonce ? { responseNonce } : {}),
    sourceAgentFolder,
    ...(jobId ? { jobId } : {}),
    ...(jobName ? { jobName } : {}),
    ...(runId ? { runId } : {}),
    ...(runLeaseToken ? { runLeaseToken } : {}),
    ...(runLeaseFencingVersion ? { runLeaseFencingVersion } : {}),
    ...(targetJid ? { targetJid } : {}),
    ...(binding.authThreadId ? { threadId: binding.authThreadId } : {}),
    ...(binding.responseKeyId ? { responseKeyId: binding.responseKeyId } : {}),
    ...(raw.unattended === true ? { unattended: true } : {}),
    ...(senderId ? { senderId } : {}),
    ...(intent ? { turnIntentSummary: intent } : {}),
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
    ...(toolInputSanitized ? { toolInputSanitized: true } : {}),
    ...(toolInputSanitizedPaths.length > 0 ? { toolInputSanitizedPaths } : {}),
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
  const binding = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'user question IPC',
  );
  const { authThreadId: threadId, responseKeyId } = binding;
  if (!responseKeyId) {
    throw new Error('user question IPC responseKeyId is required');
  }

  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid user question IPC requestId');
  }
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const appId = binding.appId;
  const agentId = binding.agentId;
  const providerAccountId =
    toTrimmedString(raw.providerAccountId, { maxLen: 255 }) ??
    toTrimmedString(context?.providerAccountId, { maxLen: 255 });
  const payloadJobId = toTrimmedString(raw.jobId, { maxLen: 200 });
  const contextJobId = toTrimmedString(context?.jobId, { maxLen: 200 });
  if (payloadJobId && contextJobId && payloadJobId !== contextJobId) {
    throw new Error('user question IPC jobId mismatch');
  }
  const jobId = payloadJobId ?? contextJobId;
  const payloadRunId = toTrimmedString(raw.runId, { maxLen: 200 });
  const contextRunId = toTrimmedString(context?.runId, { maxLen: 200 });
  if (payloadRunId && contextRunId && payloadRunId !== contextRunId) {
    throw new Error('user question IPC runId mismatch');
  }
  const runId = payloadRunId ?? contextRunId;
  const payloadRunLeaseToken = toTrimmedString(raw.runLeaseToken, {
    maxLen: 200,
  });
  const contextRunLeaseToken = toTrimmedString(context?.runLeaseToken, {
    maxLen: 200,
  });
  if (
    payloadRunLeaseToken &&
    contextRunLeaseToken &&
    payloadRunLeaseToken !== contextRunLeaseToken
  ) {
    throw new Error('user question IPC runLeaseToken mismatch');
  }
  const runLeaseToken = payloadRunLeaseToken ?? contextRunLeaseToken;
  const payloadRunLeaseFencingVersion = toPositiveInteger(
    raw.runLeaseFencingVersion,
  );
  const contextRunLeaseFencingVersion = toPositiveInteger(
    context?.runLeaseFencingVersion,
  );
  if (
    payloadRunLeaseFencingVersion &&
    contextRunLeaseFencingVersion &&
    payloadRunLeaseFencingVersion !== contextRunLeaseFencingVersion
  ) {
    throw new Error('user question IPC runLeaseFencingVersion mismatch');
  }
  const runLeaseFencingVersion =
    payloadRunLeaseFencingVersion ?? contextRunLeaseFencingVersion;
  if (jobId && runId && (!runLeaseToken || !runLeaseFencingVersion)) {
    throw new Error(
      'user question IPC scheduled job lease identity is required',
    );
  }
  const payloadTargetJid = toTrimmedString(raw.targetJid, { maxLen: 255 });
  const contextTargetJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  if (
    payloadTargetJid &&
    contextTargetJid &&
    payloadTargetJid !== contextTargetJid
  ) {
    throw new Error('user question IPC targetJid mismatch');
  }
  const targetJid = payloadTargetJid ?? contextTargetJid;

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
    ...(appId ? { appId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(runId ? { runId } : {}),
    ...(runLeaseToken ? { runLeaseToken } : {}),
    ...(runLeaseFencingVersion ? { runLeaseFencingVersion } : {}),
    ...(targetJid ? { targetJid } : {}),
    ...(threadId ? { threadId } : {}),
    ...(responseKeyId ? { responseKeyId } : {}),
    questions,
  };
}

export function parseRichInteractionIpcRequest(
  raw: unknown,
  sourceAgentFolder: string,
): RichInteractionRequest {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid rich interaction IPC payload');
  }
  const binding = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'rich interaction IPC',
  );
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid rich interaction IPC requestId');
  }
  const context = isPlainObject(raw.context) ? raw.context : undefined;
  const providerAccountId =
    toTrimmedString(raw.providerAccountId, { maxLen: 255 }) ??
    toTrimmedString(context?.providerAccountId, { maxLen: 255 });
  const payloadTargetJid = toTrimmedString(raw.targetJid, { maxLen: 255 });
  const contextTargetJid = toTrimmedString(context?.chatJid, { maxLen: 255 });
  if (
    payloadTargetJid &&
    contextTargetJid &&
    payloadTargetJid !== contextTargetJid
  ) {
    throw new Error('rich interaction IPC targetJid mismatch');
  }
  const descriptor = parseInteractionDescriptor(
    raw.interaction ?? raw.descriptor,
  );
  if (!descriptor?.rich) {
    throw new Error('Rich interaction descriptor is required');
  }
  const jobId = toTrimmedString(context?.jobId, { maxLen: 200 });
  const runId = toTrimmedString(context?.runId, { maxLen: 200 });
  return {
    requestId,
    sourceAgentFolder,
    ...(binding.appId ? { appId: binding.appId } : {}),
    ...(binding.agentId ? { agentId: binding.agentId } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(runId ? { runId } : {}),
    ...(payloadTargetJid || contextTargetJid
      ? { targetJid: payloadTargetJid ?? contextTargetJid }
      : {}),
    ...(binding.authThreadId ? { threadId: binding.authThreadId } : {}),
    descriptor,
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
  if (!IPC_REQUEST_ID_PATTERN.test(requestId)) {
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
