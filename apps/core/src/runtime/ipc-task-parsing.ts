import { ConversationRoute } from '../domain/types.js';
import { TaskIpcData } from '../jobs/ipc-handler.js';
import { resolveModelSelection } from '../shared/model-catalog.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { validateIpcAuthRequest } from './ipc-auth-validation.js';

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

function toScheduleType(
  value: unknown,
): 'cron' | 'interval' | 'once' | undefined {
  const parsed = toTrimmedString(value, { maxLen: 32 });
  if (parsed === 'cron' || parsed === 'interval' || parsed === 'once') {
    return parsed;
  }
  return undefined;
}

const DISALLOWED_TASK_FIELDS = [
  'task_id',
  'job_id',
  'model',
  'model_alias',
  'model_profile_id',
  'schedule_type',
  'schedule_value',
  'context_mode',
  'deliver_to',
  'linked_sessions',
  'group_scope',
  'thread_id',
  'run_at',
  'created_by',
  'cleanup_after_ms',
  'timeout_ms',
  'max_retries',
  'retry_backoff_ms',
  'max_consecutive_failures',
  'execution_mode',
  'run_id',
  'event_type',
  'group_folder',
  'chat_jid',
  'target_jid',
  'since_id',
] as const;

function findDisallowedTaskFields(raw: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of DISALLOWED_TASK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      found.push(key);
    }
  }
  return found;
}

function assertNoDisallowedTaskFields(raw: Record<string, unknown>): void {
  const fields = findDisallowedTaskFields(raw);
  if (fields.length === 0) return;
  throw new Error(
    `Unsupported IPC task fields: ${fields.join(
      ', ',
    )}. IPC tasks accept camelCase fields only.`,
  );
}

function parseAgentConfigPayload(
  value: unknown,
): ConversationRoute['agentConfig'] | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return undefined;
  const model = toTrimmedString(value.model, { maxLen: 120 });
  const timeout = toOptionalNumber(value.timeout, {
    min: 1000,
    max: 3_600_000,
  });
  const parsed: ConversationRoute['agentConfig'] = {};
  if (model) {
    const resolvedModel = resolveModelSelection(model);
    if (!resolvedModel.ok) {
      throw new Error(`Invalid agentConfig.model: ${resolvedModel.message}`);
    }
    parsed.model = resolvedModel.alias;
  }
  if (timeout !== undefined) parsed.timeout = Math.round(timeout);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseTaskIpcData(
  raw: unknown,
  sourceAgentFolder: string,
): TaskIpcData {
  if (!isPlainObject(raw)) throw new Error('Invalid IPC task payload');
  assertNoDisallowedTaskFields(raw);
  const threadBinding = validateIpcAuthRequest(
    raw,
    sourceAgentFolder,
    'IPC task',
  );
  const type = toTrimmedString(raw.type, { maxLen: 80 });
  if (!type) throw new Error('IPC task type is required');
  const parsed: TaskIpcData = { type };
  const taskId = toTrimmedString(raw.taskId, { maxLen: 128 });
  const prompt = toTrimmedString(raw.prompt, { maxLen: 20000 });
  const hasModelAlias = Object.prototype.hasOwnProperty.call(raw, 'modelAlias');
  const hasModelProfileId = Object.prototype.hasOwnProperty.call(
    raw,
    'modelProfileId',
  );
  const modelAlias =
    hasModelAlias && raw.modelAlias === null
      ? null
      : toTrimmedString(raw.modelAlias, { maxLen: 120 });
  const modelProfileId =
    hasModelProfileId && raw.modelProfileId === null
      ? null
      : toTrimmedString(raw.modelProfileId, { maxLen: 160 });
  const scheduleType = toScheduleType(raw.scheduleType);
  const scheduleValue = toTrimmedString(raw.scheduleValue, {
    maxLen: 1024,
    allowEmpty: true,
  });
  const contextMode = toTrimmedString(raw.contextMode, { maxLen: 64 });
  const script = toTrimmedString(raw.script, {
    maxLen: 50_000,
    allowEmpty: true,
  });
  const jobId = toTrimmedString(raw.jobId, { maxLen: 128 });
  const linkedSessions = toOptionalStringArray(raw.linkedSessions, 200, 255);
  const allowedTools = toOptionalStringArray(raw.allowedTools, 200, 255);
  const deliverToArray = toOptionalStringArray(raw.deliverTo, 200, 255);
  const deliverToSingle = toTrimmedString(raw.deliverTo, { maxLen: 255 });
  const deliverTo =
    deliverToArray || (deliverToSingle ? [deliverToSingle] : undefined);
  const groupScope = toTrimmedString(raw.groupScope, { maxLen: 128 });
  const silent = toOptionalBoolean(raw.silent);
  const serialize = toOptionalBoolean(raw.serialize);
  const executionModeRaw = toTrimmedString(raw.executionMode, { maxLen: 32 });
  const executionMode =
    executionModeRaw === 'parallel' || executionModeRaw === 'serialized'
      ? executionModeRaw
      : undefined;
  const createdByRaw = toTrimmedString(raw.createdBy, { maxLen: 16 });
  const statuses = toOptionalStringArray(raw.statuses, 50, 64);
  const runId = toTrimmedString(raw.runId, { maxLen: 128 });
  const eventType = toTrimmedString(raw.eventType, { maxLen: 128 });
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
    cleanupAfterMs: toOptionalNumber(raw.cleanupAfterMs, {
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
    sinceId: toOptionalNumber(raw.sinceId, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    limit: toOptionalNumber(raw.limit, { min: 1, max: 1000 }),
  };

  if (taskId) parsed.taskId = taskId;
  if (prompt !== undefined) parsed.prompt = prompt;
  if (hasModelAlias && modelAlias !== undefined) parsed.modelAlias = modelAlias;
  if (hasModelProfileId && modelProfileId !== undefined) {
    parsed.modelProfileId = modelProfileId;
  }
  if (scheduleType !== undefined) parsed.scheduleType = scheduleType;
  if (scheduleValue !== undefined) parsed.scheduleValue = scheduleValue;
  if (contextMode) parsed.contextMode = contextMode;
  if (script !== undefined) parsed.script = script;
  if (jobId) parsed.jobId = jobId;
  if (linkedSessions !== undefined) parsed.linkedSessions = linkedSessions;
  if (allowedTools !== undefined) parsed.allowedTools = allowedTools;
  if (deliverTo !== undefined) parsed.deliverTo = deliverTo;
  if (groupScope) parsed.groupScope = groupScope;
  if (threadBinding.authThreadId) {
    parsed.authThreadId = threadBinding.authThreadId;
  }
  if (threadBinding.payloadThreadId !== undefined) {
    parsed.threadId = threadBinding.payloadThreadId;
  }
  if (silent !== undefined) parsed.silent = silent;
  if (serialize !== undefined) parsed.serialize = serialize;
  if (executionMode !== undefined) parsed.executionMode = executionMode;
  if (createdByRaw === 'agent' || createdByRaw === 'human') {
    parsed.createdBy = createdByRaw;
  }
  if (statuses !== undefined) parsed.statuses = statuses;
  if (runId) parsed.runId = runId;
  if (eventType) parsed.eventType = eventType;
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
  if (numericFields.sinceId !== undefined)
    parsed.sinceId = Math.round(numericFields.sinceId);
  if (numericFields.limit !== undefined)
    parsed.limit = Math.round(numericFields.limit);
  return parsed;
}
