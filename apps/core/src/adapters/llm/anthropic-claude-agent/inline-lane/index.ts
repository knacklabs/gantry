import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  createSdkMcpServer,
  query,
  tool as createSdkTool,
  type McpServerConfig,
  type McpServerToolPolicy,
  type HookCallback,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

import { applyNeutralCaTrustAliases } from '../../../../shared/neutral-ca-trust-env.js';
import { mcpToolNameAllowedBySourceScope } from '../../../../shared/mcp-tool-scope.js';
import { normalizeModelUsage } from '../../../../shared/model-usage.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import { buildGantryAgentSystemPrompt } from '../../../../runner/gantry-agent-system-prompt.js';
import {
  DEFAULT_INLINE_AGENT_MAX_TURNS,
  inlineAgentMaxTurnsError,
  type ProviderInlineAgentLoopLane,
} from '../../inline-lane-dispatcher.js';
import {
  createInlineToolActivity,
  type InlineToolActivity,
} from '../../inline-lane-tool-activity.js';
import { validateModelCredentialProjectionForEntry } from '../model-provider-credential-validation.js';
import {
  SDK_NATIVE_SKILL_DISABLE_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
} from '../native-sdk-skills.js';
import { readContextUsage } from '../runner/context-usage.js';
import { MessageStream } from '../runner/message-stream.js';
import { resolveConfiguredAgentControlOptions } from '../runner/model-config.js';
import { usageEventIdForMessage } from '../runner/query-usage-event-id.js';
import {
  sdkResultFailureMessage,
  topLevelAssistantText,
} from '../runner/sdk-message-output.js';
import { SteeringDeliveryGate } from '../runner/steering-delivery-gate.js';
import { createPinnedClaudeMcpProxies } from './remote-mcp-proxy.js';

const CORE_MCP_SERVER_NAME = 'gantry';
const SDK_HOST_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
] as const;

export const runClaudeInlineAgentLoopLane: ProviderInlineAgentLoopLane = async (
  input,
) => {
  if (!input.resolvedModel.ok) {
    return {
      status: 'error',
      result: null,
      error: input.resolvedModel.message,
    };
  }
  if (input.signal.aborted) return abortedOutput();
  const maxTurns = input.maxTurns ?? DEFAULT_INLINE_AGENT_MAX_TURNS;
  const responseSchema = input.input.responseSchema;
  const toolsDisabled = input.input.disableTools === true;
  const configuredControls = resolveConfiguredAgentControlOptions(
    input.configuredThinking,
    input.effort,
  );
  validateModelCredentialProjectionForEntry({
    model: input.resolvedModel.value.modelEntry,
    projection: {
      env: { ...input.modelCredentialEnv },
      credentialProviders: {},
      brokerProfile: 'gantry',
    },
  });

  const prompt = new MessageStream();
  const queryRunId = randomUUID();
  prompt.pushInitialPrompt(input.input.prompt, input.input.memoryContextBlock);
  const steeringGate = new SteeringDeliveryGate((text) =>
    prompt.pushContent(text),
  );
  const abortController = new AbortController();
  let closeRequested = false;
  let newSessionId = input.input.sessionId;
  let lastTerminal: RunnerOutputFrame | undefined;
  const onAbort = () => {
    abortController.abort(input.signal.reason);
    steeringGate.close();
    prompt.end();
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  const unsubscribe = input.controlPort.subscribe({
    onContinuation(continuation) {
      steeringGate.accept(continuation.text);
    },
    onClose() {
      closeRequested = true;
      abortController.abort();
      steeringGate.close();
      prompt.end();
    },
  });
  if (input.input.isScheduledJob) prompt.end();
  const toolActivity = createInlineToolActivity(input);

  let remoteMcp:
    | Awaited<ReturnType<typeof createPinnedClaudeMcpProxies>>
    | undefined;
  try {
    if (!toolsDisabled) {
      remoteMcp = await createPinnedClaudeMcpProxies({
        servers: input.mcpServers,
        egressDenylist: input.egressDenylist,
        lookupHostname: input.mcpHostnameLookup,
      });
    }
    const persistSdkSession = !input.input.isScheduledJob;
    const sdkQuery = query({
      prompt,
      options: {
        abortController,
        model: input.resolvedModel.value.runnerModel,
        maxTurns,
        ...configuredControls,
        // The SDK implements outputFormat with its strict StructuredOutput answer tool.
        ...(responseSchema
          ? { outputFormat: { type: 'json_schema', schema: responseSchema } }
          : {}),
        ...(persistSdkSession && input.input.sessionId
          ? { resume: input.input.sessionId }
          : {}),
        persistSession: persistSdkSession,
        systemPrompt: inlineSystemPrompt(input),
        env: isolatedSdkEnv(
          input.modelCredentialEnv,
          path.join(input.runtimeDataDir, 'inline-claude', input.group.folder),
        ),
        settings: {
          autoMemoryEnabled: false,
          includeGitInstructions: false,
          skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
        },
        skills: [],
        settingSources: [],
        tools: [],
        allowedTools: toolsDisabled
          ? []
          : input.coreTools.tools.map(
              ({ name }) => `mcp__${CORE_MCP_SERVER_NAME}__${name}`,
            ),
        permissionMode: 'dontAsk',
        hooks: remoteMcpAuditHooks(input, toolActivity),
        canUseTool: async (toolName, toolInput, options) => {
          if (toolsDisabled) {
            return {
              behavior: 'deny',
              message: `Tool ${toolName} is unavailable during response_schema repair.`,
              toolUseID: options.toolUseID,
            };
          }
          const isCoreTool = input.coreTools.tools.some(
            ({ name }) => toolName === `mcp__${CORE_MCP_SERVER_NAME}__${name}`,
          );
          const isRemoteMcpTool = remoteMcpTool(input, toolName)?.allowed;
          if (isCoreTool) {
            return {
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
            };
          }
          if (!isRemoteMcpTool) {
            return {
              behavior: 'deny',
              message: `Tool ${toolName} is unavailable in inline mode.`,
              toolUseID: options.toolUseID,
            };
          }
          const authorization =
            await input.coreTools.authorizeThirdPartyMcpTool(
              toolName,
              toolInput,
              { signal: options.signal },
            );
          return authorization.allowed
            ? {
                behavior: 'allow',
                updatedInput: toolInput,
                toolUseID: options.toolUseID,
              }
            : {
                behavior: 'deny',
                message: authorization.reason ?? 'Permission denied.',
                toolUseID: options.toolUseID,
              };
        },
        includePartialMessages: true,
        strictMcpConfig: true,
        mcpServers: toolsDisabled
          ? {}
          : {
              [CORE_MCP_SERVER_NAME]: createCoreSdkMcpServer(
                input,
                toolActivity,
              ),
              ...Object.fromEntries(
                (remoteMcp?.servers ?? []).map((server) => [
                  server.name,
                  remoteSdkMcpConfig(server),
                ]),
              ),
            },
      },
    }) as AsyncIterable<unknown>;

    let sawMessage = false;
    let sawPartialText = false;
    let assistantText = '';
    let resultCount = 0;
    try {
      for await (const message of sdkQuery) {
        sawMessage = true;
        const record = objectRecord(message);
        if (record?.type === 'system' && record.subtype === 'init') {
          const sessionId = stringValue(record.session_id);
          if (sessionId) {
            newSessionId = sessionId;
            await input.emitOutput({
              status: 'success',
              result: null,
              newSessionId,
              sessionInit: true,
            });
          }
          continue;
        }
        if (
          record?.type === 'system' &&
          record.subtype === 'compact_boundary'
        ) {
          await input.emitOutput({
            status: 'success',
            result: null,
            newSessionId,
            compactBoundary: true,
          });
          continue;
        }
        if (record?.type === 'assistant') {
          if (!responseSchema) assistantText += topLevelAssistantText(message);
          continue;
        }
        const delta = textDelta(record);
        if (delta !== null) {
          if (responseSchema) continue;
          sawPartialText = true;
          await input.emitOutput({
            status: 'success',
            result: delta,
            newSessionId,
          });
          continue;
        }
        if (record?.type !== 'result') continue;

        if (record.subtype === 'error_max_turns') {
          lastTerminal = inlineAgentMaxTurnsError(maxTurns, newSessionId);
          await input.emitOutput(lastTerminal);
          break;
        }

        if (
          responseSchema &&
          record.subtype === 'error_max_structured_output_retries'
        ) {
          lastTerminal = structuredOutputError(
            sdkResultFailureMessage(message) ??
              'Claude SDK could not produce output matching response_schema.',
            newSessionId,
          );
          await input.emitOutput(lastTerminal);
          break;
        }

        const failure = sdkResultFailureMessage(message);
        if (failure) throw new Error(failure);
        resultCount += 1;
        const resultText = stringValue(record.result);
        const structuredResult = responseSchema
          ? jsonString(record.structured_output)
          : undefined;
        if (responseSchema && structuredResult === undefined) {
          lastTerminal = structuredOutputError(
            'Claude SDK returned success without validated structured output.',
            newSessionId,
          );
          await input.emitOutput(lastTerminal);
          break;
        }
        const contextUsage = await readContextUsage(sdkQuery);
        const usage = normalizeModelUsage({
          message,
          fallbackModel: input.resolvedModel.value.runnerModel,
        });
        const continuedByFollowup = steeringGate.pendingCount() > 0;
        lastTerminal = {
          status: 'success',
          result:
            structuredResult ??
            (sawPartialText ? null : resultText || assistantText || null),
          newSessionId,
          ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
          ...(usage
            ? {
                usage,
                usageEventId: usageEventIdForMessage(
                  message,
                  newSessionId ?? input.input.sessionId,
                  resultCount,
                  queryRunId,
                ),
              }
            : {}),
          ...(contextUsage ? { contextUsage } : {}),
        };
        await input.emitOutput(lastTerminal);
        steeringGate.markTurnBoundary();
        sawPartialText = false;
        assistantText = '';
      }
    } catch (error) {
      if (!input.signal.aborted && !closeRequested) throw error;
    }

    if (input.signal.aborted) return abortedOutput(newSessionId);
    if (!sawMessage && !closeRequested) {
      throw new Error(
        'Anthropic SDK query completed without messages or results',
      );
    }
    return lastTerminal ?? { status: 'success', result: null, newSessionId };
  } finally {
    unsubscribe();
    input.signal.removeEventListener('abort', onAbort);
    steeringGate.close();
    toolActivity.close();
    prompt.end();
    await remoteMcp?.close();
  }
};

function createCoreSdkMcpServer(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
  toolActivity: InlineToolActivity,
): McpServerConfig {
  return createSdkMcpServer({
    name: CORE_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: input.coreTools.tools.map((definition) => {
      const shape = (
        definition.inputSchema as unknown as { shape?: ZodRawShape }
      ).shape;
      if (!shape) {
        throw new Error(`Core tool ${definition.name} is missing a Zod shape.`);
      }
      return createSdkTool(
        definition.name,
        definition.description,
        shape,
        async (args) =>
          toolActivity.run(
            definition.name,
            async () =>
              (await input.coreTools.execute(definition.name, args, {
                signal: input.signal,
              })) as CallToolResult,
          ),
      ) as SdkMcpToolDefinition<any>;
    }),
    alwaysLoad: true,
  });
}

function remoteSdkMcpConfig(input: {
  type: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
  allowedToolPatterns: readonly string[];
}): McpServerConfig {
  const tools = input.allowedToolPatterns
    .filter((name) => name !== '*' && !name.endsWith('*'))
    .map(
      (name): McpServerToolPolicy => ({
        name,
        permission_policy: 'always_ask',
      }),
    );
  return {
    type: input.type,
    url: input.url,
    headers: input.headers,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function isolatedSdkEnv(
  modelCredentialEnv: Readonly<Record<string, string>>,
  configDir: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...Object.fromEntries(
      SDK_HOST_ENV_KEYS.map((key) => [key, process.env[key]]),
    ),
    ...modelCredentialEnv,
    CLAUDE_CONFIG_DIR: configDir,
    ...SDK_NATIVE_SKILL_DISABLE_ENV,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
  applyNeutralCaTrustAliases(env as Record<string, string>);
  return env;
}

function inlineSystemPrompt(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
): string[] {
  const prompt = buildGantryAgentSystemPrompt({
    runtimeProjection: 'native-tool-projection',
    assistantName: input.input.assistantName,
    persona: input.input.persona,
    compiledSystemPrompt: input.input.compiledSystemPrompt,
    hasMemoryContext: Boolean(input.input.memoryContextBlock?.trim()),
    selectedToolRules: input.input.toolPolicyRules,
    workspaceFolder: input.input.workspaceFolder,
    conversationId: input.input.chatJid,
    threadId: input.input.threadId,
    isScheduledJob: input.input.isScheduledJob,
    currentDateTimeIso: new Date().toISOString(),
  });
  return prompt.dynamicPrompt
    ? [
        prompt.staticPrompt,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
        prompt.dynamicPrompt,
      ]
    : [prompt.staticPrompt];
}

function remoteMcpAuditHooks(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
  toolActivity: InlineToolActivity,
): Record<
  'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure',
  Array<{ hooks: HookCallback[] }>
> {
  const startedAt = new Map<string, number>();
  const pre: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
    const tool = remoteMcpTool(input, hookInput.tool_name);
    if (!tool) return { continue: true };
    if (!tool.allowed) {
      const reason = `Tool ${hookInput.tool_name} is outside its reviewed MCP scope.`;
      return {
        continue: false,
        decision: 'block',
        reason,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }
    startedAt.set(hookInput.tool_use_id, Date.now());
    await toolActivity.start(hookInput.tool_use_id, hookInput.tool_name);
    await input.coreTools.recordThirdPartyMcpToolActivity({
      serverName: tool.serverName,
      toolName: tool.toolName,
      toolInput: hookInput.tool_input,
      outcome: 'attempt',
      latencyMs: 0,
    });
    return { continue: true };
  };
  const success: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PostToolUse') return { continue: true };
    const tool = remoteMcpTool(input, hookInput.tool_name);
    if (!tool?.allowed) return { continue: true };
    const result = hookInput.tool_response;
    const outcome: 'failure' | 'success' =
      objectRecord(result)?.isError === true ? 'failure' : 'success';
    const activity = {
      serverName: tool.serverName,
      toolName: tool.toolName,
      toolInput: hookInput.tool_input,
      outcome,
      latencyMs: hookLatencyMs(
        hookInput.duration_ms,
        startedAt.get(hookInput.tool_use_id),
      ),
      result,
    };
    await input.coreTools.recordThirdPartyMcpToolActivity(activity);
    startedAt.delete(hookInput.tool_use_id);
    await toolActivity.finish(
      hookInput.tool_use_id,
      hookInput.tool_name,
      outcome,
    );
    return { continue: true };
  };
  const failure: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PostToolUseFailure') {
      return { continue: true };
    }
    const tool = remoteMcpTool(input, hookInput.tool_name);
    if (!tool?.allowed) return { continue: true };
    await input.coreTools.recordThirdPartyMcpToolActivity({
      serverName: tool.serverName,
      toolName: tool.toolName,
      toolInput: hookInput.tool_input,
      outcome: 'failure',
      latencyMs: hookLatencyMs(
        hookInput.duration_ms,
        startedAt.get(hookInput.tool_use_id),
      ),
      error: new Error(hookInput.error),
    });
    startedAt.delete(hookInput.tool_use_id);
    await toolActivity.finish(
      hookInput.tool_use_id,
      hookInput.tool_name,
      'failure',
    );
    return { continue: true };
  };
  return {
    PreToolUse: [{ hooks: [pre] }],
    PostToolUse: [{ hooks: [success] }],
    PostToolUseFailure: [{ hooks: [failure] }],
  };
}

function remoteMcpTool(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
  fullToolName: string,
) {
  for (const server of input.mcpServers) {
    const prefix = `mcp__${server.name}__`;
    if (!fullToolName.startsWith(prefix)) continue;
    const toolName = fullToolName.slice(prefix.length);
    const allowed = mcpToolNameAllowedBySourceScope({
      serverName: server.name,
      fullToolName,
      allowedToolPatterns: server.allowedToolPatterns,
    });
    return {
      serverName: server.name,
      toolName,
      allowed,
    };
  }
  return undefined;
}

function hookLatencyMs(
  durationMs: number | undefined,
  startedAt?: number,
): number {
  return durationMs ?? (startedAt === undefined ? 0 : Date.now() - startedAt);
}

function textDelta(record: Record<string, unknown> | undefined): string | null {
  if (record?.type !== 'stream_event') return null;
  const event = objectRecord(record.event);
  const delta = objectRecord(event?.delta);
  return event?.type === 'content_block_delta' &&
    delta?.type === 'text_delta' &&
    typeof delta.text === 'string'
    ? delta.text
    : null;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function jsonString(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function structuredOutputError(
  error: string,
  newSessionId?: string,
): RunnerOutputFrame & { structuredOutputValidationFailure: true } {
  return {
    status: 'error',
    result: null,
    error,
    structuredOutputValidationFailure: true,
    ...(newSessionId ? { newSessionId } : {}),
  };
}

function abortedOutput(newSessionId?: string): RunnerOutputFrame {
  return {
    status: 'error',
    result: null,
    error: 'Inline Claude lane aborted.',
    ...(newSessionId ? { newSessionId } : {}),
  };
}
