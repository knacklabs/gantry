import {
  query,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { composeAgentCapabilities } from '../agent-capabilities.js';
import { denyMemoryBoundaryToolUse } from '../memory-boundary.js';
import { MessageStream } from './message-stream.js';
import { drainIpcInput, shouldClose } from './ipc-input.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { requestPermissionApproval } from './permission-callback.js';
import {
  discoverAdditionalDirectories,
  IPC_POLL_MS,
  WORKSPACE_GROUP_DIR,
} from './runtime-env.js';
import {
  buildRunnerSystemPrompt,
  readMemoryContextBlock,
} from './system-prompt.js';
import type { AgentRunnerInput } from './types.js';

export async function runQuery(
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
  providerArtifactRef?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  const memoryBlock = readMemoryContextBlock(agentInput);
  stream.pushInitialPrompt(prompt, memoryBlock);

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
      stream.pushContent(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  if (enableIpcFollowups) {
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  }

  let newSessionId: string | undefined;
  let providerArtifactRef: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  const systemPrompt = buildRunnerSystemPrompt(agentInput, memoryBlock);
  const extraDirs = discoverAdditionalDirectories();
  const capabilities = composeAgentCapabilities({
    mcpServerPath,
    chatJid: agentInput.chatJid,
    groupFolder: agentInput.groupFolder,
    threadId: agentInput.threadId,
    isMain: agentInput.isMain,
    ipcDir: process.env.MYCLAW_IPC_DIR,
    ipcAuthToken: process.env.MYCLAW_IPC_AUTH_TOKEN,
    ipcResponseVerifyKey: process.env.MYCLAW_IPC_RESPONSE_VERIFY_KEY,
  });

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
      allowedTools: [...capabilities.allowedTools],
      env: sdkEnv,
      permissionMode: capabilities.permissionMode,
      canUseTool: async (toolName, input, permissionOpts) => {
        if (capabilities.alwaysAllowedTools.includes(toolName)) {
          return { behavior: 'allow' as const, updatedInput: input };
        }

        const memoryGuardDenial = denyMemoryBoundaryToolUse(
          toolName,
          input,
          permissionOpts,
          memoryBlock,
        );
        if (memoryGuardDenial) {
          log(
            `Permission denied by memory boundary guard: ${memoryGuardDenial}`,
          );
          return {
            behavior: 'deny' as const,
            message: memoryGuardDenial,
            interrupt: false,
          };
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
          threadId: agentInput.threadId,
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
      mcpServers: capabilities.mcpServers,
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
      providerArtifactRef = findClaudeSessionArtifact(newSessionId);
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
            providerArtifactRef,
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
      logUsage(message);

      writeOutput({
        status: 'success',
        result:
          textResult && !sawPartialTextSinceLastResult ? textResult : null,
        newSessionId,
        providerArtifactRef,
      });
      sawPartialTextSinceLastResult = false;
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return {
    newSessionId,
    providerArtifactRef,
    lastAssistantUuid,
    closedDuringQuery,
  };
}

function findClaudeSessionArtifact(
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return undefined;
  const projectsDir = path.join(configDir, 'projects');
  if (!fs.existsSync(projectsDir)) return undefined;
  const target = `${sessionId}.jsonl`;
  const stack = [projectsDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name === target) {
        return entryPath;
      }
    }
  }
  return undefined;
}

function logUsage(message: unknown): void {
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
        totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : '0.0';
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
}
