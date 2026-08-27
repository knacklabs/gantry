import path from 'path';

import { publishInvalidMcpToolRequestAudit } from '../application/mcp/mcp-tool-audit.js';
import { appIdFromConversationJid } from '../shared/app-conversation-jid.js';
import type { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import {
  isAsyncTaskTerminal,
  toPublicAsyncTaskDto,
  type AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import type {
  JobCheckpointArtifactReference,
  JobSemanticCheckpoint,
} from '../domain/ports/job-semantic-checkpoints.js';
import { jobArtifactScope } from '../domain/ports/job-semantic-checkpoints.js';
import type { FileArtifactId } from '../domain/file-artifacts/file-artifact.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
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
import { bindWebsiteRecipeHumanIdentity } from './website-recipe-identity-binding.js';
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
      reject(artifactArguments.error, 'invalid_request');
      return;
    }
    let resolvedArguments = artifactArguments.arguments ?? input.arguments;
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
    if (isWebsiteRecipeEvaluationSubmit(capabilityId, input.toolName)) {
      const job = deps.opsRepository
        ? await deps.opsRepository.getJobById(jobId)
        : null;
      resolvedArguments = bindWebsiteRecipeHumanIdentity(
        resolvedArguments,
        job?.prompt,
      );
    }
    if (Object.hasOwn(resolvedArguments, '_gantryCapabilityTask')) {
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
    const proxy = await createMcpProxyForSourceGroup({
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
    const args = resolvedArguments;
    await proxy.assertToolAllowed({
      appId: data.appId as never,
      agentId,
      ...routeScope,
      serverName: input.serverName,
      toolName: input.toolName,
      arguments: args,
    });
    if (isWebsiteRecipeCompile(capabilityId, input.toolName)) {
      try {
        const result = await proxy.callTool({
          appId: data.appId as never,
          agentId,
          ...routeScope,
          serverName: input.serverName,
          toolName: input.toolName,
          arguments: args,
          authorizationArguments: args,
        });
        const compilation = websiteRecipeCompilationFromMcpResult(result);
        acceptData('External capability completed synchronously.', {
          status: 'completed',
          ...compilation,
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
    if (
      capabilityId === 'manipal.website-recipe-evaluator@1' &&
      !isWebsiteRecipeEvaluationSubmit(capabilityId, input.toolName)
    ) {
      reject(
        'Unsupported website recipe evaluator operation.',
        'invalid_request',
      );
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
    const checkpointRepository = deps.getJobSemanticCheckpointRepository?.();
    let submissionCheckpoint: JobSemanticCheckpoint | null = null;
    if (isWebsiteRecipeEvaluationSubmit(capabilityId, input.toolName)) {
      if (!checkpointRepository) {
        reject('Durable job checkpoints are unavailable.', 'unavailable');
        return;
      }
      submissionCheckpoint = await checkpointRepository.getLatestCheckpoint({
        appId: data.appId,
        agentId,
        jobId,
      });
      if (
        !submissionCheckpoint ||
        !isEvaluationSubmissionReady(submissionCheckpoint, invocationRef)
      ) {
        reject(
          'Save the compiler-backed test plan checkpoint before evaluator submission.',
          'checkpoint_required',
        );
        return;
      }
      const previousCheckpoint =
        submissionCheckpoint.sequence > 1
          ? await checkpointRepository.getCheckpoint({
              appId: data.appId,
              agentId,
              jobId,
              sequence: submissionCheckpoint.sequence - 1,
            })
          : null;
      if (
        isUnchangedSameRunEvaluationSubmission(
          submissionCheckpoint,
          previousCheckpoint,
        )
      ) {
        reject(
          'UNCHANGED_FAILED_EVALUATION: this run already analyzed the same evaluation-submit content. Make a material candidate or test-plan repair, or save needs_review_proof_incomplete; a new checkpoint or idempotency key alone is not a repair.',
          'invalid_request',
        );
        return;
      }
      const evidenceBinding = evaluationObservationEvidenceBinding(
        resolvedArguments,
        submissionCheckpoint,
      );
      if (!evidenceBinding.valid) {
        reject(evidenceBinding.message, evidenceBinding.code);
        return;
      }
    }
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
        await proxy.callTool({
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
        });
      }
    } catch (error) {
      if (acceptance.completionToken) {
        await service.cancel({
          appId: data.appId,
          taskId: acceptance.taskId,
          completionToken: acceptance.completionToken,
          cancellationId: `submit-failed:${data.taskId ?? acceptance.taskId}`,
          reason:
            error instanceof Error
              ? error.message
              : 'External capability submission failed.',
        });
      }
      reject(
        error instanceof Error
          ? error.message
          : 'External capability submission failed.',
        'mcp_proxy_failed',
      );
      return;
    }
    if (
      checkpointRepository &&
      submissionCheckpoint &&
      isPreparedEvaluationSubmissionCheckpoint(submissionCheckpoint)
    ) {
      const checkpointResult = await checkpointRepository.appendCheckpoint({
        id: `job-checkpoint-${stableSha256Json({ jobId, invocationRef }).slice(0, 48)}`,
        appId: data.appId,
        agentId,
        jobId,
        runId,
        leaseToken: data.runLeaseToken ?? '',
        expectedPreviousSequence: submissionCheckpoint.sequence,
        milestone: 'evaluation_submitted',
        payload: {
          safePhase: 'evaluation_submitted',
          artifactRefs: replaceEvaluationArgumentsArtifact(
            submissionCheckpoint.payload.artifactRefs,
            artifactArguments.artifactRef,
          ),
          evaluatorInvocationRef: invocationRef,
          pendingInteractionRef: null,
          nextAction: 'Await the complete evaluator result.',
          cumulativeRuntimeMs: submissionCheckpoint.payload.cumulativeRuntimeMs,
        },
      });
      if (
        checkpointResult.outcome !== 'persisted' &&
        checkpointResult.outcome !== 'replayed'
      ) {
        if (acceptance.completionToken) {
          await service.cancel({
            appId: data.appId,
            taskId: acceptance.taskId,
            completionToken: acceptance.completionToken,
            cancellationId: `checkpoint-failed:${data.taskId ?? acceptance.taskId}`,
            reason: 'Evaluator submission checkpoint was fenced.',
          });
        }
        reject(
          'Evaluator submission was accepted, but its semantic checkpoint was fenced.',
          'checkpoint_conflict',
        );
        return;
      }
      await deps.publishRuntimeEvent?.({
        appId: data.appId as never,
        agentId,
        runId: runId as never,
        jobId: jobId as never,
        eventType: RUNTIME_EVENT_TYPES.TASK_UPDATED,
        actor: 'gantry-runtime',
        payload: {
          type: 'job_checkpoint_saved',
          checkpoint: checkpointResult.checkpoint,
        },
      });
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

export function isUnchangedSameRunEvaluationSubmission(
  submission: JobSemanticCheckpoint,
  previous: JobSemanticCheckpoint | null,
): boolean {
  if (
    previous?.milestone !== 'evaluation_analyzed' ||
    previous.runId !== submission.runId
  ) {
    return false;
  }
  const contentHashFor = (checkpoint: JobSemanticCheckpoint, kind: string) =>
    checkpoint.payload.artifactRefs.find((reference) => reference.kind === kind)
      ?.contentHash;
  const current = contentHashFor(submission, 'evaluation_submit_args');
  const analyzed = contentHashFor(previous, 'evaluation_submit_args');
  return Boolean(current && analyzed && current === analyzed);
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
      artifactRef?: JobCheckpointArtifactReference;
      error?: undefined;
    }
  | { arguments?: undefined; artifactRef?: undefined; error: string }
> {
  const rawArtifactId = toTrimmedString(input.payload.argumentsArtifactId, {
    maxLen: 80,
  });
  if (!rawArtifactId) return {};
  if (input.directArguments) {
    return {
      error:
        'arguments and argumentsArtifactId are mutually exclusive; submit exactly one.',
    };
  }
  if (!/^file-artifact:[0-9a-f-]{36}$/iu.test(rawArtifactId)) {
    return { error: 'argumentsArtifactId must be a FileArtifact identifier.' };
  }
  const store = input.context.deps.getFileArtifactStore?.();
  if (!store) return { error: 'FileArtifact storage is unavailable.' };
  try {
    const { artifact, content } = await store.readFileArtifact({
      id: rawArtifactId as FileArtifactId,
      appId: input.appId,
      agentId: input.agentId,
    });
    if (artifact.virtualScope !== jobArtifactScope(input.jobId)) {
      return {
        error:
          'argumentsArtifactId must belong to the authenticated scheduled job.',
      };
    }
    if (artifact.sizeBytes > 10 * 1024 * 1024) {
      return { error: 'External capability arguments exceed 10 MiB.' };
    }
    const text =
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        error:
          'External capability arguments FileArtifact must contain one JSON object.',
      };
    }
    return {
      arguments: parsed as Record<string, unknown>,
      artifactRef: {
        artifactId: artifact.id,
        contentHash: artifact.contentHash,
        kind: 'evaluation_submit_args',
      },
    };
  } catch {
    return {
      error:
        'Unable to read or parse the external capability arguments FileArtifact.',
    };
  }
}

function replaceEvaluationArgumentsArtifact(
  artifactRefs: readonly JobCheckpointArtifactReference[],
  submittedArtifact?: JobCheckpointArtifactReference,
): JobCheckpointArtifactReference[] {
  if (!submittedArtifact) return [...artifactRefs];
  return [
    ...artifactRefs.filter(
      (reference) => reference.kind !== 'evaluation_submit_args',
    ),
    submittedArtifact,
  ];
}

function isWebsiteRecipeEvaluationSubmit(
  capabilityId: string,
  operation: string,
): boolean {
  return (
    capabilityId === 'manipal.website-recipe-evaluator@1' &&
    (operation === 'evaluation.submit' || operation === 'evaluation_submit')
  );
}

function isWebsiteRecipeCompile(
  capabilityId: string,
  operation: string,
): boolean {
  return (
    capabilityId === 'manipal.website-recipe-evaluator@1' &&
    operation === 'recipe_compile'
  );
}

export function websiteRecipeCompilationFromMcpResult(
  result: unknown,
): Record<string, unknown> {
  const envelope = objectRecord(result);
  if (envelope?.isError === true) {
    throw new Error(mcpResultText(envelope) ?? 'Recipe compilation failed.');
  }
  const compilation =
    objectRecord(envelope?.structuredContent) ??
    parsedMcpResultText(envelope) ??
    envelope;
  if (
    compilation?.status !== 'compiled' ||
    !objectRecord(compilation.binding) ||
    typeof compilation.recipeSha256 !== 'string' ||
    typeof compilation.observationInventorySha256 !== 'string' ||
    typeof compilation.coverageManifestSha256 !== 'string' ||
    !objectRecord(compilation.coverageManifest)
  ) {
    throw new Error('Recipe compiler returned no canonical compiled payload.');
  }
  return compilation;
}

function parsedMcpResultText(
  envelope: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const text = mcpResultText(envelope);
  if (!text) return null;
  try {
    return objectRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function mcpResultText(
  envelope: Record<string, unknown> | null,
): string | null {
  const content = Array.isArray(envelope?.content) ? envelope.content : [];
  for (const entry of content) {
    const item = objectRecord(entry);
    if (item?.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isEvaluationSubmissionReady(
  checkpoint: JobSemanticCheckpoint | null,
  invocationRef: string,
): boolean {
  const artifactKinds = new Set(
    checkpoint?.payload.artifactRefs.map((reference) => reference.kind) ?? [],
  );
  const recoverableTransportFailure =
    checkpoint?.milestone === 'evaluation_analyzed' &&
    checkpoint.payload.evaluatorInvocationRef === null &&
    [
      'recipe_candidate',
      'observation_inventory',
      'test_plan',
      'evaluation_submit_args',
    ].every((kind) => artifactKinds.has(kind));
  const preparedSubmission = checkpoint
    ? isPreparedEvaluationSubmissionCheckpoint(checkpoint)
    : false;

  return (
    checkpoint?.milestone === 'test_plan_created' ||
    preparedSubmission ||
    (checkpoint?.milestone === 'evaluation_submitted' &&
      checkpoint.payload.evaluatorInvocationRef === invocationRef) ||
    recoverableTransportFailure
  );
}

function isPreparedEvaluationSubmissionCheckpoint(
  checkpoint: JobSemanticCheckpoint,
): boolean {
  if (checkpoint.milestone === 'test_plan_created') return true;
  const artifactKinds = new Set(
    checkpoint.payload.artifactRefs.map((reference) => reference.kind),
  );
  // `evaluation_submitted` + `evaluation_ready` is accepted only as a
  // compatibility bridge for checkpoints written before the runtime-owned
  // submission gate was introduced. New model-authored checkpoints must use
  // test_plan_created; the checkpoint handler rejects direct
  // evaluation_submitted saves.
  const readyMilestone =
    checkpoint.milestone === 'candidate_created' ||
    checkpoint.milestone === 'evaluation_submitted';
  return (
    readyMilestone &&
    checkpoint.payload.safePhase === 'evaluation_ready' &&
    checkpoint.payload.evaluatorInvocationRef === null &&
    [
      'recipe_candidate',
      'observation_inventory',
      'test_plan',
      'evaluation_submit_args',
    ].every((kind) => artifactKinds.has(kind))
  );
}

function evaluationObservationEvidenceBinding(
  args: Record<string, unknown>,
  checkpoint: JobSemanticCheckpoint,
):
  | { valid: true }
  | {
      valid: false;
      message: string;
      code: 'invalid_request' | 'checkpoint_required';
    } {
  const units = Array.isArray(args.units) ? args.units : [args];
  if (units.length === 0) {
    return {
      valid: false,
      message: 'Recipe evaluation requires at least one observation inventory.',
      code: 'invalid_request',
    };
  }

  for (const unit of units) {
    if (!isRecord(unit) || !isRecord(unit.observationInventory)) {
      return {
        valid: false,
        message:
          'Every recipe evaluation unit requires its observation inventory.',
        code: 'invalid_request',
      };
    }
    const claims = unit.observationInventory.claims;
    if (!Array.isArray(claims)) {
      return {
        valid: false,
        message: 'Every observation inventory requires claims.',
        code: 'invalid_request',
      };
    }
    for (const claim of claims) {
      if (!isRecord(claim) || !Array.isArray(claim.evidenceRefs)) {
        return {
          valid: false,
          message: 'Every observation claim requires evidenceRefs.',
          code: 'invalid_request',
        };
      }
      for (const evidenceRef of claim.evidenceRefs) {
        if (
          typeof evidenceRef !== 'string' ||
          evidenceRef.trim().length === 0
        ) {
          return {
            valid: false,
            message:
              'Observation evidence references must be non-empty strings.',
            code: 'invalid_request',
          };
        }
      }
    }
  }

  const checkpointedArtifactKinds = new Set(
    checkpoint.payload.artifactRefs.map((reference) => reference.kind),
  );
  const missingKinds = [
    'observation_inventory',
    'recipe_candidate',
    'test_plan',
  ].filter((kind) => !checkpointedArtifactKinds.has(kind));
  if (missingKinds.length > 0) {
    return {
      valid: false,
      message:
        'Save the observation inventory, recipe candidate, and test plan artifacts before evaluator submission.',
      code: 'checkpoint_required',
    };
  }
  return { valid: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
