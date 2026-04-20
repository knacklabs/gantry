/**
 * MyClaw Agent Runner
 * Runs as the child agent process, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full agent input JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface AgentRunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledJob?: boolean;
  assistantName?: string;
  script?: string;
  compiledSystemPrompt?: string;
  thinking?: {
    mode: 'adaptive' | 'enabled' | 'disabled';
    effort?: EffortLevel;
    budgetTokens?: number;
    display?: 'summarized' | 'omitted';
  };
}

interface AgentRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const WORKSPACE_GROUP_DIR =
  process.env.MYCLAW_WORKSPACE_GROUP_DIR || '/workspace/group';
const WORKSPACE_EXTRA_DIR =
  process.env.MYCLAW_WORKSPACE_EXTRA_DIR || '/workspace/extra';
const IPC_BASE_DIR = process.env.MYCLAW_IPC_DIR || '/workspace/ipc';
const IPC_INPUT_DIR =
  process.env.MYCLAW_IPC_INPUT_DIR || '/workspace/ipc/input';
const IPC_AUTH_TOKEN = process.env.MYCLAW_IPC_AUTH_TOKEN || '';
const PERMISSION_REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.MYCLAW_PERMISSION_TIMEOUT_MS || '300000', 10) || 300_000,
);
const IPC_MEMORY_CONTEXT_FILE =
  process.env.MYCLAW_IPC_MEMORY_CONTEXT_FILE?.trim() || '';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

interface PermissionDecision {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
}

function resolveGroupIpcDir(groupFolder: string): string {
  // `MYCLAW_IPC_DIR` is normally group-scoped, but older/alternate runtimes
  // may still provide the shared IPC root. Handle both without double-nesting.
  if (path.basename(IPC_BASE_DIR) === groupFolder) {
    return IPC_BASE_DIR;
  }
  return path.join(IPC_BASE_DIR, groupFolder);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildSystemPrompt(append?: string):
  | {
      type: 'preset';
      preset: 'claude_code';
      append: string;
      excludeDynamicSections: boolean;
    }
  | undefined {
  const trimmed = append?.trim();
  if (!trimmed) return undefined;
  return {
    type: 'preset',
    preset: 'claude_code',
    append: trimmed,
    // Strip per-user dynamic sections (cwd, auto-memory path, git status)
    // from the cached system prompt prefix. They are re-injected as the first
    // user message so the model still sees them. This keeps the system prompt
    // static and cacheable across agent spawns and groups that share the same
    // CLAUDE.md content.
    excludeDynamicSections: true,
  };
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---MYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---MYCLAW_OUTPUT_END---';

function writeOutput(output: AgentRunnerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function normalizeModelValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveConfiguredModel(): {
  model?: string;
  source: 'ANTHROPIC_MODEL' | 'unset';
} {
  const anthropicModel = normalizeModelValue(process.env.ANTHROPIC_MODEL);
  if (anthropicModel) {
    return { model: anthropicModel, source: 'ANTHROPIC_MODEL' };
  }
  return { source: 'unset' };
}

function resolveThinkingOptions(
  thinkingOverride?: AgentRunnerInput['thinking'],
): {
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  description: string;
} {
  if (!thinkingOverride) {
    return {
      thinking: { type: 'adaptive' },
      effort: 'medium',
      description: 'adaptive (effort medium)',
    };
  }

  if (thinkingOverride.mode === 'disabled') {
    return {
      thinking: { type: 'disabled' },
      description: 'disabled',
    };
  }

  if (thinkingOverride.mode === 'enabled') {
    return {
      thinking: {
        type: 'enabled',
        budgetTokens: thinkingOverride.budgetTokens,
        display: thinkingOverride.display,
      },
      description:
        typeof thinkingOverride.budgetTokens === 'number'
          ? `enabled (budget ${thinkingOverride.budgetTokens} tokens)`
          : 'enabled',
    };
  }

  return {
    thinking: {
      type: 'adaptive',
      display: thinkingOverride.display,
    },
    effort: thinkingOverride.effort,
    description: thinkingOverride.effort
      ? `adaptive (effort ${thinkingOverride.effort})`
      : 'adaptive',
  };
}

type SessionSlashKind = 'compact' | 'model';

interface SessionSlashCommand {
  command: string;
  kind: SessionSlashKind;
}

function parseSessionSlashCommand(prompt: string): SessionSlashCommand | null {
  const trimmed = prompt.trim();
  if (trimmed === '/compact') {
    return { command: '/compact', kind: 'compact' };
  }
  if (/^\/model(?:\s+\S+)?$/.test(trimmed)) {
    return { command: trimmed, kind: 'model' };
  }
  return null;
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function requestPermissionApproval(options: {
  groupFolder: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolInput?: unknown;
}): Promise<PermissionDecision> {
  try {
    const groupIpcDir = resolveGroupIpcDir(options.groupFolder);
    const permissionRequestsDir = path.join(groupIpcDir, 'permission-requests');
    const permissionResponsesDir = path.join(
      groupIpcDir,
      'permission-responses',
    );
    fs.mkdirSync(permissionRequestsDir, { recursive: true });
    fs.mkdirSync(permissionResponsesDir, { recursive: true });
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestPath = path.join(permissionRequestsDir, `${requestId}.json`);
    const requestTmpPath = `${requestPath}.tmp`;
    const envelope = {
      requestId,
      sourceGroup: options.groupFolder,
      toolName: options.toolName,
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason
        ? { decisionReason: options.decisionReason }
        : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(isPlainObject(options.toolInput)
        ? { toolInput: options.toolInput }
        : {}),
      ...(IPC_AUTH_TOKEN ? { authToken: IPC_AUTH_TOKEN } : {}),
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(requestTmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(requestTmpPath, requestPath);

    const responsePath = path.join(permissionResponsesDir, `${requestId}.json`);
    const deadline = Date.now() + PERMISSION_REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (
            raw &&
            typeof raw === 'object' &&
            (raw as { requestId?: string }).requestId === requestId
          ) {
            return {
              approved: Boolean((raw as { approved?: unknown }).approved),
              decidedBy:
                typeof (raw as { decidedBy?: unknown }).decidedBy === 'string'
                  ? (raw as { decidedBy: string }).decidedBy
                  : undefined,
              reason:
                typeof (raw as { reason?: unknown }).reason === 'string'
                  ? (raw as { reason: string }).reason
                  : undefined,
            };
          }
          return { approved: false, reason: 'Malformed permission response' };
        } catch (err) {
          return {
            approved: false,
            reason:
              err instanceof Error
                ? err.message
                : 'Failed to read permission response',
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      approved: false,
      reason: 'Timed out waiting for host permission approval',
    };
  } catch (err) {
    return {
      approved: false,
      reason:
        err instanceof Error
          ? `Permission request failed: ${err.message}`
          : 'Permission request failed',
    };
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  agentInput: AgentRunnerInput,
  sdkEnv: Record<string, string | undefined>,
  configuredModel: string | undefined,
  queryThinking: ThinkingConfig | undefined,
  queryEffort: EffortLevel | undefined,
  resumeAt?: string,
  enableIpcFollowups = true,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  const memoryBlock = readMemoryContextBlock();
  stream.push(memoryBlock ? `${prompt}\n\n${memoryBlock}` : prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!enableIpcFollowups) return;
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  if (enableIpcFollowups) {
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  }

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  const systemPrompt = buildSystemPrompt(agentInput.compiledSystemPrompt);

  // Discover additional directories mounted at runtime-specific extra dir.
  // These paths are exposed to the SDK for file access when present.
  const extraDirs: string[] = [];
  const extraBase = WORKSPACE_EXTRA_DIR;
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      model: configuredModel,
      thinking: queryThinking,
      effort: queryEffort,
      cwd: WORKSPACE_GROUP_DIR,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'Config',
        'EnterWorktree',
        'ExitWorktree',
        'mcp__myclaw__*',
      ],
      env: sdkEnv,
      permissionMode: 'default',
      canUseTool: async (toolName, input, permissionOpts) => {
        if (
          toolName === 'Config' ||
          toolName === 'EnterWorktree' ||
          toolName === 'ExitWorktree'
        ) {
          return { behavior: 'allow' as const, updatedInput: input };
        }

        if (permissionOpts.signal.aborted) {
          return {
            behavior: 'deny' as const,
            message: 'Permission request aborted',
          };
        }
        const decision = await requestPermissionApproval({
          groupFolder: agentInput.groupFolder,
          toolName,
          title: permissionOpts.title,
          displayName: permissionOpts.displayName,
          description: permissionOpts.description,
          decisionReason: permissionOpts.decisionReason,
          blockedPath: permissionOpts.blockedPath,
          toolInput: input,
        });
        if (decision.approved) {
          log(
            `Permission approved for tool ${toolName} by ${decision.decidedBy || 'unknown'}`,
          );
          return { behavior: 'allow' as const, updatedInput: input };
        }
        const reason = decision.reason || 'Denied by operator';
        log(`Permission denied for tool ${toolName}: ${reason}`);
        return {
          behavior: 'deny' as const,
          message: `Permission denied: ${reason}`,
          interrupt: false,
        };
      },
      settingSources: ['user'],
      mcpServers: {
        myclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            MYCLAW_CHAT_JID: agentInput.chatJid,
            MYCLAW_GROUP_FOLDER: agentInput.groupFolder,
            MYCLAW_IS_MAIN: agentInput.isMain ? '1' : '0',
            ...(process.env.MYCLAW_IPC_DIR
              ? { MYCLAW_IPC_DIR: process.env.MYCLAW_IPC_DIR }
              : {}),
            ...(process.env.MYCLAW_IPC_AUTH_TOKEN
              ? {
                  MYCLAW_IPC_AUTH_TOKEN: process.env.MYCLAW_IPC_AUTH_TOKEN,
                }
              : {}),
          },
        },
      },
      includePartialMessages: true,
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'stream_event') {
      const event = (message as { event?: unknown }).event as
        | {
            type?: string;
            delta?: { type?: string; text?: string };
          }
        | undefined;
      if (event?.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          sawPartialTextSinceLastResult = true;
          writeOutput({
            status: 'success',
            result: delta.text,
            newSessionId,
          });
        }
      }
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );

      // Log usage and prompt cache performance metrics
      const resultMsg = message as {
        total_cost_usd?: number;
        num_turns?: number;
        duration_ms?: number;
        duration_api_ms?: number;
        modelUsage?: Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
            costUSD: number;
          }
        >;
      };
      if (resultMsg.modelUsage) {
        for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
          const cacheRead = usage.cacheReadInputTokens || 0;
          const cacheWrite = usage.cacheCreationInputTokens || 0;
          const totalInput = usage.inputTokens || 0;
          const cacheHitPct =
            totalInput > 0
              ? ((cacheRead / totalInput) * 100).toFixed(1)
              : '0.0';
          log(
            `Usage [${model}]: input=${totalInput} output=${usage.outputTokens || 0} ` +
              `cacheRead=${cacheRead} cacheWrite=${cacheWrite} ` +
              `cacheHit=${cacheHitPct}% cost=$${(usage.costUSD || 0).toFixed(4)}`,
          );
        }
      }
      if (resultMsg.total_cost_usd !== undefined) {
        log(
          `Total: cost=$${resultMsg.total_cost_usd.toFixed(4)} ` +
            `turns=${resultMsg.num_turns || 0} ` +
            `duration=${resultMsg.duration_ms || 0}ms ` +
            `apiTime=${resultMsg.duration_api_ms || 0}ms`,
        );
      }

      writeOutput({
        status: 'success',
        result:
          textResult && !sawPartialTextSinceLastResult ? textResult : null,
        newSessionId,
      });
      sawPartialTextSinceLastResult = false;
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

function readMemoryContextBlock(): string {
  try {
    if (!IPC_MEMORY_CONTEXT_FILE) return '';
    if (!fs.existsSync(IPC_MEMORY_CONTEXT_FILE)) return '';
    const parsed = JSON.parse(
      fs.readFileSync(IPC_MEMORY_CONTEXT_FILE, 'utf-8'),
    ) as { block?: unknown };
    return typeof parsed.block === 'string' ? parsed.block.trim() : '';
  } catch (err) {
    log(
      `Failed to load memory context block: ${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-script-'));
  const scriptPath = path.join(tempDir, 'task-script.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }

        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

interface SessionSlashRunOptions {
  command: string;
  kind: SessionSlashKind;
  sessionId?: string;
  sdkEnv: Record<string, string | undefined>;
  assistantName?: string;
  configuredModel?: string;
  configuredThinking?: ThinkingConfig;
  configuredEffort?: EffortLevel;
  systemPromptAppend?: string;
  silent?: boolean;
}

interface SessionSlashRunResult {
  status: 'success' | 'error';
  newSessionId?: string;
  hadError: boolean;
  compactBoundarySeen: boolean;
  resultEmitted: boolean;
  error?: string;
}

async function runSessionSlashCommand(
  opts: SessionSlashRunOptions,
): Promise<SessionSlashRunResult> {
  log(
    `Handling session command: ${opts.command}${opts.silent ? ' (silent)' : ''}`,
  );

  let slashSessionId = opts.sessionId;
  let compactBoundarySeen = false;
  let hadError = false;
  let resultEmitted = false;
  let errorMessage: string | undefined;
  const systemPrompt = buildSystemPrompt(opts.systemPromptAppend);

  try {
    for await (const message of query({
      prompt: opts.command,
      options: {
        model: opts.configuredModel,
        thinking: opts.configuredThinking,
        effort: opts.configuredEffort,
        cwd: WORKSPACE_GROUP_DIR,
        resume: opts.sessionId,
        systemPrompt,
        allowedTools: [],
        env: opts.sdkEnv,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        settingSources: ['user'] as const,
      },
    })) {
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[slash-cmd] type=${msgType}`);

      if (message.type === 'system' && message.subtype === 'init') {
        slashSessionId = message.session_id;
        log(`Session after slash command: ${slashSessionId}`);
      }

      if (
        opts.kind === 'compact' &&
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'compact_boundary'
      ) {
        compactBoundarySeen = true;
        log('Compact boundary observed — compaction completed');
      }

      if (message.type === 'result') {
        const resultSubtype = (message as { subtype?: string }).subtype;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        const resultIsError = Boolean(resultSubtype?.startsWith('error'));

        if (resultIsError) {
          hadError = true;
          errorMessage = textResult || 'Session command failed.';
          if (!opts.silent) {
            writeOutput({
              status: 'error',
              result: null,
              error: errorMessage,
              newSessionId: slashSessionId,
            });
          }
        } else if (!opts.silent) {
          writeOutput({
            status: 'success',
            result:
              textResult ||
              (opts.kind === 'compact' ? 'Conversation compacted.' : null),
            newSessionId: slashSessionId,
          });
        }

        resultEmitted = true;
      }
    }
  } catch (err) {
    hadError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    log(`Slash command error: ${errorMessage}`);
    if (!opts.silent) {
      writeOutput({
        status: 'error',
        result: null,
        error: errorMessage,
        newSessionId: slashSessionId,
      });
    }
  }

  log(
    `Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}, resultEmitted=${resultEmitted}`,
  );

  if (!opts.silent) {
    if (!hadError && opts.kind === 'compact' && !compactBoundarySeen) {
      log(
        'WARNING: compact_boundary was not observed. Compaction may not have completed.',
      );
    }

    if (!resultEmitted && !hadError) {
      if (opts.kind === 'compact') {
        writeOutput({
          status: 'success',
          result: compactBoundarySeen
            ? 'Conversation compacted.'
            : 'Compaction requested but compact_boundary was not observed.',
          newSessionId: slashSessionId,
        });
      } else {
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: slashSessionId,
        });
      }
    } else if (!hadError) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: slashSessionId,
      });
    }
  }

  return {
    status: hadError ? 'error' : 'success',
    newSessionId: slashSessionId,
    hadError,
    compactBoundarySeen,
    resultEmitted,
    error: errorMessage,
  };
}

async function main(): Promise<void> {
  let agentInput: AgentRunnerInput;

  try {
    const stdinData = await readStdin();
    agentInput = JSON.parse(stdinData);
    log(`Received input for group: ${agentInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the agent process environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const configuredModel = resolveConfiguredModel();
  const configuredThinking = resolveThinkingOptions(agentInput.thinking);
  if (configuredModel.model) {
    log(
      `Configured model: ${configuredModel.model} (source: ${configuredModel.source})`,
    );
  } else {
    log('Configured model: CLI default (no ANTHROPIC_MODEL set)');
  }
  log(`Configured thinking: ${configuredThinking.description}`);

  let sessionId = agentInput.sessionId;
  if (!agentInput.isScheduledJob) {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

    // Clean up stale _close sentinel from previous agent runs
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = agentInput.prompt;
  const compiledSystemPrompt = agentInput.compiledSystemPrompt?.trim();
  if (agentInput.isScheduledJob) {
    prompt = `[SCHEDULED JOB - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  if (!agentInput.isScheduledJob) {
    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(
        `Draining ${pending.length} pending IPC messages into initial prompt`,
      );
      prompt += '\n' + pending.join('\n');
    }
  }

  // --- Session slash commands + resume model preflight ---
  // Parse supported commands only, so normal "/" prompts are treated as user text.
  const sessionSlashCommand = parseSessionSlashCommand(prompt);

  // Cold-start resume protection: when resuming an existing session, silently
  // re-apply the effective model before handling user work.
  if (sessionId && configuredModel.model && !sessionSlashCommand) {
    const preflight = await runSessionSlashCommand({
      command: `/model ${configuredModel.model}`,
      kind: 'model',
      sessionId,
      sdkEnv,
      assistantName: agentInput.assistantName,
      configuredModel: configuredModel.model,
      configuredThinking: configuredThinking.thinking,
      configuredEffort: configuredThinking.effort,
      systemPromptAppend: compiledSystemPrompt,
      silent: true,
    });

    sessionId = preflight.newSessionId || sessionId;

    if (preflight.status === 'error') {
      const errorDetail = preflight.error || 'unknown error';
      const message = `Failed to re-apply configured model "${configuredModel.model}" on resumed session: ${errorDetail}`;
      log(message);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: message,
      });
      process.exit(1);
    }
  }

  // Handle explicit session slash commands.
  if (sessionSlashCommand) {
    const slashResult = await runSessionSlashCommand({
      command: sessionSlashCommand.command,
      kind: sessionSlashCommand.kind,
      sessionId,
      sdkEnv,
      assistantName: agentInput.assistantName,
      configuredModel: configuredModel.model,
      configuredThinking: configuredThinking.thinking,
      configuredEffort: configuredThinking.effort,
      systemPromptAppend: compiledSystemPrompt,
    });

    if (slashResult.newSessionId) {
      sessionId = slashResult.newSessionId;
    }

    if (slashResult.status === 'error') {
      process.exit(1);
    }
    return;
  }
  // --- End session slash handling ---

  // Script phase: run script before waking agent
  if (agentInput.script && agentInput.isScheduledJob) {
    log('Running scheduler job script...');
    const scriptResult = await runScript(agentInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED JOB]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${agentInput.prompt}`;
  }

  if (agentInput.isScheduledJob) {
    log(
      `Starting one-shot scheduled query (session: ${sessionId || 'new'})...`,
    );
    try {
      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        agentInput,
        sdkEnv,
        configuredModel.model,
        configuredThinking.thinking,
        configuredThinking.effort,
        undefined,
        false,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      return;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Scheduled job error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      });
      process.exit(1);
    }
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        agentInput,
        sdkEnv,
        configuredModel.model,
        configuredThinking.thinking,
        configuredThinking.effort,
        resumeAt,
        true,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
