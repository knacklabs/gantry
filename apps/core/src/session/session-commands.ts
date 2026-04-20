import type {
  MessageSendOptions,
  NewMessage,
  ThinkingEffort,
  ThinkingOverride,
} from '../core/types.js';
import { logger } from '../core/logger.js';

export type SessionCommand =
  | { kind: 'compact'; raw: '/compact' }
  | { kind: 'new'; raw: '/new' }
  | { kind: 'stop'; raw: '/stop' }
  | { kind: 'dream'; raw: '/dream' }
  | { kind: 'memory_status'; raw: '/memory-status' }
  | { kind: 'save_procedure'; raw: string; title: string; body?: string }
  | { kind: 'model_show'; raw: '/model' }
  | { kind: 'model_set'; raw: string; value: string }
  | { kind: 'model_default'; raw: '/model default' }
  | { kind: 'thinking_show'; raw: '/thinking' }
  | { kind: 'thinking_set'; raw: string; value: ThinkingOverride }
  | { kind: 'thinking_default'; raw: '/thinking default' };

export interface MemoryStatusSnapshot {
  items_by_kind: Record<string, number>;
  items_by_scope: Record<string, number>;
  top10_most_used: Array<{ key: string; retrieval_count: number }>;
  top10_stalest: Array<{ key: string; updated_at: string }>;
  last_dream_run?: { at?: string; summary?: string };
  disk_kb?: Record<string, number>;
}

interface DreamQueueResult {
  queued: boolean;
  deduped: boolean;
  pending?: number;
  reason?: 'queued' | 'deduped' | 'full' | 'invalid';
}

function isDreamQueueResult(value: unknown): value is DreamQueueResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.queued === 'boolean' &&
    typeof candidate.deduped === 'boolean'
  );
}

function parseThinkingCommand(text: string): SessionCommand | null {
  if (text === '/thinking') return { kind: 'thinking_show', raw: '/thinking' };

  const thinkingMatch = text.match(/^\/thinking\s+(.+)$/);
  if (!thinkingMatch) return null;

  const value = thinkingMatch[1].trim();
  if (value === 'default') {
    return { kind: 'thinking_default', raw: '/thinking default' };
  }
  if (value === 'off' || value === 'disabled') {
    return {
      kind: 'thinking_set',
      raw: `/thinking ${value}`,
      value: { mode: 'disabled' },
    };
  }
  if (value === 'adaptive') {
    return {
      kind: 'thinking_set',
      raw: '/thinking adaptive',
      value: { mode: 'adaptive' },
    };
  }
  if (value === 'enabled') {
    return {
      kind: 'thinking_set',
      raw: '/thinking enabled',
      value: { mode: 'enabled' },
    };
  }
  const effortMatch = value.match(/^(low|medium|high|max)$/);
  if (effortMatch) {
    return {
      kind: 'thinking_set',
      raw: `/thinking ${effortMatch[1]}`,
      value: { mode: 'adaptive', effort: effortMatch[1] as ThinkingEffort },
    };
  }
  const enabledBudgetMatch = value.match(/^enabled\s+(\d+)$/);
  if (enabledBudgetMatch) {
    const budgetTokens = Number(enabledBudgetMatch[1]);
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) return null;
    return {
      kind: 'thinking_set',
      raw: `/thinking enabled ${budgetTokens}`,
      value: { mode: 'enabled', budgetTokens },
    };
  }

  return null;
}

function describeThinking(value: ThinkingOverride): string {
  if (value.mode === 'disabled') return 'disabled';
  if (value.mode === 'adaptive') {
    if (value.effort) return `adaptive (effort ${value.effort})`;
    return 'adaptive';
  }
  if (value.mode === 'enabled') {
    if (typeof value.budgetTokens === 'number') {
      return `enabled (budget ${value.budgetTokens} tokens)`;
    }
    return 'enabled';
  }
  return value.mode;
}

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the parsed command or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): SessionCommand | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact') return { kind: 'compact', raw: '/compact' };
  if (text === '/new') return { kind: 'new', raw: '/new' };
  if (text === '/stop') return { kind: 'stop', raw: '/stop' };
  if (text === '/dream') return { kind: 'dream', raw: '/dream' };
  if (text === '/memory-status') {
    return { kind: 'memory_status', raw: '/memory-status' };
  }
  if (text === '/model') return { kind: 'model_show', raw: '/model' };

  const saveProcedureMatch = text.match(
    /^\/save-procedure(?:\s+"([^"\n]{1,80})"|\s+([^\n]{1,80}))(?:\n([\s\S]+))?$/,
  );
  if (saveProcedureMatch) {
    const title = (saveProcedureMatch[1] || saveProcedureMatch[2] || '').trim();
    const body = saveProcedureMatch[3]?.trim();
    if (title) {
      return {
        kind: 'save_procedure',
        raw: text,
        title,
        ...(body ? { body } : {}),
      };
    }
  }

  const modelMatch = text.match(/^\/model\s+(\S+)$/);
  if (modelMatch) {
    const value = modelMatch[1];
    if (value === 'default') {
      return { kind: 'model_default', raw: '/model default' };
    }
    return {
      kind: 'model_set',
      raw: `/model ${value}`,
      value,
    };
  }

  const thinking = parseThinkingCommand(text);
  if (thinking) return thinking;

  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed only for trusted/admin sender (is_from_me) or explicit sender allowlist membership.
 */
export function isSessionCommandAllowed(
  isFromMe: boolean,
  isSenderControlAllowlisted: boolean,
): boolean {
  return isFromMe || isSenderControlAllowlisted;
}

/** Minimal agent result interface — matches the subset of AgentOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string, options?: MessageSendOptions) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
    options?: { timeoutMs?: number },
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (message: Pick<NewMessage, 'timestamp' | 'id'>) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  getDefaultModel: () => string | undefined;
  getGroupModelOverride: () => string | undefined;
  setGroupModelOverride: (value: string | undefined) => void;
  getGroupThinkingOverride: () => ThinkingOverride | undefined;
  setGroupThinkingOverride: (value: ThinkingOverride | undefined) => void;
  archiveCurrentSession: (
    cause?: 'new-session' | 'manual-compact',
  ) => Promise<void>;
  onSessionArchived?: (
    cause?: 'new-session' | 'manual-compact',
  ) => Promise<void>;
  clearCurrentSession: () => void;
  stopCurrentRun?: () => boolean;
  runMemoryDreaming?: () => Promise<unknown>;
  getMemoryStatus?: () => Promise<MemoryStatusSnapshot>;
  saveProcedure?: (input: {
    title: string;
    body: string;
  }) => Promise<{ id: string } | void> | { id: string } | void;
  /** Whether sender is explicitly trusted for control-plane commands. */
  isSenderControlAllowlisted: (msg: NewMessage) => boolean;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
}

function formatMemoryStatus(status: MemoryStatusSnapshot): string {
  const kinds = Object.entries(status.items_by_kind || {})
    .map(([kind, count]) => `${kind}:${count}`)
    .join(', ');
  const scopes = Object.entries(status.items_by_scope || {})
    .map(([scope, count]) => `${scope}:${count}`)
    .join(', ');
  const used = (status.top10_most_used || [])
    .slice(0, 5)
    .map((row) => `${row.key}(${row.retrieval_count})`)
    .join(', ');
  const stalest = (status.top10_stalest || [])
    .slice(0, 5)
    .map((row) => `${row.key}@${row.updated_at.slice(0, 10)}`)
    .join(', ');
  const dream = status.last_dream_run?.at || 'never';
  const disk = status.disk_kb
    ? Object.entries(status.disk_kb)
        .map(([k, v]) => `${k}:${v}kb`)
        .join(', ')
    : 'n/a';
  return [
    'Memory status',
    `kinds: ${kinds || 'none'}`,
    `scopes: ${scopes || 'none'}`,
    `top_used: ${used || 'none'}`,
    `stale: ${stalest || 'none'}`,
    `last_dream: ${dream}`,
    `disk: ${disk}`,
  ].join('\n');
}

const MODEL_VALIDATION_TIMEOUT_MS = 90_000;
const MAX_MODEL_ERROR_MESSAGE_CHARS = 240;

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
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

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

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCommandMsgs = missedMessages.slice(0, cmdIndex);

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

    if (preResult === 'error' || hadPreError) {
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
  if (command.kind === 'new') {
    try {
      deps.clearCurrentSession();
    } catch (err) {
      logger.error(
        { group: groupName, err },
        'Failed to reset session for /new',
      );
      await deps.sendMessage('/new failed. The session is unchanged.');
      return { handled: true, success: false };
    }

    try {
      await deps.archiveCurrentSession('new-session');
      await deps.onSessionArchived?.('new-session');
    } catch (err) {
      logger.warn(
        { group: groupName, err },
        'Session archive failed during /new; continuing with reset',
      );
    }

    deps.advanceCursor(cmdMsg);
    await deps.sendMessage('Started a fresh session.');
    return { handled: true, success: true };
  }

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
    let message: string;
    if (groupOverrideModel) {
      message = `Current model: ${groupOverrideModel} (group override).`;
    } else if (defaultModel) {
      message = `Current model: ${defaultModel} (default).`;
    } else {
      message = 'Current model: CLI default (no explicit override).';
    }
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(message);
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
    let modelValidationFailed = false;
    let modelValidationError: string | null = null;
    const validateResult = await deps.runAgent(
      command.raw,
      async (result) => {
        if (result.status === 'error') {
          modelValidationFailed = true;
        }
        const text = sanitizeErrorText(resultToText(result.result));
        if (text && modelValidationError === null) {
          modelValidationError = text;
        }
      },
      { timeoutMs: MODEL_VALIDATION_TIMEOUT_MS },
    );

    if (validateResult === 'error' || modelValidationFailed) {
      deps.advanceCursor(cmdMsg);
      await deps.sendMessage(
        modelValidationError
          ? `Failed to set model: ${modelValidationError}`
          : `Failed to set model to ${command.value}. Override unchanged.`,
      );
      return { handled: true, success: true };
    }

    deps.advanceCursor(cmdMsg);
    deps.setGroupModelOverride(command.value);
    await deps.sendMessage(`Model set to ${command.value} for this group.`);
    return { handled: true, success: true };
  }

  if (command.kind === 'model_default') {
    deps.setGroupModelOverride(undefined);
    deps.advanceCursor(cmdMsg);
    if (defaultModel) {
      await deps.sendMessage(
        `Model override cleared. Using default model: ${defaultModel}.`,
      );
    } else {
      await deps.sendMessage(
        'Model override cleared. Using CLI default model selection.',
      );
    }
    return { handled: true, success: true };
  }

  if (command.kind === 'thinking_set') {
    deps.setGroupThinkingOverride(command.value);
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(
      `Thinking set to ${describeThinking(command.value)} for this group.`,
    );
    return { handled: true, success: true };
  }

  if (command.kind === 'thinking_default') {
    deps.setGroupThinkingOverride(undefined);
    deps.advanceCursor(cmdMsg);
    await deps.sendMessage(
      'Thinking override cleared. Using default thinking: adaptive (effort medium).',
    );
    return { handled: true, success: true };
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command.raw, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command.raw} failed. The session is unchanged.`);
    return { handled: true, success: true };
  }

  if (command.kind === 'compact') {
    try {
      await deps.archiveCurrentSession('manual-compact');
      await deps.onSessionArchived?.('manual-compact');
    } catch (err) {
      logger.warn(
        { group: groupName, err },
        'Session archive failed during /compact; continuing',
      );
    }
  }

  return { handled: true, success: true };
}
