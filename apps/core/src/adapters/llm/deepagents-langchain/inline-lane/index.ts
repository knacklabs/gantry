import { randomUUID } from 'node:crypto';

import { loadMcpTools } from '@langchain/mcp-adapters';
import type { BaseMessage } from '@langchain/core/messages';
import {
  tool as createLangChainTool,
  type StructuredToolInterface,
} from '@langchain/core/tools';
import type { BaseStore } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDeepAgent, StateBackend } from 'deepagents';
import type { FileData, FilesystemPermission } from 'deepagents';
import { ProviderStrategy, ToolStrategy } from 'langchain';
import pg from 'pg';

import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
} from '../../../../application/mcp/mcp-tool-proxy-network.js';
import type { MaterializedMcpCapability } from '../../../../application/mcp/mcp-server-service.js';
import { mcpToolPatternCovers } from '../../../../shared/mcp-tool-scope.js';
import type { NormalizedCacheProvider } from '../../../../shared/model-catalog.js';
import type { OpenRouterProviderRouting } from '../../../../shared/model-catalog-provider-metadata.js';
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
import { ensureDeepAgentsCheckpointSchema } from '../checkpoint-setup.js';
import {
  reconcileDeepAgentSkillFiles,
  resolveDeepAgentSkillProjection,
} from '../skill-projection.js';
import { createBuiltinToolExclusionMiddleware } from '../runner/builtin-tool-exclusion.js';
import { isAbortError } from '../runner/live-control.js';
import {
  buildRunnerModel,
  type OpenRouterProviderPreferences,
  type ResolvedRunnerModel,
} from '../runner/model-factory.js';
import {
  normalizeDeepAgentStream,
  type LangGraphStreamEvent,
} from '../runner/stream-normalizer.js';
import * as memory from './gantry-memory-middleware.js';
import { createInlineSkillsMiddleware } from './skills.js';

const CHECKPOINT_POOL_MAX_CONNECTIONS = 1;
const DENY_ALL_FILESYSTEM: FilesystemPermission[] = [
  { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
];
const READONLY_SKILLS_FILESYSTEM: FilesystemPermission[] = [
  { operations: ['read'], paths: ['/skills', '/skills/**'] },
  ...DENY_ALL_FILESYSTEM,
];

interface InlineDeepAgentGraph {
  streamEvents(
    input: { messages: BaseMessage[]; files?: Record<string, FileData | null> },
    options: {
      version: 'v2';
      signal: AbortSignal;
      configurable: { thread_id: string };
      recursionLimit: number;
    },
  ): AsyncIterable<LangGraphStreamEvent>;
}

export function createDeepAgentsInlineAgentLoopLane(input: {
  databaseUrl: string | null;
  schema: string;
}): ProviderInlineAgentLoopLane {
  return async (laneInput) => {
    if (!laneInput.resolvedModel.ok) {
      return {
        status: 'error',
        result: null,
        error: laneInput.resolvedModel.message,
      };
    }
    if (laneInput.signal.aborted) return abortedOutput();
    const maxTurns = laneInput.maxTurns ?? DEFAULT_INLINE_AGENT_MAX_TURNS;
    const skillProjection = await resolveDeepAgentSkillProjection({
      selectedSkillIds: laneInput.input.attachedSkillSourceIds,
      skillRepository: laneInput.skillRepository,
      skillArtifactStore: laneInput.skillArtifactStore,
      skillContext: laneInput.skillContext,
    });
    const hasProjectedSkills = Boolean(skillProjection);
    const backend = (config: { state: unknown; store?: BaseStore }) =>
      new StateBackend(config);

    const sessionId = laneInput.input.sessionId ?? randomUUID();
    const stop = new AbortController();
    const pendingFollowups: string[] = [];
    let closeRequested = false;
    const unsubscribe = laneInput.controlPort.subscribe({
      onContinuation(continuation) {
        pendingFollowups.push(continuation.text);
      },
      onClose() {
        closeRequested = true;
        stop.abort();
      },
    });
    const signal = AbortSignal.any([laneInput.signal, stop.signal]);
    const toolActivity = createInlineToolActivity(laneInput);
    let currentMemoryQuery = '';
    const memoryMiddleware = memory.createGantryScopedMemoryMiddleware({
      currentQuery: () => currentMemoryQuery,
      searchMemory: (query) =>
        memory.searchGantryScopedMemory(laneInput, query, signal),
    });
    let saver: PostgresSaver | undefined;
    let remoteMcp:
      | Awaited<ReturnType<typeof connectRemoteMcpTools>>
      | undefined;
    let lastTerminal: RunnerOutputFrame | undefined;
    try {
      if (!laneInput.input.isScheduledJob) {
        saver = await openCheckpointer({
          databaseUrl: input.databaseUrl,
          schema: input.schema,
          resumeSessionId: laneInput.input.sessionId,
        });
        await laneInput.emitOutput({
          status: 'success',
          result: null,
          newSessionId: sessionId,
          sessionInit: true,
        });
      }

      const model = await buildInlineModel(laneInput, sessionId);
      remoteMcp = await connectRemoteMcpTools(laneInput.mcpServers, {
        authorizeThirdPartyMcpTool:
          laneInput.coreTools.authorizeThirdPartyMcpTool,
        recordThirdPartyMcpToolActivity:
          laneInput.coreTools.recordThirdPartyMcpToolActivity,
        egressDenylist: laneInput.egressDenylist,
        lookupHostname: laneInput.mcpHostnameLookup,
        signal,
        toolActivity,
      });
      const tools = [
        ...buildCoreLangChainTools(laneInput, toolActivity),
        ...remoteMcp.tools,
      ];
      const skillFiles = reconcileDeepAgentSkillFiles({
        currentFiles: skillProjection?.files,
        checkpointTuple:
          saver && laneInput.input.sessionId
            ? await saver.getTuple({
                configurable: { thread_id: laneInput.input.sessionId },
              })
            : undefined,
      });
      const graph = createDeepAgent({
        model: model.model,
        ...(laneInput.input.responseSchema
          ? {
              responseFormat: responseFormatForSchema(
                laneInput.input.responseSchema,
                model.model,
              ),
            }
          : {}),
        backend,
        ...(saver ? { checkpointer: saver } : {}),
        permissions: hasProjectedSkills
          ? READONLY_SKILLS_FILESYSTEM
          : DENY_ALL_FILESYSTEM,
        subagents: [],
        tools: tools as StructuredToolInterface[] as never,
        middleware: [
          memoryMiddleware,
          ...(skillProjection
            ? [
                createInlineSkillsMiddleware({
                  backend,
                  sources: skillProjection.sources,
                }),
              ]
            : []),
          createBuiltinToolExclusionMiddleware({
            exposeSkillReadTools: hasProjectedSkills,
          }),
        ] as never,
        systemPrompt: inlineSystemPrompt(laneInput),
      }) as unknown as InlineDeepAgentGraph;

      let firstTurn = true;
      let emitChain = Promise.resolve();
      for (;;) {
        const queued = pendingFollowups.splice(0);
        const prompt = firstTurn
          ? [laneInput.input.prompt, ...queued].join('\n')
          : queued.join('\n');
        if (!prompt) break;
        currentMemoryQuery = prompt;
        const messages = memory.buildInlineTurnMessages(
          prompt,
          firstTurn ? laneInput.input.memoryContextBlock : undefined,
        );
        firstTurn = false;

        let normalized: Awaited<ReturnType<typeof normalizeDeepAgentStream>>;
        let structuredResponse: unknown;
        try {
          normalized = await normalizeDeepAgentStream({
            events: captureStructuredResponse(
              graph.streamEvents(
                {
                  messages,
                  ...(skillFiles ? { files: skillFiles } : {}),
                },
                {
                  version: 'v2',
                  signal,
                  configurable: { thread_id: sessionId },
                  // Claude max_turns counts SDK turns; this bounds LangGraph steps.
                  recursionLimit: maxTurns,
                },
              ),
              (value) => {
                structuredResponse = value;
              },
            ),
            newSessionId: sessionId,
            modelId: model.modelId,
            modelProfile: readModelProfile(model.model),
            cacheProvider: cacheProvider(model),
            runtimeEventContext: {
              appId: laneInput.input.appId,
              agentId: laneInput.input.agentId,
              runId: laneInput.input.runId,
              jobId: laneInput.input.jobId,
              conversationId: laneInput.input.chatJid,
              threadId: laneInput.input.threadId,
              actor: 'deepagents',
            },
            emit: (output) => {
              if (laneInput.input.responseSchema && !output.runtimeEventOnly) {
                return;
              }
              emitChain = emitChain.then(() => laneInput.emitOutput(output));
            },
          });
          await emitChain;
        } catch (error) {
          if (signal.aborted && isAbortError(error)) break;
          if (isGraphRecursionLimitError(error)) {
            await emitChain;
            const terminal = inlineAgentMaxTurnsError(maxTurns, sessionId);
            await laneInput.emitOutput(terminal);
            return terminal;
          }
          if (
            laneInput.input.responseSchema &&
            isStructuredOutputError(error)
          ) {
            await emitChain;
            const terminal = structuredOutputError(error, sessionId);
            await laneInput.emitOutput(terminal);
            return terminal;
          }
          throw error;
        }
        if (signal.aborted || closeRequested) break;

        let terminalResult = normalized.terminalResult;
        if (laneInput.input.responseSchema) {
          try {
            terminalResult =
              structuredResponse === undefined
                ? null
                : JSON.stringify(structuredResponse);
          } catch (error) {
            const terminal = structuredOutputError(error, sessionId);
            await laneInput.emitOutput(terminal);
            return terminal;
          }
          if (terminalResult === null) {
            const terminal = structuredOutputError(undefined, sessionId);
            await laneInput.emitOutput(terminal);
            return terminal;
          }
        }

        const continuedByFollowup = pendingFollowups.length > 0;
        lastTerminal = {
          status: 'success',
          result: terminalResult,
          newSessionId: sessionId,
          ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
          usage: normalized.terminalUsage,
          contextUsage: normalized.terminalContextUsage,
        };
        await laneInput.emitOutput(lastTerminal);
        if (laneInput.input.isScheduledJob) break;
        if (!continuedByFollowup && pendingFollowups.length === 0) break;
      }

      if (laneInput.signal.aborted) return abortedOutput(sessionId);
      return (
        lastTerminal ?? {
          status: 'success',
          result: null,
          newSessionId: sessionId,
        }
      );
    } finally {
      unsubscribe();
      toolActivity.close();
      await remoteMcp?.close().catch(() => undefined);
      await saver?.end().catch(() => undefined);
    }
  };
}

async function openCheckpointer(input: {
  databaseUrl: string | null;
  schema: string;
  resumeSessionId?: string;
}): Promise<PostgresSaver> {
  const databaseUrl = input.databaseUrl?.trim();
  const schema = input.schema.trim();
  if (!databaseUrl || !schema) {
    throw new Error(
      'DeepAgents inline lane requires Postgres checkpointer configuration.',
    );
  }
  await ensureDeepAgentsCheckpointSchema({ databaseUrl, schema });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: CHECKPOINT_POOL_MAX_CONNECTIONS,
  });
  const saver = new PostgresSaver(pool, undefined, { schema });
  if (input.resumeSessionId) {
    try {
      const tuple = await saver.getTuple({
        configurable: { thread_id: input.resumeSessionId },
      });
      if (!tuple) {
        throw new Error(
          `No DeepAgents session found with session ID: ${input.resumeSessionId}`,
        );
      }
    } catch (error) {
      await saver.end().catch(() => undefined);
      throw error;
    }
  }
  return saver;
}

async function buildInlineModel(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
  sessionId: string,
): Promise<ResolvedRunnerModel> {
  if (!input.resolvedModel.ok) throw new Error(input.resolvedModel.message);
  const baseUrl = input.modelCredentialEnv.OPENAI_BASE_URL?.trim();
  const token = input.modelCredentialEnv.OPENAI_API_KEY?.trim();
  if (!baseUrl || !token) {
    throw new Error(
      'DeepAgents inline lane is missing loopback gateway model credentials.',
    );
  }
  const openRouterProviderRouting = toOpenRouterProviderPreferences(
    input.resolvedModel.value.modelEntry.providerRouting?.openrouter,
  );
  return buildRunnerModel({
    provider: input.resolvedModel.value.modelEntry.modelRoute.id,
    modelId: input.resolvedModel.value.runnerModel,
    gatewayBaseUrl: baseUrl,
    gatewayToken: token,
    sessionId,
    effort: input.effort,
    configuredThinking: input.configuredThinking,
    maxOutputTokens: input.maxOutputTokens,
    ...(openRouterProviderRouting ? { openRouterProviderRouting } : {}),
    ...(input.resolvedModel.value.modelEntry.contextWindowTokens
      ? {
          maxInputTokens:
            input.resolvedModel.value.modelEntry.contextWindowTokens,
        }
      : {}),
  });
}
function toOpenRouterProviderPreferences(
  routing: OpenRouterProviderRouting | undefined,
): OpenRouterProviderPreferences | undefined {
  if (!routing) return undefined;
  return {
    ...(routing.only ? { only: [...routing.only] } : {}),
    ...(routing.ignore ? { ignore: [...routing.ignore] } : {}),
    ...(routing.order ? { order: [...routing.order] } : {}),
    ...(routing.allowFallbacks !== undefined
      ? { allow_fallbacks: routing.allowFallbacks }
      : {}),
    ...(routing.requireParameters !== undefined
      ? { require_parameters: routing.requireParameters }
      : {}),
    ...(routing.dataCollection !== undefined
      ? { data_collection: routing.dataCollection }
      : {}),
    ...(routing.zdr !== undefined ? { zdr: routing.zdr } : {}),
    ...(routing.enforceDistillableText !== undefined
      ? { enforce_distillable_text: routing.enforceDistillableText }
      : {}),
    ...(routing.quantizations
      ? { quantizations: [...routing.quantizations] }
      : {}),
    ...(routing.sort ? { sort: routing.sort } : {}),
  };
}

function buildCoreLangChainTools(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
  toolActivity: InlineToolActivity,
): StructuredToolInterface[] {
  return input.coreTools.tools.map((definition) =>
    createLangChainTool(
      (args, config) =>
        toolActivity.run(definition.name, () =>
          input.coreTools.execute(definition.name, args, {
            signal: config?.signal ?? input.signal,
          }),
        ),
      {
        name: definition.name,
        description: definition.description,
        schema: definition.inputSchema as never,
      },
    ),
  );
}

async function connectRemoteMcpTools(
  servers: readonly MaterializedMcpCapability[],
  input: {
    authorizeThirdPartyMcpTool: Parameters<ProviderInlineAgentLoopLane>[0]['coreTools']['authorizeThirdPartyMcpTool'];
    recordThirdPartyMcpToolActivity: Parameters<ProviderInlineAgentLoopLane>[0]['coreTools']['recordThirdPartyMcpToolActivity'];
    egressDenylist: readonly string[];
    lookupHostname?: Parameters<
      typeof createGuardedMcpFetch
    >[0]['lookupHostname'];
    signal: AbortSignal;
    toolActivity: InlineToolActivity;
  },
): Promise<{ tools: StructuredToolInterface[]; close(): Promise<void> }> {
  const guardedFetch = createGuardedMcpFetch({
    lookupHostname: input.lookupHostname,
  });
  const clients: Client[] = [];
  const tools: StructuredToolInterface[] = [];
  try {
    for (const server of servers) {
      if (server.config.type !== 'http' && server.config.type !== 'sse')
        continue;
      input.signal.throwIfAborted();
      assertMcpNetworkHostAllowed({
        serverName: server.name,
        url: server.config.url,
        denylist: input.egressDenylist,
      });
      const client = new Client({
        name: `gantry-inline-${server.name}`,
        version: '1.0.0',
      });
      const headers = server.config.headers;
      const transport =
        server.config.type === 'sse'
          ? new SSEClientTransport(new URL(server.config.url), {
              fetch: guardedFetch as never,
              requestInit: headers ? { headers } : undefined,
            })
          : new StreamableHTTPClientTransport(new URL(server.config.url), {
              fetch: guardedFetch as never,
              requestInit: headers ? { headers } : undefined,
            });
      await client.connect(transport);
      clients.push(client);
      const loaded = await loadMcpTools(server.name, client, {
        prefixToolNameWithServerName: false,
      });
      for (const remoteTool of loaded) {
        if (
          !server.allowedToolPatterns.some((pattern) =>
            mcpToolPatternCovers(pattern, remoteTool.name),
          )
        ) {
          continue;
        }
        const toolName = `mcp__${server.name}__${remoteTool.name}`;
        tools.push(
          createLangChainTool(
            async (args, config) => {
              const authorization = await input.authorizeThirdPartyMcpTool(
                toolName,
                args,
                { signal: config?.signal ?? input.signal },
              );
              if (!authorization.allowed) {
                return `Permission denied: ${authorization.reason ?? 'request denied'}`;
              }
              return input.toolActivity.run(toolName, async () => {
                const startedAt = Date.now();
                await input.recordThirdPartyMcpToolActivity({
                  serverName: server.name,
                  toolName: remoteTool.name,
                  toolInput: args,
                  outcome: 'attempt',
                  latencyMs: 0,
                });
                try {
                  const result = await remoteTool.invoke(
                    args,
                    config?.signal ? { signal: config.signal } : undefined,
                  );
                  await input.recordThirdPartyMcpToolActivity({
                    serverName: server.name,
                    toolName: remoteTool.name,
                    toolInput: args,
                    outcome: 'success',
                    latencyMs: Date.now() - startedAt,
                  });
                  return typeof result === 'string'
                    ? result
                    : JSON.stringify(result);
                } catch (error) {
                  await input.recordThirdPartyMcpToolActivity({
                    serverName: server.name,
                    toolName: remoteTool.name,
                    toolInput: args,
                    outcome: 'failure',
                    latencyMs: Date.now() - startedAt,
                    error,
                  });
                  throw error;
                }
              });
            },
            {
              name: toolName,
              description: remoteTool.description,
              schema: remoteTool.schema as never,
            },
          ),
        );
      }
    }
  } catch (error) {
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
    throw error;
  }
  return {
    tools,
    close: () =>
      Promise.all(clients.map((client) => client.close())).then(
        () => undefined,
      ),
  };
}

function inlineSystemPrompt(
  input: Parameters<ProviderInlineAgentLoopLane>[0],
): string {
  return buildGantryAgentSystemPrompt({
    runtimeProjection: 'wrapped-tool-projection',
    assistantName: input.input.assistantName,
    persona: input.input.persona,
    compiledSystemPrompt: input.input.compiledSystemPrompt,
    hasMemoryContext: true,
    selectedToolRules: input.input.toolPolicyRules,
    workspaceFolder: input.input.workspaceFolder,
    conversationId: input.input.chatJid,
    threadId: input.input.threadId,
    isScheduledJob: input.input.isScheduledJob,
    currentDateTimeIso: new Date().toISOString(),
  }).prompt;
}

function readModelProfile(model: unknown): {
  maxInputTokens?: number;
  maxOutputTokens?: number;
} {
  try {
    const profile = (
      model as {
        profile?: { maxInputTokens?: number; maxOutputTokens?: number };
      }
    ).profile;
    return profile && typeof profile === 'object' ? profile : {};
  } catch {
    return {};
  }
}

function cacheProvider(model: ResolvedRunnerModel): NormalizedCacheProvider {
  return model.endpointFamily === 'openrouter'
    ? 'openrouter-provider'
    : 'openai';
}

function isGraphRecursionLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; lc_error_code?: unknown };
  return (
    value.name === 'GraphRecursionError' ||
    value.lc_error_code === 'GRAPH_RECURSION_LIMIT'
  );
}

async function* captureStructuredResponse(
  events: AsyncIterable<LangGraphStreamEvent>,
  capture: (value: unknown) => void,
): AsyncIterable<LangGraphStreamEvent> {
  for await (const event of events) {
    const output = event.data?.output;
    if (
      output &&
      typeof output === 'object' &&
      'structuredResponse' in output &&
      output.structuredResponse !== undefined
    ) {
      capture(output.structuredResponse);
    }
    yield event;
  }
}

function isStructuredOutputError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    const value = current as {
      name?: unknown;
      message?: unknown;
      errors?: unknown;
      toolNames?: unknown;
      cause?: unknown;
    };
    if (
      [
        'StructuredOutputParsingError',
        'MultipleStructuredOutputsError',
      ].includes(String(value.name)) ||
      Array.isArray(value.errors) ||
      Array.isArray(value.toolNames) ||
      String(value.message).toLowerCase().includes('structured output')
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

function responseFormatForSchema(
  schema: Record<string, unknown>,
  { profile: { structuredOutput } }: ResolvedRunnerModel['model'],
) {
  const name = 'gantry_structured_output';
  const normalized = { ...schema, name, title: name };
  if (structuredOutput === true) return ProviderStrategy.fromSchema(normalized);
  return ToolStrategy.fromSchema(normalized);
}
function structuredOutputError(
  error: unknown,
  newSessionId: string,
): RunnerOutputFrame {
  const detail = error instanceof Error ? ` ${error.message}` : '';
  return {
    status: 'error',
    result: null,
    error: `Inline structured output failed schema validation.${detail}`,
    newSessionId,
  };
}

function abortedOutput(newSessionId?: string): RunnerOutputFrame {
  return {
    status: 'error',
    result: null,
    error: 'Inline DeepAgents lane aborted.',
    ...(newSessionId ? { newSessionId } : {}),
  };
}
