import {
  query,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import {
  composeAgentCapabilities,
  type McpServerConfig,
} from '../agent-capabilities.js';
import { denyMemoryBoundaryToolUse } from '../memory-boundary.js';
import { denyProtectedCapabilityToolUse } from './protected-capability-guard.js';
import { MessageStream } from './message-stream.js';
import {
  drainInteractionBoundaries,
  drainIpcInput,
  shouldClose,
} from './ipc-input.js';
import { SteeringDeliveryGate } from './steering-delivery-gate.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { requestPermissionApproval } from './permission-callback.js';
import { protectedCapabilityPreToolUseHook } from './protected-capability-hook.js';
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
  mcpServerPath: string,
  agentInput: AgentRunnerInput,
  sdkEnv: Record<string, string | undefined>,
  configuredModel: string | undefined,
  queryThinking: ThinkingConfig | undefined,
  queryEffort: EffortLevel | undefined,
  enableIpcFollowups = true,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  const memoryBlock = readMemoryContextBlock(agentInput);
  stream.pushInitialPrompt(prompt, memoryBlock);

  let ipcPolling = true;
  let closedDuringQuery = false;
  const steeringGate = new SteeringDeliveryGate((text) => {
    log(`Piping IPC message at turn boundary (${text.length} chars)`);
    stream.pushContent(text);
  });
  const emitInteractionBoundary = () => {
    writeOutput({
      status: 'success',
      result: null,
      newSessionId,
      interactionBoundary: 'user_interaction',
    });
  };
  const pollRuntimeSignalsDuringQuery = () => {
    if (!ipcPolling) return;
    const interactionBoundaries = drainInteractionBoundaries();
    for (let i = 0; i < interactionBoundaries; i += 1) {
      emitInteractionBoundary();
    }
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      steeringGate.close();
      stream.end();
      ipcPolling = false;
      return;
    }
    if (enableIpcFollowups) {
      const messages = drainIpcInput();
      for (const text of messages) {
        const delivery = steeringGate.accept(text);
        if (delivery === 'buffered') {
          log(
            `Buffering IPC message until query turn boundary (${text.length} chars)`,
          );
        }
      }
    }
    setTimeout(pollRuntimeSignalsDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollRuntimeSignalsDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
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
    externalMcpServers: readExternalMcpServers(),
    externalMcpAllowedTools: readExternalMcpAllowedTools(),
    externalMcpAlwaysAllowedTools: readExternalMcpAlwaysAllowedTools(),
  });

  for await (const message of query({
    prompt: stream,
    options: {
      model: configuredModel,
      thinking: queryThinking,
      effort: queryEffort,
      cwd: WORKSPACE_GROUP_DIR,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      persistSession: !agentInput.isScheduledJob,
      resume:
        !agentInput.isScheduledJob && agentInput.sessionId
          ? agentInput.sessionId
          : undefined,
      systemPrompt,
      allowedTools: [...capabilities.allowedTools],
      env: sdkEnv,
      permissionMode: capabilities.permissionMode,
      hooks: {
        PreToolUse: [
          {
            hooks: [protectedCapabilityPreToolUseHook],
            timeout: 5,
          },
        ],
      },
      canUseTool: async (toolName, input, permissionOpts) => {
        const protectedCapabilityDenial = denyProtectedCapabilityToolUse(
          toolName,
          input,
          permissionOpts,
        );
        if (protectedCapabilityDenial) {
          log(
            `Permission denied by protected capability guard: ${protectedCapabilityDenial}`,
          );
          return {
            behavior: 'deny' as const,
            message: protectedCapabilityDenial,
            interrupt: false,
          };
        }

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
        emitInteractionBoundary();
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
      assertRequiredMcpServerReady(message);
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'compact_boundary'
    ) {
      log('SDK compact boundary observed');
      writeOutput({
        status: 'success',
        result: null,
        newSessionId,
        compactBoundary: true,
      });
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
      logUsage(message);

      writeOutput({
        status: 'success',
        result:
          textResult && !sawPartialTextSinceLastResult ? textResult : null,
        newSessionId,
      });
      sawPartialTextSinceLastResult = false;
      steeringGate.markTurnBoundary();
    }
  }

  ipcPolling = false;
  steeringGate.close();
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
  };
}

function assertRequiredMcpServerReady(message: unknown): void {
  const initMessage = message as {
    mcp_servers?: Array<{ name?: unknown; status?: unknown }>;
  };
  if (!Array.isArray(initMessage.mcp_servers)) {
    throw new Error(
      'Required MyClaw MCP server status is missing from Claude init',
    );
  }

  const myclawServer = initMessage.mcp_servers.find(
    (server) => server.name === 'myclaw',
  );
  if (!myclawServer) {
    throw new Error('Required MyClaw MCP server is missing from Claude init');
  }

  const status = String(myclawServer.status ?? '').toLowerCase();
  if (status !== 'connected') {
    throw new Error(`Required MyClaw MCP server is not ready: ${status}`);
  }
}

function readExternalMcpServers(): Record<string, McpServerConfig> {
  const configPath = process.env.MYCLAW_MCP_CONFIG_FILE?.trim();
  if (configPath) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      McpServerConfig
    >;
    fs.rmSync(configPath, { force: true });
    return validateExternalMcpServers(parsed);
  }
  const raw = process.env.MYCLAW_MCP_SERVERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, McpServerConfig>;
  return validateExternalMcpServers(parsed);
}

function validateExternalMcpServers(
  parsed: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(parsed)) {
    if (name === 'myclaw') {
      throw new Error(
        'Configured MCP servers cannot override the built-in myclaw server',
      );
    }
    servers[name] = config;
  }
  return servers;
}

function readExternalMcpAllowedTools(): readonly string[] {
  const raw = process.env.MYCLAW_MCP_ALLOWED_TOOLS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function readExternalMcpAlwaysAllowedTools(): readonly string[] {
  const raw = process.env.MYCLAW_MCP_ALWAYS_ALLOWED_TOOLS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
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
