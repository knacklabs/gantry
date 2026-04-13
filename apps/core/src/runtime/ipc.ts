import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from '../core/config.js';
import { AvailableGroup } from './agent-spawn.js';
import {
  deleteJob,
  getJobById,
  listDeadLetterRuns,
  listJobRuns,
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
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  RegisteredGroup,
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

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
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
}

let ipcWatcherRunning = false;
const IPC_RATE_LIMIT_WINDOW_MS = 60_000;
const IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW = 300;
const MEMORY_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PERMISSION_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BROWSER_IPC_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
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
  createdBy?: 'agent' | 'human';
  timeoutMs?: number;
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
  const groupScope = toTrimmedString(raw.groupScope, { maxLen: 128 });
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
  const numericFields = {
    timeoutMs: toOptionalNumber(raw.timeoutMs, { min: 1000, max: 3_600_000 }),
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
  if (groupScope) parsed.groupScope = groupScope;
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
  if (numericFields.timeoutMs !== undefined)
    parsed.timeoutMs = Math.round(numericFields.timeoutMs);
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

  return {
    requestId,
    sourceGroup,
    toolName,
    ...(title ? { title } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
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
    groupScope?: string;
    createdBy?: 'agent' | 'human';
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    maxConsecutiveFailures?: number;
    statuses?: string[];
    limit?: number;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    agentConfig?: RegisteredGroup['agentConfig'];
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

      let linkedSessions = Array.isArray(data.linkedSessions)
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
        group_scope: groupScope,
        created_by: 'agent',
        status: 'active',
        next_run: nextRun,
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
      if (Array.isArray(data.linkedSessions)) {
        const linked = data.linkedSessions.map((item) => String(item));
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

    case 'scheduler_get_dead_letter': {
      listDeadLetterRuns(typeof data.limit === 'number' ? data.limit : 50);
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

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
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
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
