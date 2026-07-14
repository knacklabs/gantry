import type {
  MessageSendOptions,
  NewMessage,
  ThinkingOverride,
} from '../domain/types.js';
import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
  type AgentResult,
} from './session-command-parse.js';
export {
  extractSessionCommand,
  isSessionCommandAllowed,
} from './session-command-parse.js';
export type { AgentResult, SessionCommand } from './session-command-parse.js';
import {
  findModelByRunnerModel,
  type ModelDefaultAliases,
} from '../shared/model-catalog.js';
import {
  getModelFamily,
  resolveModelSelectionForWorkloadWithFamilies,
  type FamilyOrderOverrides,
} from '../shared/model-families.js';
import { formatModelDisplay } from '../shared/model-catalog-format.js';
import type { RuntimeModelStatusSnapshot } from '../runtime/model-status-store.js';
import {
  describeThinking,
  formatBrowserStatus,
  formatCompactionStatus,
  formatCurrentModel,
  formatModelsList,
  formatModelStatus,
  formatMemoryStatus,
  formatModelWhy,
  type BrowserStatusSnapshot,
  type CompactionStatusSnapshot,
  type MemoryStatusSnapshot,
} from './session-command-format.js';
import { formatSessionCommandsHelp } from './session-command-help.js';
import {
  defaultModelStatusSelection,
  type ModelStatusSelectionUpdate,
} from './session-model-status.js';
import {
  COMPACTION_ALREADY_RUNNING_MESSAGE,
  COMPACTION_QUEUED_MESSAGE,
  hasQueuedSessionCompaction,
  queueSessionCompaction,
} from './session-compaction-command.js';
import {
  prepareNewSessionArchive,
  runNewSessionArchiveFinalizer,
  type PrepareSessionArchive,
} from './session-new-archive.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';

interface DreamQueueResult {
  queued: boolean;
  deduped: boolean;
  pending?: number;
  reason?: 'queued' | 'deduped' | 'full' | 'invalid';
}

type CompactionProviderSession = {
  providerSessionId: string;
  externalSessionId: string;
};

export type SessionArchiveOutcome = {
  memory: 'ok' | 'degraded' | 'skipped';
};

function isDreamQueueResult(value: unknown): value is DreamQueueResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.queued === 'boolean' &&
    typeof candidate.deduped === 'boolean'
  );
}

export interface SessionCommandDeps {
  sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
    options?: {
      timeoutMs?: number;
      maintenanceProviderSession?: CompactionProviderSession;
    },
  ) => Promise<'success' | 'error' | 'stopped'>;
  runSessionCompaction: (
    onOutput: (result: AgentResult) => Promise<void>,
    options: {
      maintenanceProviderSession: CompactionProviderSession;
    },
  ) => Promise<'success' | 'error' | 'stopped'>;
  getSessionCompactionStrategy?: () => Promise<
    'provider_compaction' | 'fresh_checkpoint'
  >;
  closeStdin: () => void;
  advanceCursor: (message: Pick<NewMessage, 'timestamp' | 'id'>) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  getDefaultModel: () => string | undefined;
  getJobModelDefaults?: () => ModelDefaultAliases;
  // Provider/route ids with an ACTIVE Model Access credential for this app, used
  // to badge /models and answer /model why. Optional + best-effort: when absent
  // or it throws, the surfaces render without availability badges (graceful).
  getConfiguredModelProviders?: () => Promise<Set<string>>;
  // Optional settings-sourced family member-order override.
  getModelFamilyOrder?: () => FamilyOrderOverrides | undefined;
  getGroupModelOverride: () => string | undefined;
  setGroupModelOverride: (value: string | undefined) => Promise<void> | void;
  getModelStatus?: () => RuntimeModelStatusSnapshot | undefined;
  getBrowserStatus?: () =>
    | Promise<BrowserStatusSnapshot>
    | BrowserStatusSnapshot;
  updateModelStatusSelection?: (input: ModelStatusSelectionUpdate) => void;
  getGroupThinkingOverride: () => ThinkingOverride | undefined;
  setGroupThinkingOverride: (
    value: ThinkingOverride | undefined,
  ) => Promise<void> | void;
  archiveCurrentSession: (
    cause?: 'new-session' | 'manual-compact',
  ) => Promise<void | SessionArchiveOutcome>;
  prepareSessionArchive?: PrepareSessionArchive;
  onSessionArchived?: (
    cause?: 'new-session' | 'manual-compact',
  ) => Promise<void>;
  beginSessionCompaction?: (input?: {
    baseCursor?: string;
  }) => Promise<CompactionProviderSession | undefined>;
  admitSessionCompactionTask?: () => Promise<
    { task: AsyncTaskRecord; admitted: boolean } | undefined
  >;
  markSessionCompactionTaskRunning?: (
    task: AsyncTaskRecord,
    locked: CompactionProviderSession,
  ) => Promise<AsyncTaskRecord | null>;
  heartbeatSessionCompactionTask?: (
    task: AsyncTaskRecord | undefined,
  ) => Promise<AsyncTaskRecord | null>;
  finishSessionCompactionTask?: (
    task: AsyncTaskRecord | undefined,
    outcome: 'ready' | 'degraded' | 'failed',
  ) => Promise<void>;
  finishSessionCompaction?: (
    locked: CompactionProviderSession | undefined,
    status: 'active' | 'expired' | 'ready',
  ) => Promise<void>;
  publishSessionCompactionEvent?: (
    state: 'queued' | 'running' | 'ready' | 'degraded' | 'failed' | 'timeout',
    details?: {
      task?: AsyncTaskRecord;
      strategy?: 'provider_compaction' | 'fresh_checkpoint';
      errorSummary?: string;
    },
  ) => Promise<void> | void;
  clearCurrentSession: () => Promise<void> | void;
  stopCurrentRun?: () => boolean;
  runMemoryDreaming?: () => Promise<unknown>;
  getMemoryStatus?: () => Promise<MemoryStatusSnapshot>;
  getSessionCompactionStatus?: () =>
    | Promise<CompactionStatusSnapshot>
    | CompactionStatusSnapshot;
  saveProcedure?: (input: {
    title: string;
    body: string;
  }) => Promise<{ id: string } | void> | { id: string } | void;
  /** Whether sender is explicitly trusted for control-plane commands. */
  isSenderControlAllowlisted: (msg: NewMessage) => boolean;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  compactionScopeKey?: string;
}

const MAX_MODEL_ERROR_MESSAGE_CHARS = 240;
async function readConfiguredProviders(
  deps: SessionCommandDeps,
): Promise<Set<string> | undefined> {
  if (!deps.getConfiguredModelProviders) return undefined;
  try {
    return await deps.getConfiguredModelProviders();
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read configured model providers for session command',
    );
    return undefined;
  }
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function sanitizeErrorText(text: string): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const noAnsi = text.replace(ansiPattern, '');
  const normalized = noAnsi
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= MAX_MODEL_ERROR_MESSAGE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_MODEL_ERROR_MESSAGE_CHARS - 1)}…`;
}

const FORBIDDEN_PROCEDURE_TITLE_PREFIX =
  /^(Found it|Findings|Critical|End-to-end|No answer|Three full|On it|##|\*\*)/i;

function hasAtLeastTwoNumberedSteps(body: string): boolean {
  const matches = body.match(/^\s*\d+\.\s+/gm);
  return (matches?.length || 0) >= 2;
}

function normalizeBodyForComparison(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const { missedMessages, groupName, triggerPattern, timezone, deps } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (
    !isSessionCommandAllowed(
      cmdMsg.is_from_me === true,
      deps.isSenderControlAllowlisted(cmdMsg),
    )
  ) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-command messages first, then run the command
  logger.info({ group: groupName, command: command.raw }, 'Session command');

  if (command.kind === 'stop') {
    const stopped = deps.stopCurrentRun ? deps.stopCurrentRun() : false;
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(
      stopped ? 'Stopping current run.' : 'No active run to stop.',
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'commands') {
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(formatSessionCommandsHelp());
    return { handled: true, success: true };
  }

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCommandMsgs = missedMessages.slice(0, cmdIndex);

  // /new is the recovery path when the persisted provider session is bad.
  // Do not try to run older queued messages before clearing the session.
  if (command.kind === 'new') {
    const finalizeArchive = await prepareNewSessionArchive({
      groupName,
      logger,
      prepareSessionArchive: deps.prepareSessionArchive,
      archiveCurrentSession: deps.archiveCurrentSession,
    });

    try {
      await deps.clearCurrentSession();
    } catch (err) {
      logger.error(
        { group: groupName, err },
        'Failed to reset session for /new',
      );
      await deps.sendMessage('/new failed. The session is unchanged.');
      return { handled: true, success: false };
    }

    runNewSessionArchiveFinalizer({
      groupName,
      logger,
      finalizeArchive,
      onSessionArchived: deps.onSessionArchived,
    });

    deps.advanceCursor(cmdMsg);
    await deps.sendMessage('Started a fresh session.');
    return { handled: true, success: true };
  }

  // Send pre-command messages to the agent so they're in the session context.
  if (preCommandMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCommandMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult !== 'success' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-command processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command.raw}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-command messages, leave command pending.
        deps.advanceCursor(preCommandMsgs[preCommandMsgs.length - 1]);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  if (command.kind === 'dream') {
    deps.advanceCursor(cmdMsg);
    if (!deps.runMemoryDreaming) {
      await deps.sendMessage('/dream is unavailable in this runtime.');
      return { handled: true, success: true };
    }
    try {
      const result = await deps.runMemoryDreaming();
      if (isDreamQueueResult(result)) {
        if (!result.queued && result.reason === 'deduped') {
          await deps.sendMessage(
            `Dreaming already in progress.\n${JSON.stringify(result).slice(0, 1500)}`,
          );
          return { handled: true, success: true };
        }
        if (!result.queued) {
          const reason = result.reason || 'rejected';
          await deps.sendMessage(`/dream failed: ${sanitizeErrorText(reason)}`);
          return { handled: true, success: true };
        }
      }
      const summary =
        result && typeof result === 'object'
          ? JSON.stringify(result)
          : String(result ?? '');
      await deps.sendMessage(
        `Dreaming completed.\n${summary.slice(0, 1500) || 'no output'}`,
      );
      return { handled: true, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.sendMessage(`/dream failed: ${sanitizeErrorText(message)}`);
      return { handled: true, success: true };
    }
  }

  if (command.kind === 'compact') {
    deps.advanceCursor(cmdMsg);
    const queueResult = await queueSessionCompaction(
      groupName,
      deps,
      encodeGroupMessageCursor(toGroupMessageCursor(cmdMsg)),
    );
    await deps.sendMessage(
      queueResult === 'queued'
        ? COMPACTION_QUEUED_MESSAGE
        : COMPACTION_ALREADY_RUNNING_MESSAGE,
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'memory_status') {
    deps.advanceCursor(cmdMsg);
    if (!deps.getMemoryStatus) {
      await deps.sendMessage('/memory-status is unavailable in this runtime.');
      return { handled: true, success: true };
    }
    try {
      const status = await deps.getMemoryStatus();
      await deps.sendMessage(formatMemoryStatus(status));
      return { handled: true, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.sendMessage(
        `/memory-status failed: ${sanitizeErrorText(message)}`,
      );
      return { handled: true, success: true };
    }
  }

  if (command.kind === 'save_procedure') {
    deps.advanceCursor(cmdMsg);
    if (!deps.saveProcedure) {
      await deps.sendMessage('/save-procedure is unavailable in this runtime.');
      return { handled: true, success: true };
    }
    if (command.title.length < 10 || command.title.length > 80) {
      await deps.sendMessage('/save-procedure title must be 10-80 characters.');
      return { handled: true, success: true };
    }
    if (FORBIDDEN_PROCEDURE_TITLE_PREFIX.test(command.title)) {
      await deps.sendMessage(
        '/save-procedure rejected: title looks like transcript text, not a reusable procedure.',
      );
      return { handled: true, success: true };
    }
    const procedureBody =
      command.body || deps.formatMessages(preCommandMsgs, timezone).trim();
    if (!procedureBody) {
      await deps.sendMessage(
        '/save-procedure requires steps in the message body or prior context in this batch.',
      );
      return { handled: true, success: true };
    }
    if (!hasAtLeastTwoNumberedSteps(procedureBody)) {
      await deps.sendMessage(
        '/save-procedure body must include at least two numbered steps.',
      );
      return { handled: true, success: true };
    }
    const normalizedBody = normalizeBodyForComparison(procedureBody);
    const assistantBodies = preCommandMsgs
      .filter((msg) => msg.is_from_me === true)
      .slice(-5)
      .map((msg) => normalizeBodyForComparison(msg.content));
    if (assistantBodies.some((entry) => entry === normalizedBody)) {
      await deps.sendMessage(
        '/save-procedure rejected: body matches a recent assistant reply verbatim.',
      );
      return { handled: true, success: true };
    }
    try {
      const result = await deps.saveProcedure({
        title: command.title,
        body: procedureBody,
      });
      await deps.sendMessage(
        `Saved procedure "${command.title}"${result && 'id' in result ? ` (${result.id})` : ''}.`,
      );
      return { handled: true, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.sendMessage(
        `/save-procedure failed: ${sanitizeErrorText(message)}`,
      );
      return { handled: true, success: true };
    }
  }

  const defaultModel = deps.getDefaultModel();
  const groupOverrideModel = deps.getGroupModelOverride();
  const groupThinkingOverride = deps.getGroupThinkingOverride();

  if (command.kind === 'model_show') {
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(
      formatCurrentModel(defaultModel, groupOverrideModel),
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'models_list') {
    deps.advanceCursor(cmdMsg);
    const configuredProviders = await readConfiguredProviders(deps);
    await deps.sendMessage(
      formatModelsList({
        defaults: {
          chat: defaultModel,
          ...(deps.getJobModelDefaults?.() ?? {}),
        },
        configuredProviders,
        familyOrder: deps.getModelFamilyOrder?.(),
      }),
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'model_why') {
    deps.advanceCursor(cmdMsg);
    const configuredProviders = await readConfiguredProviders(deps);
    await deps.sendMessage(
      formatModelWhy({
        value: command.value,
        configuredProviders,
        familyOrder: deps.getModelFamilyOrder?.(),
      }),
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'status') {
    deps.advanceCursor(cmdMsg);
    const modelStatusText = formatModelStatus(deps.getModelStatus?.(), {
      currentModel: groupOverrideModel,
      defaultModel,
      source: groupOverrideModel ? 'session override' : 'chat default',
    });
    const browserStatusText = deps.getBrowserStatus
      ? `\n\n${formatBrowserStatus(await deps.getBrowserStatus())}`
      : '';
    const compactionStatus = await deps.getSessionCompactionStatus?.();
    const compactionScopeKey = deps.compactionScopeKey?.trim() || groupName;
    const shownCompactionStatus =
      hasQueuedSessionCompaction(compactionScopeKey) &&
      (!compactionStatus || compactionStatus.state === 'idle')
        ? { state: 'queued' as const }
        : compactionStatus;
    await deps.sendMessage(
      `${modelStatusText}${
        shownCompactionStatus
          ? `\n\n${formatCompactionStatus(shownCompactionStatus)}`
          : ''
      }${browserStatusText}`,
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'thinking_show') {
    const message = groupThinkingOverride
      ? `Current thinking: ${describeThinking(groupThinkingOverride)} (group override).`
      : 'Current thinking: adaptive (effort medium) (default).';
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(message);
    return { handled: true, success: true };
  }

  if (command.kind === 'model_set') {
    // Family aliases (e.g. gpt-oss) are accepted and stored verbatim; the
    // concrete provider is picked at spawn from the configured credential.
    const resolved = resolveModelSelectionForWorkloadWithFamilies(
      command.value,
      'chat',
      deps.getModelFamilyOrder?.(),
    );
    if (!resolved.ok) {
      deps.advanceCursor(cmdMsg);
      await deps.sendMessage(resolved.message);
      return { handled: true, success: true };
    }

    try {
      await deps.setGroupModelOverride(resolved.alias);
      deps.updateModelStatusSelection?.({
        selectionSource: 'session override',
        modelAlias: resolved.alias,
        model: resolved.entry,
      });
    } catch (err) {
      logger.error(
        { group: groupName, err, model: resolved.alias },
        'Failed to persist /model override',
      );
      await deps.sendMessage(
        `Failed to set model to ${resolved.alias}. Override unchanged.`,
      );
      return { handled: true, success: false };
    }

    deps.advanceCursor(cmdMsg);
    const family = getModelFamily(resolved.alias);
    const selectionLabel = family
      ? `${family.displayName} (provider auto-selected by configured key)`
      : (findModelByRunnerModel(resolved.runnerModel)?.displayName ??
        resolved.alias);
    await deps.sendMessage(`Using ${selectionLabel} for this session.`);
    return { handled: true, success: true };
  }

  if (command.kind === 'model_default') {
    try {
      await deps.setGroupModelOverride(undefined);
      deps.updateModelStatusSelection?.(
        defaultModelStatusSelection(defaultModel),
      );
    } catch (err) {
      logger.error(
        { group: groupName, err },
        'Failed to clear /model override',
      );
      await deps.sendMessage(
        'Failed to clear model override. Override unchanged.',
      );
      return { handled: true, success: false };
    }

    deps.advanceCursor(cmdMsg);
    if (defaultModel) {
      const defaultEntry = findModelByRunnerModel(defaultModel);
      await deps.sendMessage(
        `Model override cleared. Using default model: ${defaultEntry ? formatModelDisplay(defaultEntry) : defaultModel}.`,
      );
    } else {
      await deps.sendMessage(
        'Model override cleared. Using CLI default model selection.',
      );
    }
    return { handled: true, success: true };
  }

  if (command.kind === 'thinking_set') {
    try {
      await deps.setGroupThinkingOverride(command.value);
    } catch (err) {
      logger.error(
        { group: groupName, err, thinking: command.value },
        'Failed to persist /thinking override',
      );
      await deps.sendMessage('Failed to set thinking. Override unchanged.');
      return { handled: true, success: false };
    }

    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(
      `Thinking set to ${describeThinking(command.value)} for this group.`,
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'thinking_default') {
    try {
      await deps.setGroupThinkingOverride(undefined);
    } catch (err) {
      logger.error(
        { group: groupName, err },
        'Failed to clear /thinking override',
      );
      await deps.sendMessage(
        'Failed to clear thinking override. Override unchanged.',
      );
      return { handled: true, success: false };
    }

    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(
      'Thinking override cleared. Using default thinking: adaptive (effort medium).',
    );
    return { handled: true, success: true };
  }

  const _exhaustive: never = command;
  return _exhaustive;
}
