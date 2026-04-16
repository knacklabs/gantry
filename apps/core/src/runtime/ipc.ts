import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import {
  AGENT_ROOT,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MINI_APP_API_URL,
  MINI_APP_ENABLED,
  MINI_APP_FRONTEND_URL,
  TIMEZONE,
} from '../core/config.js';
import { AvailableGroup } from './agent-spawn.js';
import {
  deleteJob,
  getJobById,
  listDeadLetterRuns,
  listJobRuns,
  listRecentJobEvents,
  upsertJob,
  updateJob,
} from '../storage/db.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { logger } from '../core/logger.js';
import {
  processMemoryRequest,
  writeMemoryResponse,
} from '../memory/memory-ipc.js';
import {
  MEMORY_IPC_ACTIONS,
  MemoryIpcAction,
} from '../memory/memory-ipc-contract.js';
import {
  JobExecutionMode,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PlanReviewPrompt,
  RegisteredGroup,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../core/types.js';
import { validateIpcAuthToken } from './ipc-auth.js';
import {
  BrowserIpcAction,
  BROWSER_IPC_ACTIONS,
} from './browser-ipc-contract.js';
import { createProfile } from './browser-profiles.js';
import {
  DEFAULT_BROWSER_PROFILE_NAME,
  closeBrowser,
  getBrowserStatus,
  launchBrowser,
} from './browser-manager.js';
import {
  createPlan,
  getPlanById,
  setPlanStatus,
  updatePlanSection,
} from '../mini-app/plan-store.js';
import { validateRuntimePreflight } from '../cli/runtime-preflight.js';
import {
  getServiceStatus,
  startService,
  stopService,
} from '../cli/service-manager.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPlanReviewPrompt?: (
    jid: string,
    prompt: PlanReviewPrompt,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onSchedulerChanged: () => void;
  requestPermissionApproval?: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  requestUserAnswer?: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
}

let ipcWatcherRunning = false;
const IPC_RATE_LIMIT_WINDOW_MS = 60_000;
const IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW = 300;
const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PERMISSION_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BROWSER_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PLAN_TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const USER_QUESTION_IPC_REQUEST_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PLAN_SECTION_STATUS_VALUES = new Set([
  'pending',
  'approved',
  'rejected',
  'editing',
  'executing',
  'done',
]);
const PLAN_STATUS_VALUES = new Set([
  'draft',
  'reviewing',
  'approved',
  'rejected',
  'executing',
]);
const ipcRateLimitState = new Map<
  string,
  { windowStart: number; count: number }
>();

function normalizeIpcExecutionMode(
  executionMode: unknown,
  serialize: unknown,
  fallback: JobExecutionMode = 'parallel',
): JobExecutionMode {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean') {
    return serialize ? 'serialized' : 'parallel';
  }
  return fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTrimmedString(
  value: unknown,
  opts: { maxLen?: number; allowEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!opts.allowEmpty && trimmed.length === 0) return undefined;
  if (opts.maxLen && trimmed.length > opts.maxLen) return undefined;
  return trimmed;
}

function toOptionalStringArray(
  value: unknown,
  maxItems = 100,
  maxLen = 255,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > maxItems) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const parsed = toTrimmedString(entry, { maxLen });
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toOptionalNumber(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (opts.min !== undefined && value < opts.min) return undefined;
  if (opts.max !== undefined && value > opts.max) return undefined;
  return value;
}

const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_STRING_LENGTH = 500;
const SECRET_KEY_PATTERN =
  /(secret|token|password|credential|api[_-]?key|key)/i;

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
    for (const [key, entry] of Object.entries(value)) {
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

function canProcessIpcFile(sourceGroup: string, kind: string): boolean {
  const now = Date.now();
  const key = `${sourceGroup}:${kind}`;
  const state = ipcRateLimitState.get(key);
  if (!state || now - state.windowStart >= IPC_RATE_LIMIT_WINDOW_MS) {
    ipcRateLimitState.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (state.count >= IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW) {
    return false;
  }
  state.count += 1;
  return true;
}

function isTrustedDirectory(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function claimIpcFile(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('IPC payload must be a regular file');
  }
  const claimed = path.join(
    path.dirname(filePath),
    `.processing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(filePath)}`,
  );
  fs.renameSync(filePath, claimed);
  return claimed;
}

function archiveIpcErrorFile(
  ipcBaseDir: string,
  sourceGroup: string,
  filename: string,
  claimedPath: string,
): void {
  const errorDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(errorDir, { recursive: true });
  try {
    fs.renameSync(
      claimedPath,
      path.join(errorDir, `${sourceGroup}-${filename}`),
    );
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code !== 'ENOENT') {
      throw err;
    }
  }
}

interface ParsedIpcMessage {
  type: 'message';
  chatJid: string;
  text: string;
  sender?: string;
}

function parseIpcMessage(raw: unknown, sourceGroup: string): ParsedIpcMessage {
  if (!isPlainObject(raw)) throw new Error('Invalid IPC message payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid IPC message auth token');
  }
  const type = toTrimmedString(raw.type, { maxLen: 64 });
  if (type !== 'message') throw new Error('Invalid IPC message type');
  const chatJid = toTrimmedString(raw.chatJid, { maxLen: 255 });
  const text = toTrimmedString(raw.text, { maxLen: 20000 });
  if (!chatJid || !text) throw new Error('Invalid IPC message fields');
  const sender = toTrimmedString(raw.sender, { maxLen: 255 });
  return { type: 'message', chatJid, text, ...(sender ? { sender } : {}) };
}

interface ParsedTaskIpcData {
  type: string;
  taskId?: string;
  prompt?: string;
  model?: string;
  schedule_type?: 'cron' | 'interval' | 'once' | 'manual';
  schedule_value?: string;
  context_mode?: string;
  script?: string;
  jobId?: string;
  scheduleType?: 'cron' | 'interval' | 'once' | 'manual';
  linkedSessions?: string[];
  groupScope?: string;
  threadId?: string;
  runAt?: string;
  deliverTo?: string[];
  createdBy?: 'agent' | 'human';
  silent?: boolean;
  timeoutMs?: number;
  cleanupAfterMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  statuses?: string[];
  limit?: number;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  agentConfig?: RegisteredGroup['agentConfig'];
  payload?: Record<string, unknown>;
}

function toScheduleType(
  value: unknown,
): 'cron' | 'interval' | 'once' | 'manual' | undefined {
  const parsed = toTrimmedString(value, { maxLen: 32 });
  if (
    parsed === 'cron' ||
    parsed === 'interval' ||
    parsed === 'once' ||
    parsed === 'manual'
  ) {
    return parsed;
  }
  return undefined;
}

function parseAgentConfigPayload(
  value: unknown,
): RegisteredGroup['agentConfig'] | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return undefined;
  const model = toTrimmedString(value.model, { maxLen: 120 });
  const timeout = toOptionalNumber(value.timeout, {
    min: 1000,
    max: 3_600_000,
  });
  const parsed: RegisteredGroup['agentConfig'] = {};
  if (model) parsed.model = model;
  if (timeout !== undefined) parsed.timeout = Math.round(timeout);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseTaskIpcData(
  raw: unknown,
  sourceGroup: string,
): ParsedTaskIpcData {
  if (!isPlainObject(raw)) throw new Error('Invalid IPC task payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid IPC task auth token');
  }
  const type = toTrimmedString(raw.type, { maxLen: 80 });
  if (!type) throw new Error('IPC task type is required');
  const parsed: ParsedTaskIpcData = { type };
  const taskId = toTrimmedString(raw.taskId, { maxLen: 128 });
  const prompt = toTrimmedString(raw.prompt, { maxLen: 20000 });
  const model = toTrimmedString(raw.model, { maxLen: 120 });
  const scheduleType = toScheduleType(raw.scheduleType);
  const scheduleTypeSnake = toScheduleType(raw.schedule_type);
  const scheduleValue = toTrimmedString(raw.scheduleValue, {
    maxLen: 1024,
    allowEmpty: true,
  });
  const scheduleValueSnake = toTrimmedString(raw.schedule_value, {
    maxLen: 1024,
    allowEmpty: true,
  });
  const contextMode = toTrimmedString(raw.context_mode, { maxLen: 64 });
  const script = toTrimmedString(raw.script, {
    maxLen: 50_000,
    allowEmpty: true,
  });
  const jobId = toTrimmedString(raw.jobId, { maxLen: 128 });
  const linkedSessions = toOptionalStringArray(raw.linkedSessions, 200, 255);
  const deliverToArray =
    toOptionalStringArray(raw.deliverTo, 200, 255) ??
    toOptionalStringArray(raw.deliver_to, 200, 255);
  const deliverToSingle =
    toTrimmedString(raw.deliverTo, { maxLen: 255 }) ??
    toTrimmedString(raw.deliver_to, { maxLen: 255 });
  const deliverTo =
    deliverToArray || (deliverToSingle ? [deliverToSingle] : undefined);
  const groupScope = toTrimmedString(raw.groupScope, { maxLen: 128 });
  const threadId =
    toTrimmedString(raw.threadId, { maxLen: 255, allowEmpty: true }) ??
    toTrimmedString(raw.thread_id, { maxLen: 255, allowEmpty: true });
  const runAt =
    toTrimmedString(raw.runAt, {
      maxLen: 1024,
      allowEmpty: true,
    }) ?? toTrimmedString(raw.run_at, { maxLen: 1024, allowEmpty: true });
  const silent = toOptionalBoolean(raw.silent);
  const createdByRaw = toTrimmedString(raw.createdBy, { maxLen: 16 });
  const statuses = toOptionalStringArray(raw.statuses, 50, 64);
  const groupFolder = toTrimmedString(raw.groupFolder, { maxLen: 128 });
  const chatJid = toTrimmedString(raw.chatJid, { maxLen: 255 });
  const targetJid = toTrimmedString(raw.targetJid, { maxLen: 255 });
  const jid = toTrimmedString(raw.jid, { maxLen: 255 });
  const name = toTrimmedString(raw.name, { maxLen: 255 });
  const folder = toTrimmedString(raw.folder, { maxLen: 128 });
  const trigger = toTrimmedString(raw.trigger, { maxLen: 255 });
  const requiresTrigger = toOptionalBoolean(raw.requiresTrigger);
  const agentConfig = parseAgentConfigPayload(raw.agentConfig);
  const payload = isPlainObject(raw.payload) ? raw.payload : undefined;
  const numericFields = {
    timeoutMs: toOptionalNumber(raw.timeoutMs, { min: 1000, max: 3_600_000 }),
    cleanupAfterMs:
      toOptionalNumber(raw.cleanupAfterMs, {
        min: 0,
        max: 31_536_000_000,
      }) ??
      toOptionalNumber(raw.cleanup_after_ms, {
        min: 0,
        max: 31_536_000_000,
      }),
    maxRetries: toOptionalNumber(raw.maxRetries, { min: 0, max: 100 }),
    retryBackoffMs: toOptionalNumber(raw.retryBackoffMs, {
      min: 0,
      max: 86_400_000,
    }),
    maxConsecutiveFailures: toOptionalNumber(raw.maxConsecutiveFailures, {
      min: 1,
      max: 1000,
    }),
    limit: toOptionalNumber(raw.limit, { min: 1, max: 1000 }),
  };

  if (taskId) parsed.taskId = taskId;
  if (prompt !== undefined) parsed.prompt = prompt;
  if (model !== undefined) parsed.model = model;
  if (scheduleType !== undefined) parsed.scheduleType = scheduleType;
  if (scheduleTypeSnake !== undefined) parsed.schedule_type = scheduleTypeSnake;
  if (scheduleValue !== undefined) parsed.schedule_value = scheduleValue;
  if (scheduleValueSnake !== undefined)
    parsed.schedule_value = scheduleValueSnake;
  if (contextMode) parsed.context_mode = contextMode;
  if (script !== undefined) parsed.script = script;
  if (jobId) parsed.jobId = jobId;
  if (linkedSessions !== undefined) parsed.linkedSessions = linkedSessions;
  if (deliverTo !== undefined) parsed.deliverTo = deliverTo;
  if (groupScope) parsed.groupScope = groupScope;
  if (threadId !== undefined) parsed.threadId = threadId || '';
  if (runAt !== undefined) parsed.runAt = runAt;
  if (silent !== undefined) parsed.silent = silent;
  if (createdByRaw === 'agent' || createdByRaw === 'human') {
    parsed.createdBy = createdByRaw;
  }
  if (statuses !== undefined) parsed.statuses = statuses;
  if (groupFolder) parsed.groupFolder = groupFolder;
  if (chatJid) parsed.chatJid = chatJid;
  if (targetJid) parsed.targetJid = targetJid;
  if (jid) parsed.jid = jid;
  if (name) parsed.name = name;
  if (folder) parsed.folder = folder;
  if (trigger) parsed.trigger = trigger;
  if (requiresTrigger !== undefined) parsed.requiresTrigger = requiresTrigger;
  if (agentConfig !== undefined) parsed.agentConfig = agentConfig;
  if (payload !== undefined) parsed.payload = payload;
  if (numericFields.timeoutMs !== undefined)
    parsed.timeoutMs = Math.round(numericFields.timeoutMs);
  if (numericFields.cleanupAfterMs !== undefined)
    parsed.cleanupAfterMs = Math.round(numericFields.cleanupAfterMs);
  if (numericFields.maxRetries !== undefined)
    parsed.maxRetries = Math.round(numericFields.maxRetries);
  if (numericFields.retryBackoffMs !== undefined)
    parsed.retryBackoffMs = Math.round(numericFields.retryBackoffMs);
  if (numericFields.maxConsecutiveFailures !== undefined)
    parsed.maxConsecutiveFailures = Math.round(
      numericFields.maxConsecutiveFailures,
    );
  if (numericFields.limit !== undefined)
    parsed.limit = Math.round(numericFields.limit);
  return parsed;
}

function parseMemoryIpcRequest(
  raw: unknown,
  sourceGroup: string,
): {
  requestId: string;
  action: MemoryIpcAction;
  payload: Record<string, unknown>;
} {
  if (!isPlainObject(raw)) throw new Error('Invalid memory IPC payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid memory IPC auth token');
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
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    throw new Error('Invalid memory IPC payload body');
  }
  return {
    requestId,
    action: action as MemoryIpcAction,
    payload,
  };
}

function parsePermissionIpcRequest(
  raw: unknown,
  sourceGroup: string,
): PermissionApprovalRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid permission IPC payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid permission IPC auth token');
  }
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  if (!requestId || !PERMISSION_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid permission IPC requestId');
  }
  const toolName = toTrimmedString(raw.toolName, { maxLen: 120 });
  if (!toolName) throw new Error('Permission IPC toolName is required');
  const title = toTrimmedString(raw.title, { maxLen: 2000 });
  const displayName = toTrimmedString(raw.displayName, { maxLen: 200 });
  const description = toTrimmedString(raw.description, { maxLen: 4000 });
  const decisionReason = toTrimmedString(raw.decisionReason, { maxLen: 2000 });
  const blockedPath = toTrimmedString(raw.blockedPath, { maxLen: 2048 });
  const toolInput = sanitizeToolInput(raw.toolInput);

  return {
    requestId,
    sourceGroup,
    toolName,
    ...(title ? { title } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(toolInput ? { toolInput } : {}),
  };
}

function writePermissionIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  decision: PermissionApprovalDecision & { requestId: string },
): void {
  const responseDir = path.join(
    ipcBaseDir,
    sourceGroup,
    'permission-responses',
  );
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${decision.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        requestId: decision.requestId,
        approved: decision.approved,
        ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, responsePath);
}

function parseUserQuestionIpcRequest(
  raw: unknown,
  sourceGroup: string,
): UserQuestionRequest {
  if (!isPlainObject(raw)) throw new Error('Invalid user question IPC payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid user question IPC auth token');
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
    sourceGroup,
    questions,
  };
}

function writeUserQuestionIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  response: UserQuestionResponse,
): void {
  const responseDir = path.join(ipcBaseDir, sourceGroup, 'user-answers');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${response.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  const safeAnswers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(response.answers || {})) {
    const safeKey = toTrimmedString(key, { maxLen: 500 });
    if (!safeKey) continue;
    if (typeof value === 'string') {
      safeAnswers[safeKey] = value.slice(0, 500);
      continue;
    }
    if (Array.isArray(value)) {
      const filtered = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.slice(0, 200))
        .slice(0, 20);
      safeAnswers[safeKey] = filtered;
    }
  }
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        requestId: response.requestId,
        answers: safeAnswers,
        ...(response.answeredBy ? { answeredBy: response.answeredBy } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, responsePath);
}

function parseBrowserIpcRequest(
  raw: unknown,
  sourceGroup: string,
): {
  requestId: string;
  action: BrowserIpcAction;
  payload: Record<string, unknown>;
} {
  if (!isPlainObject(raw)) throw new Error('Invalid browser IPC payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid browser IPC auth token');
  }
  const requestId = toTrimmedString(raw.requestId, { maxLen: 128 });
  const action = toTrimmedString(raw.action, { maxLen: 64 });
  if (!requestId || !action) {
    throw new Error('Invalid browser IPC request envelope');
  }
  if (!BROWSER_IPC_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('Invalid browser IPC requestId');
  }
  if (!BROWSER_IPC_ACTIONS.includes(action as BrowserIpcAction)) {
    throw new Error(`Unsupported browser IPC action: ${action}`);
  }
  const payload = raw.payload === undefined ? {} : raw.payload;
  if (!isPlainObject(payload)) {
    throw new Error('Invalid browser IPC payload body');
  }
  return {
    requestId,
    action: action as BrowserIpcAction,
    payload,
  };
}

function writeBrowserIpcResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  response: { requestId: string; ok: boolean; data?: unknown; error?: string },
): void {
  const responseDir = path.join(ipcBaseDir, sourceGroup, 'browser-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${response.requestId}.json`);
  const tmpPath = `${responsePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        requestId: response.requestId,
        ok: response.ok,
        ...(response.data !== undefined ? { data: response.data } : {}),
        ...(response.error ? { error: response.error } : {}),
      },
      null,
      2,
    ),
  );
  fs.renameSync(tmpPath, responsePath);
}

function getProfileNameFromPayload(payload: Record<string, unknown>): string {
  const requested = toTrimmedString(payload.profile_name, { maxLen: 64 });
  if (!requested) return DEFAULT_BROWSER_PROFILE_NAME;
  const normalized = requested.toLowerCase();
  if (normalized !== DEFAULT_BROWSER_PROFILE_NAME) {
    throw new Error(
      `Only browser profile \"${DEFAULT_BROWSER_PROFILE_NAME}\" is supported`,
    );
  }
  return normalized;
}

async function processBrowserIpcRequest(
  request: {
    requestId: string;
    action: BrowserIpcAction;
    payload: Record<string, unknown>;
  },
  sourceGroup: string,
  isMain: boolean,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const mainOnlyActions = new Set<BrowserIpcAction>([
    'browser_profile_list',
    'browser_launch',
    'browser_close',
    'browser_status',
  ]);

  if (!isMain && mainOnlyActions.has(request.action)) {
    return {
      ok: false,
      error: `Browser action ${request.action} is restricted to the main group`,
    };
  }

  try {
    switch (request.action) {
      case 'browser_profile_list': {
        const profile = createProfile(DEFAULT_BROWSER_PROFILE_NAME);
        const profiles = [
          {
            name: profile.name,
            created_at: profile.metadata.created_at,
            last_used: profile.metadata.last_used,
            cdp_port: profile.metadata.cdp_port,
            auth_markers: profile.metadata.auth_markers || [],
            has_state: fs.existsSync(profile.statePath),
          },
        ];
        return { ok: true, data: { profiles } };
      }

      case 'browser_launch': {
        const profileName = getProfileNameFromPayload(request.payload);
        const status = await launchBrowser({
          profileName,
          headless: toOptionalBoolean(request.payload.headless),
          cdpPort: toOptionalNumber(request.payload.cdp_port, {
            min: 1024,
            max: 65535,
          }),
          keepAliveMs: toOptionalNumber(request.payload.keep_alive_ms, {
            min: 10_000,
            max: 3_600_000,
          }),
        });
        return { ok: true, data: status };
      }

      case 'browser_close': {
        const profileName = getProfileNameFromPayload(request.payload);
        const closed = await closeBrowser(profileName);
        return { ok: true, data: closed };
      }

      case 'browser_status': {
        const profileName = getProfileNameFromPayload(request.payload);
        return { ok: true, data: getBrowserStatus(profileName) };
      }

      default:
        return {
          ok: false,
          error: `Unsupported browser action: ${String(request.action)}`,
        };
    }
  } catch (err) {
    logger.warn(
      {
        err,
        sourceGroup,
        action: request.action,
        requestId: request.requestId,
      },
      'Browser IPC request failed',
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Browser IPC request failed',
    };
  }
}

function jobBelongsToSourceGroup(
  job: { group_scope: string; linked_sessions: string[] },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (job.group_scope !== sourceGroup) return false;
  return job.linked_sessions.every((jid) => {
    const group = registeredGroups[jid];
    return !!group && group.folder === sourceGroup;
  });
}

function generateJobId(params: {
  name: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  groupScope: string;
}): string {
  const base = JSON.stringify({
    name: params.name,
    prompt: params.prompt,
    scheduleType: params.scheduleType,
    scheduleValue: params.scheduleValue,
    groupScope: params.groupScope,
  });
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 12);
  const slug = params.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `job-${slug || 'scheduled'}-${hash}`;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function buildPlanUrl(planId: string): string | undefined {
  if (!MINI_APP_ENABLED) return undefined;
  const frontend = MINI_APP_FRONTEND_URL.trim();
  if (!frontend) return undefined;
  const base = `${frontend.replace(/\/+$/, '')}/plans/${planId}`;
  const api = MINI_APP_API_URL.trim();
  if (!api) return base;
  return `${base}?api=${encodeURIComponent(api)}`;
}

function writePlanTaskResponse(
  sourceGroup: string,
  taskId: string | undefined,
  payload: {
    ok: boolean;
    planId?: string;
    plan?: unknown;
    url?: string;
    error?: string;
    warning?: string;
  },
): void {
  if (!taskId || !PLAN_TASK_ID_PATTERN.test(taskId)) return;
  if (!isValidGroupFolder(sourceGroup)) return;
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'plan-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `task-${taskId}.json`);
  writeJsonAtomic(responsePath, {
    taskId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

function writeTaskIpcResponse(
  sourceGroup: string,
  taskId: string | undefined,
  payload: {
    ok: boolean;
    message?: string;
    error?: string;
    details?: string[];
  },
): void {
  if (!taskId || !PLAN_TASK_ID_PATTERN.test(taskId)) return;
  if (!isValidGroupFolder(sourceGroup)) return;
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'task-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `task-${taskId}.json`);
  writeJsonAtomic(responsePath, {
    taskId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

function restartServiceForRuntimeHome(runtimeHome: string): {
  ok: boolean;
  message: string;
} {
  try {
    const serviceStatus = getServiceStatus(runtimeHome);
    // launchd uses kickstart -k for in-place restart; bootout first can unload it.
    if (serviceStatus.kind === 'launchd') {
      const startOutcome = startService(runtimeHome);
      if (!startOutcome.ok) {
        return { ok: false, message: startOutcome.message };
      }
      return {
        ok: true,
        message: `${startOutcome.message} (restart completed).`,
      };
    }

    const stopOutcome = stopService(runtimeHome);
    if (!stopOutcome.ok) {
      return { ok: false, message: stopOutcome.message };
    }
    const startOutcome = startService(runtimeHome);
    if (!startOutcome.ok) {
      return {
        ok: false,
        message: `Restart failed after stop: ${startOutcome.message}`,
      };
    }
    return {
      ok: true,
      message: `${startOutcome.message} (restart completed).`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan group IPC directories (identity determined by directory)
    let discoveredGroupFolders: string[];
    try {
      discoveredGroupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        if (f === 'errors') return false;
        const groupPath = path.join(ipcBaseDir, f);
        const trusted = isTrustedDirectory(groupPath);
        if (!trusted && fs.existsSync(groupPath)) {
          logger.warn(
            { sourceGroup: f },
            'Ignoring untrusted IPC directory (not a regular directory or symlink)',
          );
        }
        return trusted;
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const allowedFolders = new Set(
      Object.values(registeredGroups).map((group) => group.folder),
    );
    const groupFolders: string[] = [];
    for (const folder of discoveredGroupFolders) {
      if (allowedFolders.size > 0 && !allowedFolders.has(folder)) {
        logger.warn({ sourceGroup: folder }, 'Ignoring unknown IPC directory');
        continue;
      }
      groupFolders.push(folder);
    }

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const memoryRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'memory-requests',
      );
      const browserRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'browser-requests',
      );
      const permissionRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'permission-requests',
      );
      const userQuestionRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'user-questions',
      );

      // Process messages from this group's IPC directory
      try {
        if (isTrustedDirectory(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceGroup, 'messages')) {
                throw new Error('IPC message rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawData = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
              const data = parseIpcMessage(rawData, sourceGroup);
              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              if (
                isMain ||
                (targetGroup && targetGroup.folder === sourceGroup)
              ) {
                await deps.sendMessage(data.chatJid, data.text);
                logger.info(
                  { chatJid: data.chatJid, sourceGroup },
                  'IPC message sent',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              }
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(messagesDir)) {
          logger.warn(
            { sourceGroup, messagesDir },
            'Ignoring untrusted IPC messages directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (isTrustedDirectory(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceGroup, 'tasks')) {
                throw new Error('IPC task rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawData = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
              const data = parseTaskIpcData(rawData, sourceGroup);
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(tasksDir)) {
          logger.warn(
            { sourceGroup, tasksDir },
            'Ignoring untrusted IPC tasks directory',
          );
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process memory request/response IPC for this group
      try {
        if (isTrustedDirectory(memoryRequestsDir)) {
          const memoryFiles = fs
            .readdirSync(memoryRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of memoryFiles) {
            const filePath = path.join(memoryRequestsDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceGroup, 'memory')) {
                throw new Error('Memory IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseMemoryIpcRequest(rawRequest, sourceGroup);

              const response = await processMemoryRequest(
                {
                  requestId: request.requestId,
                  action: request.action,
                  payload: request.payload || {},
                },
                sourceGroup,
                isMain,
              );
              writeMemoryResponse(sourceGroup, request.requestId, response);
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing memory IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(memoryRequestsDir)) {
          logger.warn(
            { sourceGroup, memoryRequestsDir },
            'Ignoring untrusted memory IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading memory IPC requests directory',
        );
      }

      // Process browser request/response IPC for this group
      try {
        if (isTrustedDirectory(browserRequestsDir)) {
          const browserFiles = fs
            .readdirSync(browserRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of browserFiles) {
            const filePath = path.join(browserRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceGroup, 'browser')) {
                throw new Error('Browser IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseBrowserIpcRequest(rawRequest, sourceGroup);
              requestId = request.requestId;
              const response = await processBrowserIpcRequest(
                request,
                sourceGroup,
                isMain,
              );
              writeBrowserIpcResponse(ipcBaseDir, sourceGroup, {
                requestId,
                ok: response.ok,
                data: response.data,
                error: response.error,
              });
              fs.unlinkSync(claimedPath);
            } catch (err) {
              if (requestId) {
                try {
                  writeBrowserIpcResponse(ipcBaseDir, sourceGroup, {
                    requestId,
                    ok: false,
                    error: 'Failed to process browser request',
                  });
                } catch (writeErr) {
                  logger.warn(
                    { sourceGroup, requestId, err: writeErr },
                    'Failed to write browser IPC error fallback',
                  );
                }
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing browser IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(browserRequestsDir)) {
          logger.warn(
            { sourceGroup, browserRequestsDir },
            'Ignoring untrusted browser IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading browser IPC requests directory',
        );
      }

      // Process permission request/response IPC for this group
      try {
        if (isTrustedDirectory(permissionRequestsDir)) {
          const permissionFiles = fs
            .readdirSync(permissionRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of permissionFiles) {
            const filePath = path.join(permissionRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceGroup, 'permission')) {
                throw new Error('Permission IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parsePermissionIpcRequest(
                rawRequest,
                sourceGroup,
              );
              requestId = request.requestId;
              const decision = deps.requestPermissionApproval
                ? await deps.requestPermissionApproval(request)
                : {
                    approved: false,
                    reason: 'No channel approval handler is configured',
                  };
              writePermissionIpcResponse(ipcBaseDir, sourceGroup, {
                requestId,
                approved: decision.approved,
                decidedBy: decision.decidedBy,
                reason: decision.reason,
              });
              fs.unlinkSync(claimedPath);
            } catch (err) {
              if (requestId) {
                try {
                  writePermissionIpcResponse(ipcBaseDir, sourceGroup, {
                    requestId,
                    approved: false,
                    reason: 'Failed to process permission request',
                  });
                } catch (writeErr) {
                  logger.warn(
                    { sourceGroup, requestId, err: writeErr },
                    'Failed to write permission IPC denial fallback',
                  );
                }
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing permission IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(permissionRequestsDir)) {
          logger.warn(
            { sourceGroup, permissionRequestsDir },
            'Ignoring untrusted permission IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading permission IPC requests directory',
        );
      }

      // Process AskUserQuestion request/response IPC for this group
      try {
        if (isTrustedDirectory(userQuestionRequestsDir)) {
          const questionFiles = fs
            .readdirSync(userQuestionRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of questionFiles) {
            const filePath = path.join(userQuestionRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceGroup, 'user-question')) {
                throw new Error('User question IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseUserQuestionIpcRequest(
                rawRequest,
                sourceGroup,
              );
              requestId = request.requestId;
              const response = deps.requestUserAnswer
                ? await deps.requestUserAnswer(request)
                : {
                    requestId,
                    answers: {},
                  };
              writeUserQuestionIpcResponse(ipcBaseDir, sourceGroup, {
                requestId,
                answers: response.answers || {},
                answeredBy: response.answeredBy,
              });
              fs.unlinkSync(claimedPath);
            } catch (err) {
              if (requestId) {
                try {
                  writeUserQuestionIpcResponse(ipcBaseDir, sourceGroup, {
                    requestId,
                    answers: {},
                  });
                } catch (writeErr) {
                  logger.warn(
                    { sourceGroup, requestId, err: writeErr },
                    'Failed to write user question IPC fallback response',
                  );
                }
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing user question IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(userQuestionRequestsDir)) {
          logger.warn(
            { sourceGroup, userQuestionRequestsDir },
            'Ignoring untrusted user question IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading user question IPC requests directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    model?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    jobId?: string;
    scheduleType?: string;
    scheduleValue?: string;
    linkedSessions?: string[];
    deliverTo?: string[];
    groupScope?: string;
    threadId?: string;
    runAt?: string;
    createdBy?: 'agent' | 'human';
    silent?: boolean;
    timeoutMs?: number;
    cleanupAfterMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    maxConsecutiveFailures?: number;
    executionMode?: string;
    serialize?: boolean;
    statuses?: string[];
    runId?: string;
    eventType?: string;
    sinceId?: number;
    limit?: number;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_agent
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    agentConfig?: RegisteredGroup['agentConfig'];
    payload?: Record<string, unknown>;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const sourceGroupJids = Object.entries(registeredGroups)
    .filter(([, group]) => group.folder === sourceGroup)
    .map(([jid]) => jid);

  switch (data.type) {
    case 'scheduler_once': {
      const name = (data.name || '').trim();
      const prompt = (data.prompt || '').trim();
      const runAtRaw = (data.runAt || data.schedule_value || '').trim();
      if (!name || !prompt || !runAtRaw) break;
      if (typeof data.script === 'string' && data.script.trim().length > 0) {
        logger.warn(
          { sourceGroup, name },
          'Rejected scheduler_once with script payload from IPC',
        );
        break;
      }

      const runAtDate = new Date(runAtRaw);
      if (isNaN(runAtDate.getTime())) {
        logger.warn({ runAtRaw }, 'Invalid run_at for scheduler_once');
        break;
      }

      const groupScope = (data.groupScope || sourceGroup).trim();
      if (!isMain && groupScope !== sourceGroup) {
        logger.warn(
          { sourceGroup, groupScope },
          'Unauthorized scheduler_once attempt blocked',
        );
        break;
      }

      let linkedSessions = Array.isArray(data.deliverTo)
        ? data.deliverTo.map((item) => String(item)).filter((item) => item)
        : sourceGroupJids;
      if (linkedSessions.length === 0) {
        linkedSessions = Array.isArray(data.linkedSessions)
          ? data.linkedSessions
              .map((item) => String(item))
              .filter((item) => item.length > 0)
          : sourceGroupJids;
      }
      if (linkedSessions.length === 0) linkedSessions = sourceGroupJids;
      if (linkedSessions.length === 0) {
        logger.warn(
          { sourceGroup, name },
          'scheduler_once requires at least one delivery session',
        );
        break;
      }

      if (!isMain) {
        const unauthorized = linkedSessions.some((jid) => {
          const group = registeredGroups[jid];
          return !group || group.folder !== sourceGroup;
        });
        if (unauthorized) {
          logger.warn(
            { sourceGroup, linkedSessions },
            'Unauthorized linked sessions in scheduler_once',
          );
          break;
        }
      }

      const scheduleValue = runAtDate.toISOString();
      const requestedJobId = (data.jobId || '').toString().trim();
      let id = generateJobId({
        name,
        prompt,
        scheduleType: 'once',
        scheduleValue,
        groupScope,
      });
      if (requestedJobId) {
        const existing = getJobById(requestedJobId);
        if (existing) {
          if (
            !isMain &&
            !jobBelongsToSourceGroup(existing, sourceGroup, registeredGroups)
          ) {
            logger.warn(
              { sourceGroup, requestedJobId },
              'Rejected scheduler_once with cross-group jobId',
            );
            break;
          }
          id = requestedJobId;
        } else {
          id = requestedJobId;
        }
      }

      const upsertResult = upsertJob({
        id,
        name,
        prompt,
        model: data.model || null,
        script: null,
        schedule_type: 'once',
        schedule_value: scheduleValue,
        linked_sessions: linkedSessions,
        thread_id: data.threadId || null,
        group_scope: groupScope,
        created_by: 'agent',
        status: 'active',
        next_run: scheduleValue,
        silent: data.silent === true,
        cleanup_after_ms:
          typeof data.cleanupAfterMs === 'number'
            ? data.cleanupAfterMs
            : undefined,
        timeout_ms:
          typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined,
        max_retries:
          typeof data.maxRetries === 'number' ? data.maxRetries : undefined,
        retry_backoff_ms:
          typeof data.retryBackoffMs === 'number'
            ? data.retryBackoffMs
            : undefined,
        max_consecutive_failures:
          typeof data.maxConsecutiveFailures === 'number'
            ? data.maxConsecutiveFailures
            : undefined,
        execution_mode: normalizeIpcExecutionMode(
          data.executionMode,
          data.serialize,
        ),
      });

      logger.info(
        { id, created: upsertResult.created, sourceGroup, groupScope },
        'One-time job created via IPC',
      );
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_upsert_job': {
      const scheduleType = (data.schedule_type || data.scheduleType) as
        | 'cron'
        | 'interval'
        | 'once'
        | 'manual';
      const scheduleValue = (data.schedule_value || data.scheduleValue || '')
        .toString()
        .trim();
      const name = (data.name || '').trim();
      const prompt = (data.prompt || '').trim();
      if (!name || !prompt || !scheduleType) break;
      if (typeof data.script === 'string' && data.script.trim().length > 0) {
        logger.warn(
          { sourceGroup, name },
          'Rejected scheduler_upsert_job with script payload from IPC',
        );
        break;
      }

      const groupScope = (data.groupScope || sourceGroup).trim();
      if (!isMain && groupScope !== sourceGroup) {
        logger.warn(
          { sourceGroup, groupScope },
          'Unauthorized scheduler_upsert_job attempt blocked',
        );
        break;
      }

      let linkedSessions = Array.isArray(data.deliverTo)
        ? data.deliverTo
            .map((item) => String(item))
            .filter((item) => item.length > 0)
        : Array.isArray(data.linkedSessions)
          ? data.linkedSessions
              .map((item) => String(item))
              .filter((item) => item.length > 0)
          : sourceGroupJids;
      if (linkedSessions.length === 0) linkedSessions = sourceGroupJids;
      if (linkedSessions.length === 0) {
        logger.warn(
          { sourceGroup, name },
          'scheduler_upsert_job requires at least one linked session',
        );
        break;
      }

      if (!isMain) {
        const unauthorized = linkedSessions.some((jid) => {
          const group = registeredGroups[jid];
          return !group || group.folder !== sourceGroup;
        });
        if (unauthorized) {
          logger.warn(
            { sourceGroup, linkedSessions },
            'Unauthorized linked sessions in scheduler_upsert_job',
          );
          break;
        }
      }

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(scheduleValue, {
            tz: TIMEZONE,
          });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn({ scheduleValue }, 'Invalid cron expression for job');
          break;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn({ scheduleValue }, 'Invalid interval for job');
          break;
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (scheduleType === 'once') {
        const date = new Date(scheduleValue);
        if (isNaN(date.getTime())) {
          logger.warn({ scheduleValue }, 'Invalid once timestamp for job');
          break;
        }
        nextRun = date.toISOString();
      } else if (scheduleType === 'manual') {
        nextRun = null;
      } else {
        break;
      }

      const requestedJobId = (data.jobId || '').toString().trim();
      let id = generateJobId({
        name,
        prompt,
        scheduleType,
        scheduleValue,
        groupScope,
      });
      if (requestedJobId) {
        const existing = getJobById(requestedJobId);
        if (existing) {
          if (
            !isMain &&
            !jobBelongsToSourceGroup(existing, sourceGroup, registeredGroups)
          ) {
            logger.warn(
              { sourceGroup, requestedJobId },
              'Rejected scheduler_upsert_job with cross-group jobId',
            );
            break;
          }
          id = requestedJobId;
        } else {
          id = requestedJobId;
        }
      }
      const upsertResult = upsertJob({
        id,
        name,
        prompt,
        model: data.model || null,
        script: null,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        linked_sessions: linkedSessions,
        thread_id: data.threadId || null,
        group_scope: groupScope,
        created_by: 'agent',
        status: 'active',
        next_run: nextRun,
        silent: data.silent === true,
        cleanup_after_ms:
          typeof data.cleanupAfterMs === 'number'
            ? data.cleanupAfterMs
            : undefined,
        timeout_ms:
          typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined,
        max_retries:
          typeof data.maxRetries === 'number' ? data.maxRetries : undefined,
        retry_backoff_ms:
          typeof data.retryBackoffMs === 'number'
            ? data.retryBackoffMs
            : undefined,
        max_consecutive_failures:
          typeof data.maxConsecutiveFailures === 'number'
            ? data.maxConsecutiveFailures
            : undefined,
        execution_mode: normalizeIpcExecutionMode(
          data.executionMode,
          data.serialize,
        ),
      });

      logger.info(
        { id, created: upsertResult.created, sourceGroup, groupScope },
        'Job upserted via IPC',
      );
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_update_job': {
      const jobId = (data.jobId || data.taskId || '').toString();
      if (!jobId) break;
      const job = getJobById(jobId);
      if (!job) break;
      if (
        !isMain &&
        !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          {
            sourceGroup,
            groupScope: job.group_scope,
            linkedSessions: job.linked_sessions,
            jobId,
          },
          'Unauthorized scheduler_update_job attempt blocked',
        );
        break;
      }

      const updates: Parameters<typeof updateJob>[1] = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.prompt !== undefined) updates.prompt = data.prompt;
      if (data.model !== undefined) updates.model = data.model;
      if (data.script !== undefined) {
        logger.warn(
          { sourceGroup, jobId },
          'Rejected scheduler_update_job script mutation from IPC',
        );
        break;
      }
      if (data.schedule_type !== undefined)
        updates.schedule_type = data.schedule_type as
          | 'cron'
          | 'interval'
          | 'once'
          | 'manual';
      if (data.schedule_value !== undefined)
        updates.schedule_value = data.schedule_value;
      if (data.groupScope !== undefined) {
        if (!isMain && data.groupScope !== sourceGroup) {
          logger.warn(
            { sourceGroup, requestedGroupScope: data.groupScope, jobId },
            'Unauthorized group scope mutation in scheduler_update_job',
          );
          break;
        }
        updates.group_scope = data.groupScope;
      }
      if (typeof data.timeoutMs === 'number')
        updates.timeout_ms = data.timeoutMs;
      if (typeof data.maxRetries === 'number')
        updates.max_retries = data.maxRetries;
      if (typeof data.retryBackoffMs === 'number')
        updates.retry_backoff_ms = data.retryBackoffMs;
      if (typeof data.maxConsecutiveFailures === 'number')
        updates.max_consecutive_failures = data.maxConsecutiveFailures;
      if (typeof data.silent === 'boolean') updates.silent = data.silent;
      if (typeof data.cleanupAfterMs === 'number')
        updates.cleanup_after_ms = data.cleanupAfterMs;
      if (data.executionMode !== undefined || data.serialize !== undefined) {
        updates.execution_mode = normalizeIpcExecutionMode(
          data.executionMode,
          data.serialize,
          job.execution_mode,
        );
      }
      if (data.threadId !== undefined)
        updates.thread_id = data.threadId || null;
      if (Array.isArray(data.linkedSessions) || Array.isArray(data.deliverTo)) {
        const source = Array.isArray(data.deliverTo)
          ? data.deliverTo
          : data.linkedSessions || [];
        const linked = source.map((item) => String(item));
        if (!isMain) {
          const unauthorized = linked.some((jid) => {
            const group = registeredGroups[jid];
            return !group || group.folder !== sourceGroup;
          });
          if (unauthorized) {
            logger.warn(
              { sourceGroup, linked },
              'Unauthorized linked sessions in scheduler_update_job',
            );
            break;
          }
        }
        updates.linked_sessions = linked;
      }

      const merged = { ...job, ...updates };
      if (
        updates.schedule_type !== undefined ||
        updates.schedule_value !== undefined
      ) {
        if (merged.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(merged.schedule_value, {
              tz: TIMEZONE,
            });
            updates.next_run = interval.next().toISOString();
          } catch {
            logger.warn(
              { jobId, value: merged.schedule_value },
              'Invalid cron in scheduler_update_job',
            );
            break;
          }
        } else if (merged.schedule_type === 'interval') {
          const ms = parseInt(merged.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { jobId, value: merged.schedule_value },
              'Invalid interval in scheduler_update_job',
            );
            break;
          }
          updates.next_run = new Date(Date.now() + ms).toISOString();
        } else if (merged.schedule_type === 'once') {
          const date = new Date(merged.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { jobId, value: merged.schedule_value },
              'Invalid once timestamp in scheduler_update_job',
            );
            break;
          }
          updates.next_run = date.toISOString();
        } else {
          updates.next_run = null;
        }
      }

      updateJob(jobId, updates);
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_delete_job': {
      const jobId = (data.jobId || data.taskId || '').toString();
      if (!jobId) break;
      const job = getJobById(jobId);
      if (!job) break;
      if (
        !isMain &&
        !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          {
            sourceGroup,
            groupScope: job.group_scope,
            linkedSessions: job.linked_sessions,
            jobId,
          },
          'Unauthorized scheduler_delete_job attempt blocked',
        );
        break;
      }
      deleteJob(jobId);
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_pause_job': {
      const jobId = (data.jobId || data.taskId || '').toString();
      if (!jobId) break;
      const job = getJobById(jobId);
      if (!job) break;
      if (
        !isMain &&
        !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          {
            sourceGroup,
            groupScope: job.group_scope,
            linkedSessions: job.linked_sessions,
            jobId,
          },
          'Unauthorized scheduler_pause_job attempt blocked',
        );
        break;
      }
      updateJob(jobId, {
        status: 'paused',
        pause_reason: 'Paused by user',
      });
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_resume_job': {
      const jobId = (data.jobId || data.taskId || '').toString();
      if (!jobId) break;
      const job = getJobById(jobId);
      if (!job) break;
      if (
        !isMain &&
        !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          {
            sourceGroup,
            groupScope: job.group_scope,
            linkedSessions: job.linked_sessions,
            jobId,
          },
          'Unauthorized scheduler_resume_job attempt blocked',
        );
        break;
      }
      updateJob(jobId, {
        status: 'active',
        pause_reason: null,
        next_run: job.next_run || new Date().toISOString(),
      });
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_trigger_job': {
      const jobId = (data.jobId || data.taskId || '').toString();
      if (!jobId) break;
      const job = getJobById(jobId);
      if (!job) break;
      if (
        !isMain &&
        !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          {
            sourceGroup,
            groupScope: job.group_scope,
            linkedSessions: job.linked_sessions,
            jobId,
          },
          'Unauthorized scheduler_trigger_job attempt blocked',
        );
        break;
      }
      updateJob(jobId, {
        status: 'active',
        next_run: new Date().toISOString(),
        pause_reason: null,
      });
      deps.onSchedulerChanged();
      break;
    }

    case 'scheduler_list_runs': {
      // Read-only path backed by current_job_runs snapshot in the container.
      // This no-op path exists for audit logs and future host-side query routing.
      listJobRuns(undefined, typeof data.limit === 'number' ? data.limit : 50);
      break;
    }

    case 'scheduler_list_events':
    case 'scheduler_wait_for_events': {
      listRecentJobEvents(typeof data.limit === 'number' ? data.limit : 200, {
        job_id:
          typeof data.jobId === 'string' && data.jobId.trim().length > 0
            ? data.jobId.trim()
            : undefined,
        run_id:
          typeof data.runId === 'string' && data.runId.trim().length > 0
            ? data.runId.trim()
            : undefined,
        event_type:
          typeof data.eventType === 'string' && data.eventType.trim().length > 0
            ? data.eventType.trim()
            : undefined,
      });
      break;
    }

    case 'scheduler_get_dead_letter': {
      listDeadLetterRuns(typeof data.limit === 'number' ? data.limit : 50);
      break;
    }

    case 'plan_create': {
      const planTaskId = toTrimmedString(data.taskId, { maxLen: 128 });
      if (!isPlainObject(data.payload)) {
        logger.warn({ sourceGroup }, 'Rejected plan_create without payload');
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          error: 'Missing payload',
        });
        break;
      }
      const payload = data.payload;
      const title = toTrimmedString(payload.title, { maxLen: 400 });
      const planId = toTrimmedString(payload.planId, { maxLen: 128 });
      const chatJidFromPayload = toTrimmedString(payload.chatJid, {
        maxLen: 255,
      });
      const agentSessionId = toTrimmedString(payload.agentSessionId, {
        maxLen: 255,
      });
      const rawSections = Array.isArray(payload.sections)
        ? payload.sections
        : [];
      const sections: Array<{ title: string; content: string }> = [];
      for (const rawSection of rawSections) {
        if (!isPlainObject(rawSection)) continue;
        const sectionTitle = toTrimmedString(rawSection.title, { maxLen: 400 });
        const sectionContent =
          typeof rawSection.content === 'string'
            ? rawSection.content
            : undefined;
        if (!sectionTitle || sectionContent === undefined) continue;
        sections.push({ title: sectionTitle, content: sectionContent });
      }

      if (!title || sections.length === 0) {
        logger.warn(
          { sourceGroup, sectionCount: sections.length },
          'Rejected plan_create with missing title or sections',
        );
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          error: 'title and at least one section are required',
        });
        break;
      }

      let created;
      try {
        created = createPlan({
          ...(planId ? { planId } : {}),
          groupFolder: sourceGroup,
          chatJid: chatJidFromPayload || sourceGroupJids[0],
          title,
          sections,
          agentSessionId,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to create plan';
        logger.warn({ sourceGroup, err }, 'Plan creation failed via IPC task');
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          error: message,
        });
        break;
      }

      const targetJid = created.chatJid || sourceGroupJids[0];
      const url = buildPlanUrl(created.id);
      let notificationWarning: string | undefined;
      if (!targetJid) {
        logger.info(
          { planId: created.id, sourceGroup },
          'Plan created without target chat binding',
        );
      } else {
        const prompt: PlanReviewPrompt = {
          planId: created.id,
          title: created.title,
          sectionCount: created.sections.length,
          ...(url ? { url } : {}),
        };

        try {
          if (deps.sendPlanReviewPrompt) {
            await deps.sendPlanReviewPrompt(targetJid, prompt);
          } else {
            const lines = [
              `Plan ready: ${created.title}`,
              `${created.sections.length} sections are ready for review.`,
              ...(url ? [`Review in Mini App: ${url}`] : []),
            ];
            await deps.sendMessage(targetJid, lines.join('\n'));
          }
        } catch (err) {
          notificationWarning =
            err instanceof Error
              ? err.message
              : 'Failed to send plan review prompt';
          logger.warn(
            { sourceGroup, targetJid, planId: created.id, err },
            'Plan created but review prompt delivery failed',
          );
        }
      }

      writePlanTaskResponse(sourceGroup, planTaskId, {
        ok: true,
        planId: created.id,
        plan: getPlanById(created.id) || created,
        ...(url ? { url } : {}),
        ...(notificationWarning ? { warning: notificationWarning } : {}),
      });
      logger.info(
        { sourceGroup, targetJid, planId: created.id },
        'Plan created via IPC task',
      );
      break;
    }

    case 'plan_update_section': {
      const planTaskId = toTrimmedString(data.taskId, { maxLen: 128 });
      if (!isPlainObject(data.payload)) {
        logger.warn(
          { sourceGroup },
          'Rejected plan_update_section without payload',
        );
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          error: 'Missing payload',
        });
        break;
      }
      const payload = data.payload;
      const planId = toTrimmedString(payload.planId, { maxLen: 128 });
      const sectionIndex = toOptionalNumber(payload.sectionIndex, {
        min: 0,
        max: 10_000,
      });
      if (!planId || sectionIndex === undefined) {
        logger.warn(
          { sourceGroup },
          'Rejected plan_update_section with invalid planId/sectionIndex',
        );
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          error: 'Invalid planId or sectionIndex',
        });
        break;
      }

      const existingPlan = getPlanById(planId);
      if (!existingPlan) {
        logger.warn(
          { sourceGroup, planId },
          'Plan not found for section update',
        );
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          planId,
          error: 'Plan not found',
        });
        break;
      }
      if (!isMain && existingPlan.groupFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, planId, owner: existingPlan.groupFolder },
          'Unauthorized plan_update_section attempt blocked',
        );
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          planId,
          error: 'Unauthorized',
        });
        break;
      }

      const status = toTrimmedString(payload.status, { maxLen: 40 });
      const planStatus = toTrimmedString(payload.planStatus, { maxLen: 40 });
      try {
        updatePlanSection({
          planId,
          sectionIndex: Math.round(sectionIndex),
          ...(toTrimmedString(payload.title, { maxLen: 400 })
            ? { title: String(payload.title).trim() }
            : {}),
          ...(typeof payload.content === 'string'
            ? { content: payload.content }
            : {}),
          ...(status && PLAN_SECTION_STATUS_VALUES.has(status)
            ? {
                status: status as
                  | 'pending'
                  | 'approved'
                  | 'rejected'
                  | 'editing'
                  | 'executing'
                  | 'done',
              }
            : {}),
          ...(typeof payload.userFeedback === 'string'
            ? { userFeedback: payload.userFeedback }
            : {}),
          ...(typeof payload.agentRevision === 'string'
            ? { agentRevision: payload.agentRevision }
            : {}),
          ...(toTrimmedString(payload.decidedBy, { maxLen: 255 })
            ? { decidedBy: String(payload.decidedBy).trim() }
            : {}),
        });
        if (planStatus && PLAN_STATUS_VALUES.has(planStatus)) {
          setPlanStatus(
            planId,
            planStatus as
              | 'draft'
              | 'reviewing'
              | 'approved'
              | 'rejected'
              | 'executing',
          );
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update plan section';
        logger.warn(
          { sourceGroup, planId, sectionIndex: Math.round(sectionIndex), err },
          'Plan section update failed via IPC task',
        );
        writePlanTaskResponse(sourceGroup, planTaskId, {
          ok: false,
          planId,
          error: message,
        });
        break;
      }
      writePlanTaskResponse(sourceGroup, planTaskId, {
        ok: true,
        planId,
        plan: getPlanById(planId),
      });
      logger.info(
        { sourceGroup, planId, sectionIndex: Math.round(sectionIndex) },
        'Plan section updated via IPC task',
      );
      break;
    }

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_agent': {
      const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
      // Only main agent can register new agents
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_agent attempt blocked',
        );
        writeTaskIpcResponse(sourceGroup, taskId, {
          ok: false,
          error: 'Only the main agent can register new agents.',
        });
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_agent request - unsafe folder name',
          );
          writeTaskIpcResponse(sourceGroup, taskId, {
            ok: false,
            error: `Invalid agent folder: ${data.folder}`,
          });
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          agentConfig: data.agentConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
        writeTaskIpcResponse(sourceGroup, taskId, {
          ok: true,
          message: `Agent "${data.name}" registered.`,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_agent request - missing required fields',
        );
        writeTaskIpcResponse(sourceGroup, taskId, {
          ok: false,
          error: 'Missing required fields: jid, name, folder, trigger.',
        });
      }
      break;
    }

    case 'service_restart': {
      const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized service_restart attempt blocked',
        );
        writeTaskIpcResponse(sourceGroup, taskId, {
          ok: false,
          error: 'Only the main agent can restart the service.',
        });
        break;
      }

      try {
        const validation = validateRuntimePreflight(AGENT_ROOT);
        if (!validation.ok) {
          writeTaskIpcResponse(sourceGroup, taskId, {
            ok: false,
            error:
              validation.failure?.summary ||
              'Runtime configuration validation failed.',
            details: validation.failure?.details || [],
          });
          break;
        }

        writeTaskIpcResponse(sourceGroup, taskId, {
          ok: true,
          message: 'Service restart accepted. Restarting now.',
        });

        setTimeout(() => {
          const restartOutcome = restartServiceForRuntimeHome(AGENT_ROOT);
          if (!restartOutcome.ok) {
            logger.error(
              { sourceGroup, taskId, error: restartOutcome.message },
              'Service restart failed after acknowledgment',
            );
            return;
          }
          logger.info(
            { sourceGroup, taskId, message: restartOutcome.message },
            'Service restart completed',
          );
        }, 0);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Service restart failed with an unexpected error.';
        logger.error(
          { sourceGroup, taskId, err },
          'Error while handling service_restart IPC task',
        );
        writeTaskIpcResponse(sourceGroup, taskId, {
          ok: false,
          error: message,
        });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
