import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../core/config.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { logger } from '../core/logger.js';
import { IPC_GROUP_SUBDIRS } from './agent-spawn-layout.js';
import {
  processMemoryRequest,
  writeMemoryResponse,
} from '../memory/memory-ipc.js';
import {
  BROWSER_IPC_ACTIONS,
  BrowserIpcAction,
  MEMORY_IPC_ACTIONS,
  MemoryIpcAction,
} from '@myclaw/contracts';
import {
  PermissionApprovalRequest,
  RegisteredGroup,
  UserQuestionRequest,
} from '../core/types.js';
import { validateIpcAuthToken } from './ipc-auth.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import type { IpcDeps } from './ipc-domain-types.js';
import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';
import { processTaskIpc, TaskIpcData } from './ipc-task-handler.js';

export type { IpcDeps } from './ipc-domain-types.js';
export { processTaskIpc } from './ipc-task-handler.js';

let ipcWatcherRunning = false;
const IPC_RATE_LIMIT_WINDOW_MS = 60_000;
const IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW = 300;
const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PERMISSION_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BROWSER_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const USER_QUESTION_IPC_REQUEST_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ipcRateLimitState = new Map<
  string,
  { windowStart: number; count: number }
>();

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

function ensureGroupIpcLayout(ipcBaseDir: string, groupFolder: string): void {
  const groupDir = path.join(ipcBaseDir, groupFolder);
  for (const subdir of IPC_GROUP_SUBDIRS) {
    fs.mkdirSync(path.join(groupDir, subdir), { recursive: true });
  }
}

function hasCompleteTrustedGroupIpcLayout(
  ipcBaseDir: string,
  groupFolder: string,
): boolean {
  const groupDir = path.join(ipcBaseDir, groupFolder);
  if (!isTrustedDirectory(groupDir)) return false;
  for (const subdir of IPC_GROUP_SUBDIRS) {
    if (!isTrustedDirectory(path.join(groupDir, subdir))) return false;
  }
  return true;
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

function parseTaskIpcData(raw: unknown, sourceGroup: string): TaskIpcData {
  if (!isPlainObject(raw)) throw new Error('Invalid IPC task payload');
  const authToken = toTrimmedString(raw.authToken, { maxLen: 512 }) || '';
  if (!validateIpcAuthToken(sourceGroup, authToken)) {
    throw new Error('Invalid IPC task auth token');
  }
  const type = toTrimmedString(raw.type, { maxLen: 80 });
  if (!type) throw new Error('IPC task type is required');
  const parsed: TaskIpcData = { type };
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

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  const initializedLayoutFolders = new Set<string>();

  const processIpcFiles = async () => {
    const registeredGroups = deps.registeredGroups();
    const allowedFolders = new Set(
      Object.values(registeredGroups)
        .map((group) => group.folder)
        .filter((folder): folder is string => isValidGroupFolder(folder)),
    );

    for (const folder of allowedFolders) {
      const groupDir = path.join(ipcBaseDir, folder);
      if (
        initializedLayoutFolders.has(folder) &&
        hasCompleteTrustedGroupIpcLayout(ipcBaseDir, folder)
      ) {
        continue;
      }

      if (fs.existsSync(groupDir) && !isTrustedDirectory(groupDir)) {
        initializedLayoutFolders.delete(folder);
        logger.warn(
          { sourceGroup: folder },
          'Skipping IPC layout pre-create for untrusted registered group directory',
        );
        continue;
      }

      try {
        ensureGroupIpcLayout(ipcBaseDir, folder);
        if (hasCompleteTrustedGroupIpcLayout(ipcBaseDir, folder)) {
          initializedLayoutFolders.add(folder);
        } else {
          initializedLayoutFolders.delete(folder);
        }
      } catch (err) {
        initializedLayoutFolders.delete(folder);
        logger.warn(
          { sourceGroup: folder, err },
          'Failed to pre-create IPC layout for registered group',
        );
      }
    }

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
              const response = await processBrowserIpcRequest(request, {
                sourceGroup,
                isMain,
              });
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
              const decision = await processPermissionIpcRequest(request, {
                requestPermissionApproval: deps.requestPermissionApproval,
              });
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
              const response = await processUserQuestionIpcRequest(request, {
                requestUserAnswer: deps.requestUserAnswer,
              });
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
