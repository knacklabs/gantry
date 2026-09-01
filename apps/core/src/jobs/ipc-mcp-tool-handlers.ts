import path from 'path';
import { z } from 'zod';

import { publishInvalidMcpToolRequestAudit } from '../application/mcp/mcp-tool-audit.js';
import { appIdFromConversationJid } from '../shared/app-conversation-jid.js';
import type { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import {
  isAsyncTaskTerminal,
  toPublicAsyncTaskDto,
  type AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import { jobArtifactScope } from '../domain/ports/job-semantic-checkpoints.js';
import type { JobSemanticCheckpointPayload } from '../domain/ports/job-semantic-checkpoints.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { FileArtifactId } from '../domain/file-artifacts/file-artifact.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { readAsyncCommandSandboxPolicy } from '../runtime/async-command-sandbox-policy.js';
import { resolveRunnerIpcRoute } from '../runtime/ipc-route-authorization.js';
import type { McpCompatibleToolError } from '../runtime/core-tools/registry.js';
import {
  createAsyncMcpTask,
  enqueueAsyncMcpTask,
} from './async-mcp-tool-task.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';
import {
  mcpCallToolProxyInput,
  mcpDescribeToolProxyInput,
  mcpListToolsProxyInput,
} from './ipc-mcp-list-tools-input.js';
import { delegatedTaskAgentInScope } from './async-command-task-helpers.js';
import { ExternalCapabilityTaskService } from '../application/capabilities/external-capability-task-service.js';
import { suspendForExternalCapability } from './external-capability-suspension.js';
import { notifyAsyncTaskChange } from './async-task-change-waiter.js';
import { stableSha256Json } from '../shared/stable-hash.js';
type CreateMcpProxyForSourceGroup = (input: {
  appId: import('../domain/app/app.js').AppId;
  agentId: import('../domain/agent/agent.js').AgentId;
  conversationId?: string;
  threadId?: string;
  deps: Parameters<TaskHandler>[0]['deps'];
  ipcDir?: string;
  runHandle?: string;
  runId?: string;
}) => Promise<McpToolProxy>;

const JSON_ARTIFACT_INCLUDE_KEY = '$gantryArtifactJson';
const MAX_EXTERNAL_CAPABILITY_ARGUMENT_BYTES = 10 * 1024 * 1024;
const MAX_EXTERNAL_CAPABILITY_ARTIFACT_INCLUDES = 64;
const MAX_EXTERNAL_CAPABILITY_ARTIFACT_DEPTH = 16;
export function createMcpToolHandlers(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): {
  mcpListToolsHandler: TaskHandler;
  mcpSearchToolsHandler: TaskHandler;
  mcpDescribeToolHandler: TaskHandler;
  mcpCallToolHandler: TaskHandler;
  asyncMcpCallToolHandler: TaskHandler;
  externalCapabilityCallToolHandler: TaskHandler;
} {
  return {
    mcpListToolsHandler: mcpListToolsHandler(createMcpProxyForSourceGroup),
    mcpSearchToolsHandler: mcpSearchToolsHandler(createMcpProxyForSourceGroup),
    mcpDescribeToolHandler: mcpDescribeToolHandler(
      createMcpProxyForSourceGroup,
    ),
    mcpCallToolHandler: mcpCallToolHandler(createMcpProxyForSourceGroup),
    asyncMcpCallToolHandler: asyncMcpCallToolHandler(
      createMcpProxyForSourceGroup,
    ),
    externalCapabilityCallToolHandler: externalCapabilityCallToolHandler(
      createMcpProxyForSourceGroup,
    ),
  };
}

function externalCapabilityCallToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
    const jobId = toTrimmedString(data.jobId, { maxLen: 120 });
    const runId = toTrimmedString(data.runId, { maxLen: 120 });
    if (
      !data.appId ||
      !jobId ||
      !runId ||
      jobId !== data.sourceJobId ||
      runId !== data.sourceRunId
    ) {
      reject(
        'External capability calls require the authenticated scheduled job and run.',
        'forbidden',
      );
      return;
    }
    const targetJid = validateSameChannelMcpTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'External capability call',
      reject,
    });
    if (!targetJid) return;
    const routeScope = resolveMcpRouteScope(
      context,
      targetJid,
      'External capability call',
      reject,
    );
    if (!routeScope) return;
    const payload = data.payload || {};
    const input = mcpCallToolProxyInput(payload);
    const capabilityId = toTrimmedString(payload.capabilityId, { maxLen: 512 });
    const idempotencyKey = toTrimmedString(payload.idempotencyKey, {
      maxLen: 512,
    });
    const artifactArguments = await readExternalCapabilityArgumentsArtifact({
      context,
      appId: data.appId,
      agentId: agentIdForMcpTask(data, sourceAgentFolder),
      jobId,
      payload,
      directArguments: input.arguments,
    });
    if (artifactArguments.error) {
      acceptData(
        artifactArguments.error.message,
        artifactArguments.error,
        artifactArguments.error.code,
      );
      return;
    }
    const resolvedArguments = artifactArguments.arguments ?? input.arguments;
    if (
      !input.serverName ||
      !input.toolName ||
      input.invalidArguments ||
      !capabilityId ||
      !idempotencyKey ||
      !resolvedArguments
    ) {
      reject(
        'serverName, toolName, capabilityId, idempotencyKey, and exactly one of object arguments or argumentsArtifactId are required.',
        'invalid_request',
      );
      return;
    }
    const expandedArguments = await expandExternalCapabilityArtifactIncludes({
      context,
      appId: data.appId,
      agentId: agentIdForMcpTask(data, sourceAgentFolder),
      jobId,
      value: resolvedArguments,
    });
    if (expandedArguments.error) {
      acceptData(
        expandedArguments.error.message,
        expandedArguments.error,
        expandedArguments.error.code,
      );
      return;
    }
    if (Object.hasOwn(expandedArguments.arguments, '_gantryCapabilityTask')) {
      reject(
        '_gantryCapabilityTask is reserved for Gantry.',
        'invalid_request',
      );
      return;
    }
    const activeLease = await isActiveRunLeaseForInteraction({
      runId,
      runLeaseToken: data.runLeaseToken,
      runLeaseFencingVersion: data.runLeaseFencingVersion,
    });
    if (!activeLease) {
      reject(
        'External capability call rejected because the run lease is no longer active.',
        'stale_run_lease',
      );
      return;
    }
    const agentId = agentIdForMcpTask(data, sourceAgentFolder);
    const args = expandedArguments.arguments;
    let proxy: McpToolProxy;
    let preflight: Awaited<
      ReturnType<McpToolProxy['preflightExternalCapabilityCall']>
    >;
    try {
      proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId,
      });
      preflight = await proxy.preflightExternalCapabilityCall({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        serverName: input.serverName,
        toolName: input.toolName,
        arguments: args,
        capabilityId,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'External capability preflight is temporarily unavailable.';
      acceptData(
        message,
        {
          status: 'rejected',
          code: 'CAPABILITY_PREFLIGHT_UNAVAILABLE',
          message,
          repairable: true,
          retryable: true,
          retrySamePayload: true,
          diagnostics: [
            {
              instancePath: '$',
              keyword: 'capability_preflight',
              message,
            },
          ],
        },
        'CAPABILITY_PREFLIGHT_UNAVAILABLE',
      );
      return;
    }
    if (!preflight.ok) {
      acceptData(preflight.message, preflight, preflight.code);
      return;
    }
    if (preflight.operation.executionMode === 'sync') {
      try {
        const result = await proxy.callTool({
          appId: data.appId as never,
          agentId,
          ...routeScope,
          serverName: input.serverName,
          toolName: input.toolName,
          arguments: args,
          authorizationArguments: args,
          timeoutMs: preflight.operation.deadlineMs,
        });
        const resultEnvelope = validateExternalCapabilityResultEnvelope(
          result,
          preflight.operation.resultEnvelopeSchema,
        );
        if (!resultEnvelope.ok) {
          acceptData(
            resultEnvelope.message,
            resultEnvelope,
            resultEnvelope.code,
          );
          return;
        }
        acceptData('External capability completed synchronously.', {
          status: 'completed',
          result: resultEnvelope.value,
        });
      } catch (error) {
        reject(
          error instanceof Error
            ? error.message
            : 'External capability call failed.',
          'mcp_proxy_failed',
        );
      }
      return;
    }
    const repository = deps.getAsyncTaskRepository?.();
    if (!repository) {
      reject(
        'Durable external capability tasks are unavailable.',
        'unavailable',
      );
      return;
    }
    const invocationRef = `invocation:${idempotencyKey}`;
    const service = new ExternalCapabilityTaskService(repository, () =>
      notifyAsyncTaskChange(repository),
    );
    const acceptance = await service.accept({
      appId: data.appId,
      agentId,
      conversationId: targetJid,
      threadId: data.authThreadId || data.threadId || null,
      jobId,
      runId,
      capabilityId,
      operation: input.toolName,
      invocationRef,
      idempotencyKey,
      summary: toTrimmedString(payload.summary, { maxLen: 1000 }) || undefined,
    });
    try {
      if (acceptance.created) {
        const result = await proxy.callTool({
          appId: data.appId as never,
          agentId,
          ...routeScope,
          serverName: input.serverName,
          toolName: input.toolName,
          arguments: {
            ...args,
            _gantryCapabilityTask: {
              taskId: acceptance.taskId,
              completionToken: acceptance.completionToken,
            },
          },
          authorizationArguments: args,
          timeoutMs: preflight.operation.deadlineMs,
        });
        const resultEnvelope = validateExternalCapabilityResultEnvelope(
          result,
          preflight.operation.resultEnvelopeSchema,
        );
        if (!resultEnvelope.ok) {
          throw new Error(resultEnvelope.message);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'External capability submission failed.';
      if (acceptance.completionToken) {
        await service.cancel({
          appId: data.appId,
          taskId: acceptance.taskId,
          completionToken: acceptance.completionToken,
          cancellationId: `submit-failed:${data.taskId ?? acceptance.taskId}`,
          reason: message,
        });
      }
      acceptData(
        message,
        {
          status: 'rejected',
          code: 'CAPABILITY_SUBMISSION_REJECTED',
          message,
          repairable: true,
          retryable: true,
          retrySamePayload: false,
          diagnostics: [
            {
              instancePath: '$',
              keyword: 'capability_submission',
              message,
            },
          ],
        },
        'CAPABILITY_SUBMISSION_REJECTED',
      );
      return;
    }
    if (
      acceptance.status === 'waiting_external' &&
      preflight.operation.suspensionCheckpoint
    ) {
      const checkpoint = await persistExternalCapabilitySuspensionCheckpoint({
        context,
        appId: data.appId,
        agentId,
        jobId,
        runId,
        leaseToken: data.runLeaseToken ?? '',
        invocationRef,
        contract: preflight.operation.suspensionCheckpoint,
      });
      if (!checkpoint.ok) {
        if (acceptance.completionToken) {
          await service.cancel({
            appId: data.appId,
            taskId: acceptance.taskId,
            completionToken: acceptance.completionToken,
            cancellationId: `checkpoint-failed:${data.taskId ?? acceptance.taskId}`,
            reason: checkpoint.message,
          });
        }
        acceptData(
          checkpoint.message,
          {
            status: 'rejected',
            code: checkpoint.code,
            message: checkpoint.message,
            repairable: false,
            retryable: true,
            retrySamePayload: true,
            diagnostics: [
              {
                instancePath: '$',
                keyword: 'suspension_checkpoint',
                message: checkpoint.message,
              },
            ],
          },
          checkpoint.code,
        );
        return;
      }
    }
    acceptData('External capability accepted; the job is suspending.', {
      taskId: acceptance.taskId,
      status: acceptance.status,
    });
    if (acceptance.status === 'waiting_external') {
      suspendForExternalCapability({ jobId, runId, taskId: acceptance.taskId });
    }
  };
}

async function persistExternalCapabilitySuspensionCheckpoint(input: {
  context: TaskContext;
  appId: string;
  agentId: ReturnType<typeof agentIdForMcpTask>;
  jobId: string;
  runId: string;
  leaseToken: string;
  invocationRef: string;
  contract: {
    milestone: string;
    payloadPatch: Record<string, unknown>;
    invocationRefPath: string[];
  };
}): Promise<
  | { ok: true }
  | {
      ok: false;
      code: 'CAPABILITY_CHECKPOINT_UNAVAILABLE' | 'CAPABILITY_CHECKPOINT_REJECTED';
      message: string;
    }
> {
  const repository =
    input.context.deps.getJobSemanticCheckpointRepository?.();
  const job = input.context.deps.opsRepository
    ? await input.context.deps.opsRepository.getJobById(input.jobId)
    : null;
  const checkpointContract = job?.agent_task?.checkpointContract;
  if (!repository || !checkpointContract) {
    return {
      ok: false,
      code: 'CAPABILITY_CHECKPOINT_UNAVAILABLE',
      message:
        'The durable capability requires a registered checkpoint contract and checkpoint repository.',
    };
  }
  if (
    checkpointContract.schemaDigest !==
    `sha256:${stableSha256Json(checkpointContract.schema)}`
  ) {
    return {
      ok: false,
      code: 'CAPABILITY_CHECKPOINT_REJECTED',
      message: 'The registered checkpoint schema digest has drifted.',
    };
  }
  const latest = await repository.getLatestCheckpoint({
    appId: input.appId,
    agentId: input.agentId,
    jobId: input.jobId,
  });
  if (!latest) {
    return {
      ok: false,
      code: 'CAPABILITY_CHECKPOINT_REJECTED',
      message:
        'The durable capability requires a prior semantic checkpoint before suspension.',
    };
  }
  const payload = structuredClone(latest.payload) as unknown as Record<
    string,
    unknown
  >;
  Object.assign(payload, structuredClone(input.contract.payloadPatch));
  if (
    !setCheckpointPath(
      payload,
      input.contract.invocationRefPath,
      input.invocationRef,
    )
  ) {
    return {
      ok: false,
      code: 'CAPABILITY_CHECKPOINT_REJECTED',
      message: 'The suspension checkpoint invocationRefPath is unsafe.',
    };
  }
  const validation = z.fromJSONSchema(checkpointContract.schema).safeParse(payload);
  if (!validation.success) {
    return {
      ok: false,
      code: 'CAPABILITY_CHECKPOINT_REJECTED',
      message: `The suspension checkpoint violates the registered checkpoint schema: ${validation.error.issues
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .join('; ')}`,
    };
  }
  const result = await repository.appendCheckpoint({
    id: `job-checkpoint-${stableSha256Json({
      jobId: input.jobId,
      invocationRef: input.invocationRef,
      milestone: input.contract.milestone,
    }).slice(0, 48)}`,
    appId: input.appId,
    agentId: input.agentId,
    jobId: input.jobId,
    runId: input.runId,
    leaseToken: input.leaseToken,
    expectedPreviousSequence: latest.sequence,
    milestone: input.contract.milestone,
    payload: validation.data as JobSemanticCheckpointPayload,
  });
  if (result.outcome !== 'persisted' && result.outcome !== 'replayed') {
    return {
      ok: false,
      code: 'CAPABILITY_CHECKPOINT_REJECTED',
      message: `The suspension checkpoint was not persisted (${result.outcome}).`,
    };
  }
  await input.context.deps.publishRuntimeEvent?.({
    appId: input.appId as never,
    agentId: input.agentId,
    runId: input.runId as never,
    jobId: input.jobId as never,
    eventType: RUNTIME_EVENT_TYPES.TASK_UPDATED,
    actor: 'gantry-runtime',
    payload: {
      type: 'job_checkpoint_saved',
      checkpoint: result.checkpoint,
    },
  });
  return { ok: true };
}

function setCheckpointPath(
  root: Record<string, unknown>,
  pathParts: string[],
  value: string,
): boolean {
  if (
    pathParts.length === 0 ||
    pathParts.some((part) =>
      ['__proto__', 'prototype', 'constructor'].includes(part),
    )
  ) {
    return false;
  }
  let target = root;
  for (const part of pathParts.slice(0, -1)) {
    const child = target[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  }
  target[pathParts.at(-1)!] = value;
  return true;
}

function validateExternalCapabilityResultEnvelope(
  result: unknown,
  schema: Record<string, unknown> | undefined,
):
  | { ok: true; value: unknown }
  | {
      ok: false;
      code: 'external_capability_result_invalid';
      message: string;
      details: string[];
    } {
  const value = externalCapabilityStructuredContent(result);
  if (!schema) return { ok: true, value };
  const parsed = z.fromJSONSchema(schema).safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const details = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '$'}: ${issue.message}`,
  );
  return {
    ok: false,
    code: 'external_capability_result_invalid',
    message: `External capability returned a result that violates its pinned result schema: ${details.join('; ')}`,
    details,
  };
}

function externalCapabilityStructuredContent(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (record.structuredContent !== undefined) return record.structuredContent;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).text
        : undefined,
    )
    .find((item): item is string => typeof item === 'string');
  if (!text) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return result;
  }
}

async function readExternalCapabilityArgumentsArtifact(input: {
  context: TaskContext;
  appId: string;
  agentId: ReturnType<typeof agentIdForMcpTask>;
  jobId: string;
  payload: Record<string, unknown>;
  directArguments?: Record<string, unknown>;
}): Promise<
  | {
      arguments?: Record<string, unknown>;
      error?: undefined;
    }
  | {
      arguments?: undefined;
      error: {
        status: 'rejected';
        code: string;
        message: string;
        repairable: boolean;
        retryable: boolean;
        retrySamePayload: boolean;
        diagnostics: Array<{
          instancePath: '$';
          keyword: 'artifact';
          message: string;
        }>;
      };
    }
> {
  const rawArtifactId = toTrimmedString(input.payload.argumentsArtifactId, {
    maxLen: 80,
  });
  if (!rawArtifactId) return {};
  if (input.directArguments) {
    return {
      error: externalCapabilityArgumentsArtifactError(
        'CAPABILITY_ARGUMENTS_SOURCE_INVALID',
        'arguments and argumentsArtifactId are mutually exclusive; submit exactly one.',
      ),
    };
  }
  if (!/^file-artifact:[0-9a-f-]{36}$/iu.test(rawArtifactId)) {
    return {
      error: externalCapabilityArgumentsArtifactError(
        'CAPABILITY_ARGUMENTS_ARTIFACT_INVALID',
        'argumentsArtifactId must be a FileArtifact identifier.',
      ),
    };
  }
  const store = input.context.deps.getFileArtifactStore?.();
  if (!store) {
    return {
      error: externalCapabilityArgumentsArtifactError(
        'CAPABILITY_ARGUMENTS_ARTIFACT_UNAVAILABLE',
        'FileArtifact storage is unavailable.',
        true,
      ),
    };
  }
  try {
    const { artifact, content } = await store.readFileArtifact({
      id: rawArtifactId as FileArtifactId,
      appId: input.appId,
      agentId: input.agentId,
    });
    if (artifact.virtualScope !== jobArtifactScope(input.jobId)) {
      return {
        error: externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_SCOPE_INVALID',
          'argumentsArtifactId must belong to the authenticated scheduled job.',
        ),
      };
    }
    if (artifact.sizeBytes > 10 * 1024 * 1024) {
      return {
        error: externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_TOO_LARGE',
          'External capability arguments exceed 10 MiB.',
        ),
      };
    }
    const text =
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        error: externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_PARSE_INVALID',
          'External capability arguments FileArtifact must contain valid JSON. Rewrite the artifact and retry with a new idempotency key.',
        ),
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        error: externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_PARSE_INVALID',
          'External capability arguments FileArtifact must contain one JSON object.',
        ),
      };
    }
    return {
      arguments: parsed as Record<string, unknown>,
    };
  } catch {
    return {
      error: externalCapabilityArgumentsArtifactError(
        'CAPABILITY_ARGUMENTS_ARTIFACT_READ_FAILED',
        'Unable to read the external capability arguments FileArtifact.',
        true,
      ),
    };
  }
}

async function expandExternalCapabilityArtifactIncludes(input: {
  context: TaskContext;
  appId: string;
  agentId: ReturnType<typeof agentIdForMcpTask>;
  jobId: string;
  value: Record<string, unknown>;
}): Promise<
  | { arguments: Record<string, unknown>; error?: undefined }
  | {
      arguments?: undefined;
      error: ReturnType<typeof externalCapabilityArgumentsArtifactError>;
    }
> {
  const store = input.context.deps.getFileArtifactStore?.();
  let includeCount = 0;
  let expandedBytes = Buffer.byteLength(JSON.stringify(input.value), 'utf8');

  const expand = async (
    value: unknown,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<unknown> => {
    if (depth > MAX_EXTERNAL_CAPABILITY_ARTIFACT_DEPTH) {
      throw externalCapabilityArgumentsArtifactError(
        'CAPABILITY_ARGUMENTS_ARTIFACT_DEPTH_EXCEEDED',
        `Nested ${JSON_ARTIFACT_INCLUDE_KEY} directives exceed the maximum depth of ${MAX_EXTERNAL_CAPABILITY_ARTIFACT_DEPTH}.`,
      );
    }
    if (isJsonArtifactInclude(value)) {
      if (!store) {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_UNAVAILABLE',
          'FileArtifact storage is unavailable.',
          true,
        );
      }
      includeCount += 1;
      if (includeCount > MAX_EXTERNAL_CAPABILITY_ARTIFACT_INCLUDES) {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_INCLUDE_LIMIT_EXCEEDED',
          `External capability arguments may include at most ${MAX_EXTERNAL_CAPABILITY_ARTIFACT_INCLUDES} JSON artifacts.`,
        );
      }
      const artifactId = value[JSON_ARTIFACT_INCLUDE_KEY];
      if (!/^file-artifact:[0-9a-f-]{36}$/iu.test(artifactId)) {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_INVALID',
          `${JSON_ARTIFACT_INCLUDE_KEY} must contain a FileArtifact identifier.`,
        );
      }
      if (ancestors.has(artifactId)) {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_CYCLE',
          `Nested ${JSON_ARTIFACT_INCLUDE_KEY} directives must not form a cycle.`,
        );
      }
      const { artifact, content } = await store.readFileArtifact({
        id: artifactId as FileArtifactId,
        appId: input.appId,
        agentId: input.agentId,
      });
      if (artifact.virtualScope !== jobArtifactScope(input.jobId)) {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_SCOPE_INVALID',
          `${JSON_ARTIFACT_INCLUDE_KEY} must reference an artifact owned by the authenticated scheduled job.`,
        );
      }
      const text =
        typeof content === 'string'
          ? content
          : Buffer.from(content).toString('utf8');
      expandedBytes += Buffer.byteLength(text, 'utf8');
      if (expandedBytes > MAX_EXTERNAL_CAPABILITY_ARGUMENT_BYTES) {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_ARTIFACT_TOO_LARGE',
          'Expanded external capability arguments exceed 10 MiB.',
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_PARSE_INVALID',
          `${JSON_ARTIFACT_INCLUDE_KEY} must reference an artifact containing valid JSON.`,
        );
      }
      return expand(
        parsed,
        depth + 1,
        new Set([...ancestors, artifactId]),
      );
    }
    if (Array.isArray(value)) {
      const expanded: unknown[] = [];
      for (const item of value) expanded.push(await expand(item, depth, ancestors));
      return expanded;
    }
    if (value && typeof value === 'object') {
      const expanded: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        expanded[key] = await expand(item, depth, ancestors);
      }
      return expanded;
    }
    return value;
  };

  try {
    const expanded = await expand(input.value, 0, new Set());
    if (!expanded || typeof expanded !== 'object' || Array.isArray(expanded)) {
      return {
        error: externalCapabilityArgumentsArtifactError(
          'CAPABILITY_ARGUMENTS_PARSE_INVALID',
          'Expanded external capability arguments must contain one JSON object.',
        ),
      };
    }
    return { arguments: expanded as Record<string, unknown> };
  } catch (error) {
    if (isExternalCapabilityArgumentsArtifactError(error)) {
      return { error };
    }
    return {
      error: externalCapabilityArgumentsArtifactError(
        'CAPABILITY_ARGUMENTS_ARTIFACT_READ_FAILED',
        'Unable to expand an external capability arguments FileArtifact.',
        true,
      ),
    };
  }
}

function isJsonArtifactInclude(
  value: unknown,
): value is Record<typeof JSON_ARTIFACT_INCLUDE_KEY, string> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)[JSON_ARTIFACT_INCLUDE_KEY] ===
        'string',
  );
}

function isExternalCapabilityArgumentsArtifactError(
  value: unknown,
): value is ReturnType<typeof externalCapabilityArgumentsArtifactError> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).status === 'rejected' &&
      typeof (value as Record<string, unknown>).code === 'string',
  );
}

function externalCapabilityArgumentsArtifactError(
  code: string,
  message: string,
  retrySamePayload = false,
) {
  return {
    status: 'rejected' as const,
    code,
    message,
    repairable: true,
    retryable: retrySamePayload,
    retrySamePayload,
    diagnostics: [
      { instancePath: '$' as const, keyword: 'artifact' as const, message },
    ],
  };
}

function mcpSearchToolsHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
    if (!data.appId) {
      reject('MCP tool search requires signed app scope.', 'forbidden');
      return;
    }
    const requestedTargetJid = validateSameChannelMcpTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'MCP tool search',
      reject,
    });
    if (!requestedTargetJid) return;
    const routeScope = resolveMcpRouteScope(
      context,
      requestedTargetJid,
      'MCP tool search',
      reject,
    );
    if (!routeScope) return;
    try {
      const searchInput = mcpListToolsProxyInput(data.payload || {});
      if (!searchInput.query) {
        reject('Missing required field: query.', 'invalid_request');
        return;
      }
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      const result = await proxy.searchTools({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        query: searchInput.query,
        limit: searchInput.limit,
      });
      acceptData('Connected MCP tools searched for this agent.', result);
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool search failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function mcpListToolsHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
    if (!data.appId) {
      reject('MCP tool listing requires signed app scope.', 'forbidden');
      return;
    }
    const requestedTargetJid = validateSameChannelMcpTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'MCP tool list',
      reject,
    });
    if (!requestedTargetJid) return;
    const routeScope = resolveMcpRouteScope(
      context,
      requestedTargetJid,
      'MCP tool listing',
      reject,
    );
    if (!routeScope) return;
    try {
      const listInput = mcpListToolsProxyInput(data.payload || {});
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      const result = await proxy.listTools({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        ...listInput,
      });
      acceptData('Connected MCP tools listed for this agent.', result);
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool listing failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function mcpDescribeToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
    if (!data.appId) {
      reject('MCP tool detail requires signed app scope.', 'forbidden');
      return;
    }
    const requestedTargetJid = validateSameChannelMcpTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'MCP tool detail',
      reject,
    });
    if (!requestedTargetJid) return;
    const routeScope = resolveMcpRouteScope(
      context,
      requestedTargetJid,
      'MCP tool description',
      reject,
    );
    if (!routeScope) return;
    try {
      const detailInput = mcpDescribeToolProxyInput(data.payload || {});
      if (!detailInput.serverName || !detailInput.toolName) {
        reject(
          'Missing required fields: serverName and toolName.',
          'invalid_request',
        );
        return;
      }
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      const result = await proxy.describeTool({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        serverName: detailInput.serverName,
        toolName: detailInput.toolName,
      });
      acceptData(
        `MCP tool ${detailInput.serverName}.${detailInput.toolName} described.`,
        result,
      );
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool detail failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function mcpCallToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
    if (!data.appId) {
      reject('MCP tool calls require signed app scope.', 'forbidden');
      return;
    }
    const requestedTargetJid = validateSameChannelMcpTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'MCP tool call',
      reject,
    });
    if (!requestedTargetJid) return;
    const routeScope = resolveMcpRouteScope(
      context,
      requestedTargetJid,
      'MCP tool call',
      reject,
    );
    if (!routeScope) return;
    try {
      const callInput = mcpCallToolProxyInput(data.payload || {});
      if (
        !callInput.serverName ||
        !callInput.toolName ||
        callInput.invalidArguments
      ) {
        const reason = callInput.invalidArguments
          ? 'mcp_call_tool arguments must be a JSON object when provided.'
          : 'Missing required fields: serverName and toolName.';
        await auditInvalidMcpCallRequest({
          data,
          deps,
          sourceAgentFolder,
          callInput,
          reason,
        });
        reject(reason, 'invalid_request');
        return;
      }
      const { serverName, toolName } = callInput;
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      const activeLease = await isActiveRunLeaseForInteraction({
        runId: data.runId,
        runLeaseToken: data.runLeaseToken,
        runLeaseFencingVersion: data.runLeaseFencingVersion,
      });
      if (!activeLease) {
        reject(
          'MCP tool call rejected because the run lease is no longer active.',
          'stale_run_lease',
        );
        return;
      }
      const result = await proxy.callTool({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        serverName,
        toolName,
        arguments: callInput.arguments ?? {},
      });
      acceptData(
        `MCP tool ${serverName}.${toolName} completed.`,
        preserveRemoteMcpError(result),
      );
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool call failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function preserveRemoteMcpError(result: unknown): unknown {
  if (!isRemoteMcpErrorResult(result)) return result;
  return {
    ...result,
    error: remoteMcpError(result),
  };
}

function remoteMcpError(
  result: Record<string, unknown>,
): McpCompatibleToolError {
  const error = result.error;
  if (
    error &&
    typeof error === 'object' &&
    !Array.isArray(error) &&
    ['transient', 'validation', 'business', 'permission'].includes(
      String((error as Record<string, unknown>).category),
    ) &&
    typeof (error as Record<string, unknown>).isRetryable === 'boolean' &&
    typeof (error as Record<string, unknown>).message === 'string'
  ) {
    return error as McpCompatibleToolError;
  }
  return {
    category: 'business',
    isRetryable: false,
    message: remoteMcpErrorMessage(result),
  };
}

function isRemoteMcpErrorResult(
  result: unknown,
): result is Record<string, unknown> {
  return (
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).isError === true
  );
}

function remoteMcpErrorMessage(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(
    (item): item is { type: 'text'; text: string } =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === 'text' &&
      typeof (item as Record<string, unknown>).text === 'string',
  )?.text;
  return text?.trim().slice(0, 2_000) || 'Remote MCP tool returned an error.';
}

function asyncMcpCallToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
    if (!data.appId) {
      reject('Async MCP tool calls require signed app scope.', 'forbidden');
      return;
    }
    const requestedTargetJid = validateSameChannelMcpTarget({
      data,
      sourceAgentFolderJids,
      requestKind: 'Async MCP tool call',
      reject,
    });
    if (!requestedTargetJid) return;
    const routeScope = resolveMcpRouteScope(
      context,
      requestedTargetJid,
      'Async MCP tool call',
      reject,
    );
    if (!routeScope) return;
    try {
      const callInput = mcpCallToolProxyInput(data.payload || {});
      if (
        !callInput.serverName ||
        !callInput.toolName ||
        callInput.invalidArguments
      ) {
        const reason = callInput.invalidArguments
          ? 'async_mcp_call arguments must be a JSON object when provided.'
          : 'Missing required fields: serverName and toolName.';
        await auditInvalidMcpCallRequest({
          data,
          deps,
          sourceAgentFolder,
          callInput,
          reason,
        });
        reject(reason, 'invalid_request');
        return;
      }
      const repository = deps.getAsyncTaskRepository?.();
      if (!repository || deps.runnerSandboxProvider?.enforcing !== true) {
        reject('Async task runtime is unavailable.', 'unavailable');
        return;
      }
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const sandboxPolicy = readAsyncCommandSandboxPolicy({
        sourceAgentFolder,
        runHandle: data.runHandle,
      });
      if (
        !sandboxPolicy ||
        sandboxPolicy.appId !== data.appId ||
        (sandboxPolicy.agentId && sandboxPolicy.agentId !== agentId) ||
        sandboxPolicy.conversationId !== requestedTargetJid ||
        (sandboxPolicy.providerAccountId &&
          sandboxPolicy.providerAccountId !== data.providerAccountId) ||
        (sandboxPolicy.threadId ?? null) !==
          (data.authThreadId || data.threadId || null) ||
        (sandboxPolicy.runId && sandboxPolicy.runId !== data.runId) ||
        (sandboxPolicy.jobId && sandboxPolicy.jobId !== data.jobId)
      ) {
        reject(
          'async_mcp_call must target a run where async task tools are mounted.',
          'forbidden',
        );
        return;
      }
      const parentTask = await validateAsyncMcpParentTask({
        repository,
        data,
        appId: data.appId,
        agentId,
        conversationId: requestedTargetJid,
        providerAccountId: sandboxPolicy.providerAccountId ?? null,
        threadId: data.authThreadId || data.threadId || null,
      });
      if (!parentTask.ok) {
        reject(parentTask.message, 'invalid_request');
        return;
      }
      const activeLease = await isActiveRunLeaseForInteraction({
        runId: data.runId,
        runLeaseToken: data.runLeaseToken,
        runLeaseFencingVersion: data.runLeaseFencingVersion,
      });
      if (!activeLease) {
        reject(
          'Async MCP tool call rejected because the run lease is no longer active.',
          'stale_run_lease',
        );
        return;
      }
      const { serverName, toolName } = callInput;
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      await proxy.assertToolAllowed({
        appId: data.appId as never,
        agentId,
        ...routeScope,
        serverName,
        toolName,
        arguments: callInput.arguments ?? {},
      });
      const taskResult = await createAsyncMcpTask({
        repository,
        appId: data.appId,
        agentId,
        conversationId: requestedTargetJid,
        providerAccountId: sandboxPolicy.providerAccountId ?? null,
        threadId: data.authThreadId || data.threadId || null,
        parentTaskId: parentTask.parentTaskId,
        jobId: data.jobId,
        runId: data.runId,
        serverName,
        toolName,
        arguments: callInput.arguments ?? {},
        authorizationConversationId: routeScope.conversationId,
        authorizationThreadId: routeScope.threadId,
      });
      if (!taskResult.ok) {
        reject(taskResult.message, 'capacity_full');
        return;
      }
      await enqueueAsyncMcpTask({
        repository,
        task: taskResult.task,
        proxy,
        appId: data.appId,
        agentId,
        serverName,
        toolName,
        arguments: callInput.arguments ?? {},
        authorizationConversationId: routeScope.conversationId,
        authorizationThreadId: routeScope.threadId,
      });
      acceptData(`Queued: ${serverName}.${toolName}`, {
        task: toPublicAsyncTaskDto(taskResult.task),
      });
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'Async MCP tool call failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

async function validateAsyncMcpParentTask(input: {
  repository: AsyncTaskRepository;
  data: Parameters<TaskHandler>[0]['data'];
  appId: string;
  agentId: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
}): Promise<
  { ok: true; parentTaskId: string | null } | { ok: false; message: string }
> {
  const parentTaskId = toTrimmedString(input.data.parentTaskId, {
    maxLen: 120,
  });
  if (!parentTaskId) return { ok: true, parentTaskId: null };
  const parent = await input.repository.getTask(parentTaskId);
  const valid =
    parent &&
    parent.kind === 'delegated_agent' &&
    parent.appId === input.appId &&
    delegatedTaskAgentInScope(parent, input.agentId) &&
    parent.conversationId === input.conversationId &&
    (parent.privateCorrelationJson.providerAccountId ?? null) ===
      (input.providerAccountId ?? null) &&
    (parent.threadId ?? null) === (input.threadId ?? null) &&
    !isAsyncTaskTerminal(parent.status);
  return valid
    ? { ok: true, parentTaskId }
    : { ok: false, message: 'async_mcp_call parent task is not active.' };
}

async function auditInvalidMcpCallRequest(input: {
  data: Parameters<TaskHandler>[0]['data'];
  deps: Parameters<TaskHandler>[0]['deps'];
  sourceAgentFolder: string;
  callInput: ReturnType<typeof mcpCallToolProxyInput>;
  reason: string;
}): Promise<void> {
  const mcpServers = input.deps.getMcpServerRepository?.();
  if (!mcpServers) {
    throw new Error('MCP tool call audit repository unavailable.');
  }
  await publishInvalidMcpToolRequestAudit({
    mcpServers,
    publishRuntimeEvent: input.deps.publishRuntimeEvent,
    appId: input.data.appId as never,
    agentId: agentIdForMcpTask(input.data, input.sourceAgentFolder),
    ...(input.data.runId ? { runId: input.data.runId } : {}),
    ...(input.data.runHandle ? { runHandle: input.data.runHandle } : {}),
    ...(input.callInput.serverName
      ? { serverName: input.callInput.serverName }
      : {}),
    ...(input.callInput.toolName ? { toolName: input.callInput.toolName } : {}),
    argumentPayload: input.callInput.argumentPayload,
    reason: input.reason,
    missingFields: input.callInput.missingFields,
  });
}

function agentIdForMcpTask(
  data: Parameters<TaskHandler>[0]['data'],
  sourceAgentFolder: string,
) {
  return (data.agentId ||
    memoryAgentIdForWorkspaceFolder(sourceAgentFolder)) as never;
}

function validateSameChannelMcpTarget(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceAgentFolderJids: string[];
  requestKind: string;
  reject: (error: string, code?: string, details?: string[]) => void;
}): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    input.data.targetJid || input.data.jid,
    { maxLen: 512 },
  );
  if (targetOverride && targetOverride !== requestedTargetJid) {
    input.reject(
      `${input.requestKind} requests must use the originating chat as the approval target.`,
      'forbidden',
    );
    return null;
  }
  if (
    !requestedTargetJid ||
    (!input.sourceAgentFolderJids.includes(requestedTargetJid) &&
      !isAuthenticatedScheduledAppConversation(input.data, requestedTargetJid))
  ) {
    input.reject(
      `${input.requestKind} requests must include the originating chat for this agent.`,
      'forbidden',
    );
    return null;
  }
  return requestedTargetJid;
}
function isAuthenticatedScheduledAppConversation(
  data: Parameters<TaskHandler>[0]['data'],
  conversationJid: string,
): boolean {
  return (
    data.sourceRunKind === 'scheduled' &&
    Boolean(data.appId) &&
    appIdFromConversationJid(conversationJid) === data.appId
  );
}
function resolveMcpRouteScope(
  context: TaskContext,
  targetJid: string,
  requestKind: string,
  reject: (error: string, code?: string, details?: string[]) => void,
): { conversationId?: string; threadId?: string } | null {
  const threadId =
    context.data.authThreadId || context.data.threadId || undefined;
  if (isAuthenticatedScheduledAppConversation(context.data, targetJid)) {
    return { threadId };
  }
  if (
    Object.keys(context.conversationBindings).length === 0 &&
    !context.data.providerAccountId
  ) {
    return { threadId };
  }
  try {
    const route = resolveRunnerIpcRoute({
      routes: context.conversationBindings,
      sourceAgentFolder: context.sourceAgentFolder,
      targetJid,
      threadId,
      providerAccountId: context.data.providerAccountId,
    });
    return {
      ...(route.conversationId ? { conversationId: route.conversationId } : {}),
      ...(threadId ? { threadId } : {}),
    };
  } catch {
    reject(
      `${requestKind} must use the authenticated conversation route.`,
      'forbidden',
    );
    return null;
  }
}
