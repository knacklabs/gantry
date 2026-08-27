import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import type {
  AsyncTaskBacklogAdmissionInput,
  AsyncTaskClaimInput,
  AsyncTaskCreateInput,
  AsyncTaskListFilter,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskScopedAdmissionInput,
  AsyncTaskScopedAdmissionResult,
  AsyncTaskStatusCount,
  AsyncTaskTransitionInput,
} from '@core/domain/ports/async-tasks.js';
import { isAsyncTaskTerminal } from '@core/domain/ports/async-tasks.js';
import type {
  JobSemanticCheckpoint,
  JobSemanticCheckpointRepository,
} from '@core/domain/ports/job-semantic-checkpoints.js';
import { jobArtifactScope } from '@core/domain/ports/job-semantic-checkpoints.js';
import type { FileArtifactStore } from '@core/domain/ports/file-artifact-store.js';
import { AsyncCommandTaskService } from '@core/jobs/async-command-task-service.js';
import { createAsyncMcpTask } from '@core/jobs/async-mcp-tool-task.js';
import { readEncryptedAsyncTaskPayload } from '@core/jobs/async-task-execution-payload.js';
import {
  createMcpToolHandlers,
  isEvaluationSubmissionReady,
  isUnchangedSameRunEvaluationSubmission,
  websiteRecipeCompilationFromMcpResult,
} from '@core/jobs/ipc-mcp-tool-handlers.js';
import { registerExternalCapabilitySuspension } from '@core/jobs/external-capability-suspension.js';
import { registerAsyncCommandSandboxPolicy } from '@core/runtime/async-command-sandbox-policy.js';

const runtimeHomes: string[] = [];
const evaluationArguments = {
  candidateHash: 'candidate-hash',
  observationInventory: {
    claims: [{ evidenceRefs: ['artifact-browser-evidence'] }],
  },
};

describe('same-run recipe evaluation repair gate', () => {
  const checkpoint = (
    milestone: JobSemanticCheckpoint['milestone'],
    runId: string,
    contentHash: string,
  ) =>
    ({
      runId,
      milestone,
      payload: {
        artifactRefs: [
          {
            artifactId: 'file-artifact:00000000-0000-4000-8000-000000000001',
            contentHash,
            kind: 'evaluation_submit_args',
          },
        ],
      },
    }) as JobSemanticCheckpoint;

  it('rejects a new checkpoint that repeats analyzed content in the same run', () => {
    expect(
      isUnchangedSameRunEvaluationSubmission(
        checkpoint('test_plan_created', 'run-1', 'sha256:same'),
        checkpoint('evaluation_analyzed', 'run-1', 'sha256:same'),
      ),
    ).toBe(true);
  });

  it('allows a material change or an administrator-authorized later run', () => {
    expect(
      isUnchangedSameRunEvaluationSubmission(
        checkpoint('test_plan_created', 'run-1', 'sha256:changed'),
        checkpoint('evaluation_analyzed', 'run-1', 'sha256:old'),
      ),
    ).toBe(false);
    expect(
      isUnchangedSameRunEvaluationSubmission(
        checkpoint('test_plan_created', 'run-2', 'sha256:same'),
        checkpoint('evaluation_analyzed', 'run-1', 'sha256:same'),
      ),
    ).toBe(false);
  });
});

it('recovers evaluator submission only from a complete pre-execution failure', () => {
  const checkpoint = new MemoryJobCheckpointRepository().latest!;
  const analyzed = {
    ...checkpoint,
    milestone: 'evaluation_analyzed' as const,
    payload: {
      ...checkpoint.payload,
      artifactRefs: [
        ...checkpoint.payload.artifactRefs,
        {
          artifactId: 'artifact-evaluation-submit-args',
          contentHash: 'sha256:evaluation-submit-args',
          kind: 'evaluation_submit_args',
        },
      ],
    },
  };

  expect(isEvaluationSubmissionReady(analyzed, 'invocation:retry')).toBe(true);
  expect(
    isEvaluationSubmissionReady(
      {
        ...analyzed,
        payload: {
          ...analyzed.payload,
          evaluatorInvocationRef: 'invocation:already-ran',
        },
      },
      'invocation:retry',
    ),
  ).toBe(false);
  expect(
    isEvaluationSubmissionReady(
      {
        ...analyzed,
        payload: {
          ...analyzed.payload,
          artifactRefs: analyzed.payload.artifactRefs.filter(
            (reference) => reference.kind !== 'evaluation_submit_args',
          ),
        },
      },
      'invocation:retry',
    ),
  ).toBe(false);
});

it('accepts an evaluation-ready checkpoint that retains every compiled artifact', () => {
  const checkpoint = new MemoryJobCheckpointRepository().latest!;
  const evaluationReady: JobSemanticCheckpoint = {
    ...checkpoint,
    milestone: 'candidate_created',
    payload: {
      ...checkpoint.payload,
      safePhase: 'evaluation_ready',
      evaluatorInvocationRef: null,
      artifactRefs: [
        ...checkpoint.payload.artifactRefs,
        {
          artifactId: 'artifact-evaluation-submit-args',
          contentHash: 'sha256:evaluation-submit-args',
          kind: 'evaluation_submit_args',
        },
      ],
    },
  };

  expect(
    isEvaluationSubmissionReady(evaluationReady, 'invocation:prepared'),
  ).toBe(true);
  expect(
    isEvaluationSubmissionReady(
      {
        ...evaluationReady,
        milestone: 'evaluation_submitted',
      },
      'invocation:legacy-prepared',
    ),
  ).toBe(true);
  expect(
    isEvaluationSubmissionReady(
      {
        ...evaluationReady,
        payload: {
          ...evaluationReady.payload,
          artifactRefs: evaluationReady.payload.artifactRefs.filter(
            (reference) => reference.kind !== 'test_plan',
          ),
        },
      },
      'invocation:prepared',
    ),
  ).toBe(false);
});

afterEach(() => {
  configurePendingInteractionDurability(null);
  vi.unstubAllEnvs();
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.stubEnv('SECRET_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
});

function asyncRuntimeDeps(
  repository: AsyncTaskRepository,
  checkpoints: JobSemanticCheckpointRepository = new MemoryJobCheckpointRepository(),
  fileArtifacts?: FileArtifactStore,
) {
  return {
    getAsyncTaskRepository: () => repository,
    getJobSemanticCheckpointRepository: () => checkpoints,
    ...(fileArtifacts ? { getFileArtifactStore: () => fileArtifacts } : {}),
    runnerSandboxProvider: { enforcing: true },
  } as never;
}

describe('external capability MCP task', () => {
  it('unwraps and validates canonical recipe compiler structured content', () => {
    const compilation = {
      status: 'compiled',
      binding: { bindingSha256: 'sha256:binding' },
      recipeSha256: 'sha256:recipe',
      observationInventorySha256: 'sha256:inventory',
      coverageManifestSha256: 'sha256:coverage',
      coverageManifest: { requirements: [] },
    };

    expect(
      websiteRecipeCompilationFromMcpResult({
        content: [{ type: 'text', text: JSON.stringify(compilation) }],
        structuredContent: compilation,
        isError: false,
      }),
    ).toEqual(compilation);
    expect(() =>
      websiteRecipeCompilationFromMcpResult({
        content: [{ type: 'text', text: 'compiler unavailable' }],
        isError: true,
      }),
    ).toThrow('compiler unavailable');
    expect(() =>
      websiteRecipeCompilationFromMcpResult({ content: [] }),
    ).toThrow('no canonical compiled payload');
    expect(() =>
      websiteRecipeCompilationFromMcpResult({
        structuredContent: {
          status: 'rejected',
          code: 'RECIPE_SCHEMA_INVALID',
          message: 'Unsupported field(s) at site: siteId',
        },
      }),
    ).toThrow(
      'RECIPE_SCHEMA_INVALID: Unsupported field(s) at site: siteId',
    );
  });

  it('executes recipe compilation synchronously without scheduling an external task', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const compileArguments = {
      recipe: {},
      binding: {},
      observationInventory: {},
    };
    const artifactId = 'file-artifact:22222222-2222-4222-8222-222222222222';
    const fileArtifacts = {
      readFileArtifact: vi.fn(async () => ({
        artifact: {
          id: artifactId,
          appId: 'app:test',
          agentId: 'agent:signed',
          virtualScope: jobArtifactScope('job-1'),
          virtualPath: 'compile/arguments.json',
          version: 1,
          storageType: 'local-filesystem',
          storageRef: 'test',
          contentHash: 'sha256:compile',
          sizeBytes: JSON.stringify(compileArguments).length,
          contentType: 'application/json',
          metadata: {},
          createdAt: '2026-08-26T00:00:00.000Z',
        },
        content: JSON.stringify(compileArguments),
      })),
    } as unknown as FileArtifactStore;
    const callTool = vi.fn(async () => ({
      structuredContent: {
        status: 'compiled',
        binding: { bindingSha256: 'sha256:binding' },
        recipeSha256: 'sha256:recipe',
        observationInventorySha256: 'sha256:inventory',
        coverageManifestSha256: 'sha256:coverage',
        coverageManifest: { requirements: [] },
      },
      isError: false,
    }));
    const assertToolAllowed = vi.fn(async () => undefined);
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        assertToolAllowed,
        callTool,
        describeTool: vi.fn(),
        listTools: vi.fn(),
      })) as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'manipal-website-recipe-evaluator',
          toolName: 'recipe_compile',
          capabilityId: 'manipal.website-recipe-evaluator@1',
          idempotencyKey: 'compile-must-be-direct',
          argumentsArtifactId: artifactId,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(
        repository,
        new MemoryJobCheckpointRepository(),
        fileArtifacts,
      ),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(assertToolAllowed).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'manipal-website-recipe-evaluator',
        toolName: 'recipe_compile',
        arguments: compileArguments,
        authorizationArguments: compileArguments,
      }),
    );
    expect(fileArtifacts.readFileArtifact).toHaveBeenCalledWith({
      id: artifactId,
      appId: 'app:test',
      agentId: 'agent:signed',
    });
    expect(repository.tasks.size).toBe(0);
  });

  it('accepts the signed app conversation for a scheduled job without a chat route', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        assertToolAllowed: vi.fn(async () => undefined),
        callTool,
        describeTool: vi.fn(),
        listTools: vi.fn(),
      })) as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        appId: 'manipal-tender-copilot',
        agentId: 'agent:signed',
        chatJid: 'app:manipal-tender-copilot:conversation-1',
        targetJid: 'app:manipal-tender-copilot:conversation-1',
        sourceRunKind: 'scheduled',
        providerAccountId: 'provider-account-1',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'manipal-evaluator',
          toolName: 'evaluation.submit',
          capabilityId: 'manipal.website-recipe-evaluator@1',
          idempotencyKey: 'evaluation-submit-app-conversation',
          arguments: evaluationArguments,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {
        unrelated_agent: {
          conversationId: 'unrelated-conversation',
          source: 'sl:unrelated',
        },
      } as never,
      sourceAgentFolderJids: [],
    });

    expect(callTool).toHaveBeenCalledOnce();
  });

  it('injects a host completion envelope and suspends the authenticated job run', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository();
    const abort = vi.fn();
    const unregister = registerExternalCapabilitySuspension({
      jobId: 'job-1',
      runId: 'run-1',
      abort,
    });
    const assertToolAllowed = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        assertToolAllowed,
        callTool,
        describeTool: vi.fn(),
        listTools: vi.fn(),
      })) as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'manipal-evaluator',
          toolName: 'evaluation.submit',
          capabilityId: 'manipal.website-recipe-evaluator@1',
          idempotencyKey: 'evaluation-submit-1',
          arguments: evaluationArguments,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository, checkpoints),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'external_capability',
    );
    expect(task).toMatchObject({
      status: 'waiting_external',
      parentJobId: 'job-1',
      parentRunId: 'run-1',
      idempotencyKey: 'evaluation-submit-1',
    });
    expect(assertToolAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: evaluationArguments,
      }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationArguments: evaluationArguments,
        arguments: expect.objectContaining({
          candidateHash: 'candidate-hash',
          _gantryCapabilityTask: {
            taskId: task?.id,
            completionToken: expect.any(String),
          },
        }),
      }),
    );
    expect(abort).toHaveBeenCalledWith(
      `Waiting for external capability task ${task?.id}.`,
    );
    expect(checkpoints.latest).toMatchObject({
      sequence: 2,
      milestone: 'evaluation_submitted',
      payload: {
        evaluatorInvocationRef: 'invocation:evaluation-submit-1',
      },
    });
    unregister();
  });

  it('loads large external capability arguments from an owned job artifact', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository();
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const artifactId = 'file-artifact:11111111-1111-4111-8111-111111111111';
    const fileArtifacts = {
      readFileArtifact: vi.fn(async () => ({
        artifact: {
          id: artifactId,
          appId: 'app:test',
          agentId: 'agent:signed',
          virtualScope: jobArtifactScope('job-1'),
          virtualPath: 'evaluation/submission.json',
          version: 1,
          storageType: 'local-filesystem',
          storageRef: 'test',
          contentHash: 'sha256:test',
          sizeBytes: JSON.stringify(evaluationArguments).length,
          contentType: 'application/json',
          metadata: {},
          createdAt: '2026-08-21T00:00:00.000Z',
        },
        content: JSON.stringify(evaluationArguments),
      })),
    } as unknown as FileArtifactStore;
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        assertToolAllowed: vi.fn(async () => undefined),
        callTool,
        describeTool: vi.fn(),
        listTools: vi.fn(),
      })) as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'manipal-evaluator',
          toolName: 'evaluation_submit',
          capabilityId: 'manipal.website-recipe-evaluator@1',
          idempotencyKey: 'evaluation-from-artifact',
          argumentsArtifactId: artifactId,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository, checkpoints, fileArtifacts),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(fileArtifacts.readFileArtifact).toHaveBeenCalledWith({
      id: artifactId,
      appId: 'app:test',
      agentId: 'agent:signed',
    });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationArguments: evaluationArguments,
        arguments: expect.objectContaining(evaluationArguments),
      }),
    );
    expect(
      checkpoints.latest?.payload.artifactRefs.filter(
        (reference) => reference.kind === 'evaluation_submit_args',
      ),
    ).toEqual([
      {
        artifactId,
        contentHash: 'sha256:test',
        kind: 'evaluation_submit_args',
      },
    ]);
  });

  it('rejects recipe evaluation before the compiler-backed test plan checkpoint', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository(null);
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        assertToolAllowed: vi.fn(async () => undefined),
        callTool,
        describeTool: vi.fn(),
        listTools: vi.fn(),
      })) as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'manipal-evaluator',
          toolName: 'evaluation_submit',
          capabilityId: 'manipal.website-recipe-evaluator@1',
          idempotencyKey: 'evaluation-without-test-plan',
          arguments: evaluationArguments,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository, checkpoints),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(0);
  });

  it('rejects recipe evaluation when the observation inventory artifact is absent from the checkpoint', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository({
      ...new MemoryJobCheckpointRepository().latest!,
      payload: {
        ...new MemoryJobCheckpointRepository().latest!.payload,
        artifactRefs:
          new MemoryJobCheckpointRepository().latest!.payload.artifactRefs.filter(
            (reference) => reference.kind !== 'observation_inventory',
          ),
      },
    });
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        assertToolAllowed: vi.fn(async () => undefined),
        callTool,
        describeTool: vi.fn(),
        listTools: vi.fn(),
      })) as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'manipal-evaluator',
          toolName: 'evaluation_submit',
          capabilityId: 'manipal.website-recipe-evaluator@1',
          idempotencyKey: 'evaluation-with-unretained-evidence',
          arguments: evaluationArguments,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository, checkpoints),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(0);
  });
});

class MemoryJobCheckpointRepository implements JobSemanticCheckpointRepository {
  constructor(
    public latest: JobSemanticCheckpoint | null = {
      id: 'checkpoint-test-plan',
      appId: 'app:test',
      agentId: 'agent:signed',
      jobId: 'job-1',
      runId: 'run-1',
      sequence: 1,
      workerInstanceId: 'worker-1',
      fencingVersion: 1,
      milestone: 'test_plan_created',
      payload: {
        safePhase: 'test_plan_created',
        artifactRefs: [
          {
            artifactId: 'artifact-observation-inventory',
            contentHash: 'sha256:observation-inventory',
            kind: 'observation_inventory',
          },
          {
            artifactId: 'artifact-recipe-candidate',
            contentHash: 'sha256:recipe-candidate',
            kind: 'recipe_candidate',
          },
          {
            artifactId: 'artifact-test-plan',
            contentHash: 'sha256:test-plan',
            kind: 'test_plan',
          },
          {
            artifactId: 'artifact-browser-evidence',
            contentHash: 'sha256:browser-evidence',
            kind: 'browser_evidence',
          },
        ],
        evaluatorInvocationRef: null,
        pendingInteractionRef: null,
        nextAction: 'Submit evaluation.',
        cumulativeRuntimeMs: 1,
      },
      payloadHash: 'sha256:test-plan',
      createdAt: '2026-08-16T00:00:00.000Z',
    },
  ) {}

  async appendCheckpoint(
    input: Parameters<JobSemanticCheckpointRepository['appendCheckpoint']>[0],
  ) {
    const checkpoint: JobSemanticCheckpoint = {
      id: input.id,
      appId: input.appId,
      agentId: input.agentId,
      jobId: input.jobId,
      runId: input.runId,
      sequence: (this.latest?.sequence ?? 0) + 1,
      workerInstanceId: 'worker-1',
      fencingVersion: 1,
      milestone: input.milestone,
      payload: input.payload,
      payloadHash: 'sha256:submitted',
      createdAt: '2026-08-16T00:00:01.000Z',
    };
    this.latest = checkpoint;
    return { outcome: 'persisted' as const, checkpoint };
  }

  async getLatestCheckpoint() {
    return this.latest;
  }

  async getCheckpoint(input: { sequence: number }) {
    return this.latest?.sequence === input.sequence ? this.latest : null;
  }
}

class MemoryAsyncTaskRepository implements AsyncTaskRepository {
  readonly tasks = new Map<string, AsyncTaskRecord>();

  async createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord> {
    const task: AsyncTaskRecord = {
      id: input.id,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId ?? null,
      threadId: input.threadId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentJobId: input.parentJobId ?? null,
      parentJobRunId: input.parentJobRunId ?? null,
      kind: input.kind,
      status: input.status,
      admissionClass: input.admissionClass,
      authoritySnapshotJson: input.authoritySnapshotJson,
      privateCorrelationJson: input.privateCorrelationJson ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
      leaseToken: input.leaseToken,
      fencingVersion: input.fencingVersion,
      createdAt: input.now,
      updatedAt: input.now,
      summary: input.summary ?? null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async createTaskIdempotently(input: AsyncTaskCreateInput) {
    const existing = input.idempotencyKey
      ? await this.getTaskByIdempotencyKey({
          appId: input.appId,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
        })
      : null;
    return existing
      ? { task: existing, created: false }
      : { task: await this.createTask(input), created: true };
  }

  async getTaskByIdempotencyKey(input: {
    appId: string;
    kind: AsyncTaskRecord['kind'];
    idempotencyKey: string;
  }) {
    return (
      [...this.tasks.values()].find(
        (task) =>
          task.appId === input.appId &&
          task.kind === input.kind &&
          task.idempotencyKey === input.idempotencyKey,
      ) ?? null
    );
  }

  async createTaskWithBacklogAdmission(
    input: AsyncTaskBacklogAdmissionInput,
  ): Promise<AsyncTaskRecord | null> {
    const backlog = [...this.tasks.values()].filter(
      (task) =>
        task.appId === input.task.appId &&
        task.kind === input.task.kind &&
        input.statuses.includes(task.status),
    );
    if (
      backlog.length >= input.maxBacklogPerApp ||
      backlog.filter((task) => task.agentId === input.task.agentId).length >=
        input.maxBacklogPerAgent
    ) {
      return null;
    }
    return this.createTask(input.task);
  }

  async createTaskWithScopedAdmission(
    input: AsyncTaskScopedAdmissionInput,
  ): Promise<AsyncTaskScopedAdmissionResult> {
    return {
      task: await this.createTask(input.task),
      admitted: true,
      staleTasks: [],
    };
  }

  async claimQueuedTask(
    input: AsyncTaskClaimInput,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(input.taskId);
    if (!current || current.status !== 'queued') return null;
    const running = [...this.tasks.values()].filter(
      (task) =>
        task.appId === current.appId &&
        task.kind === current.kind &&
        task.status === 'running',
    );
    if (
      running.length >= input.maxRunningPerApp ||
      running.filter((task) => task.agentId === current.agentId).length >=
        input.maxRunningPerAgent
    ) {
      return null;
    }
    const claimed: AsyncTaskRecord = {
      ...current,
      status: 'running',
      leaseToken: input.leaseToken,
      fencingVersion: current.fencingVersion + 1,
      heartbeatAt: input.now,
      startedAt: input.now,
      updatedAt: input.now,
    };
    this.tasks.set(claimed.id, claimed);
    return claimed;
  }

  async getTask(taskId: string): Promise<AsyncTaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.appId === filter.appId &&
          (!filter.agentId || task.agentId === filter.agentId) &&
          (!filter.kind || task.kind === filter.kind) &&
          (filter.providerAccountId === undefined ||
            (task.privateCorrelationJson.providerAccountId ?? null) ===
              filter.providerAccountId) &&
          (!filter.statuses || filter.statuses.includes(task.status)),
      )
      .slice(0, filter.limit ?? 50);
  }

  async countTasksByStatus(
    filter: Omit<AsyncTaskListFilter, 'limit'>,
  ): Promise<AsyncTaskStatusCount[]> {
    const tasks = await this.listTasks({ ...filter, limit: 100 });
    const counts = new Map<AsyncTaskRecord['status'], number>();
    for (const task of tasks) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    return [...counts.entries()].map(([status, count]) => ({ status, count }));
  }

  async updateTaskReceipt(
    taskId: string,
    receiptJson: AsyncTaskRecord['receiptJson'],
    now: string,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const next = { ...current, receiptJson, updatedAt: now };
    this.tasks.set(taskId, next);
    return next;
  }

  async transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null> {
    const current = this.tasks.get(input.taskId);
    if (
      !current ||
      current.leaseToken !== input.leaseToken ||
      current.fencingVersion !== input.fencingVersion ||
      isAsyncTaskTerminal(current.status)
    ) {
      return null;
    }
    const next: AsyncTaskRecord = {
      ...current,
      status: input.status,
      updatedAt: input.now,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      startedAt: input.startedAt ?? current.startedAt,
      terminalAt: input.terminalAt ?? current.terminalAt,
      privateCorrelationJson:
        input.privateCorrelationJson ?? current.privateCorrelationJson,
      outputSummary: input.outputSummary ?? current.outputSummary,
      errorSummary: input.errorSummary ?? current.errorSummary,
      receiptJson: input.receiptJson ?? current.receiptJson,
    };
    this.tasks.set(next.id, next);
    return next;
  }
}

function registerAsyncTaskPolicy(input: {
  runHandle: string;
  appId?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  jobId?: string;
}): void {
  registerAsyncCommandSandboxPolicy({
    sourceAgentFolder: 'main_agent',
    runHandle: input.runHandle,
    policy: {
      appId: input.appId ?? 'app:test',
      agentId: input.agentId ?? 'agent:signed',
      conversationId: input.conversationId ?? 'sl:C123',
      threadId: null,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      protectedReadPaths: [],
      protectedWritePaths: [],
      allowedNetworkHosts: [],
      resourceLimits: { cpuSeconds: 10, memoryMb: 128, maxProcesses: 8 },
    },
  });
}

describe('MCP IPC tool handlers', () => {
  it('preserves structured remote MCP failures in the IPC response', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mcp-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('GANTRY_HOME', runtimeHome);
    const ipcAuth = await import('@core/runtime/ipc-auth.js');
    const { createMcpToolHandlers: createHandlers } =
      await import('@core/jobs/ipc-mcp-tool-handlers.js');
    const remoteResult = {
      content: [{ type: 'text', text: 'Remote validation failed.' }],
      structuredContent: { field: 'account_id', reason: 'missing' },
      isError: true,
    };
    const createProxy = vi.fn(async () => ({
      callTool: vi.fn(async () => remoteResult),
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { mcpCallToolHandler } = createHandlers(createProxy as never);
    const responseKeyId =
      ipcAuth.createIpcAuthEnvelope('main_agent').responseKeyId;

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        taskId: 'remote-error',
        responseKeyId,
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: { serverName: 'crm', toolName: 'lookup', arguments: {} },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeHome,
          'data',
          'ipc',
          'main_agent',
          'task-responses',
          'task-remote-error.json',
        ),
        'utf8',
      ),
    );
    expect(response).toMatchObject({
      ok: true,
      data: {
        ...remoteResult,
        error: {
          category: 'business',
          isRetryable: false,
          message: 'Remote validation failed.',
        },
      },
    });
  });

  it('uses the signed runner agent id for MCP tool calls', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(createProxy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:signed' }),
    );
  });

  it('rejects side-effecting MCP calls when the run lease is stale', async () => {
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'new-lease',
          fencingVersion: 8,
        })),
      } as never,
    });
    const { mcpCallToolHandler } = createMcpToolHandlers(createProxy as never);

    await mcpCallToolHandler({
      data: {
        type: 'mcp_call_tool',
        appId: 'app:test',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runLeaseToken: 'old-lease',
        runLeaseFencingVersion: 7,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {} as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(callTool).not.toHaveBeenCalled();
  });

  it('starts async MCP calls as durable tasks before remote execution completes', async () => {
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.alloc(32, 11).toString('base64'),
    );
    const repository = new MemoryAsyncTaskRepository();
    let release!: () => void;
    const remoteDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callTool = vi.fn(async (input: { signal?: AbortSignal }) => {
      await remoteDone;
      input.signal?.throwIfAborted();
      return { content: [{ type: 'text', text: 'created' }] };
    });
    const assertToolAllowed = vi.fn(async () => undefined);
    const createProxy = vi.fn(async () => ({
      assertToolAllowed,
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    registerAsyncTaskPolicy({ runHandle: 'run-handle-1', runId: 'run-1' });
    const parent = await repository.createTask({
      id: 'task_parent',
      appId: 'app:test',
      agentId: 'agent:caller',
      conversationId: 'sl:C123',
      threadId: null,
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: { toolName: 'delegate_task' },
      privateCorrelationJson: { targetAgentId: 'agent:signed' },
      leaseToken: 'parent-lease',
      fencingVersion: 1,
      now: '2026-06-25T00:00:00.000Z',
    });
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runHandle: 'run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        parentTaskId: parent.id,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'mcp_tool_call',
    );
    if (!task) throw new Error('mcp_tool_call task was not created');
    expect(task).toMatchObject({
      kind: 'mcp_tool_call',
      appId: 'app:test',
      agentId: 'agent:signed',
      conversationId: 'sl:C123',
      parentRunId: 'run-1',
      parentJobId: null,
      parentJobRunId: null,
      summary: 'crm.create_deal',
    });
    expect(task.privateCorrelationJson.parentTaskId).toBe(parent.id);
    expect(task.privateCorrelationJson.executionPayload).toEqual(
      expect.stringMatching(/^gatask:v1:/),
    );
    expect(JSON.stringify(task.privateCorrelationJson)).not.toContain('Acme');
    expect(
      readEncryptedAsyncTaskPayload<{
        serverName: string;
        toolName: string;
        arguments: Record<string, unknown>;
      }>(task),
    ).toMatchObject({
      serverName: 'crm',
      toolName: 'create_deal',
      arguments: { name: 'Acme' },
    });
    expect(assertToolAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'crm', toolName: 'create_deal' }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:signed',
        serverName: 'crm',
        toolName: 'create_deal',
        timeoutMs: 15 * 60_000,
      }),
    );

    release();
    await vi.waitFor(() => {
      expect(repository.tasks.get(task.id)?.status).toBe('completed');
    });
    expect(repository.tasks.get(task.id)?.receiptJson).toMatchObject({
      used: 'mcp__crm__create_deal',
      delegated: 'no',
      needsAttention: 'none',
    });
  });

  it('does not count non-MCP tasks against async MCP admission capacity', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const now = new Date().toISOString();
    await repository.createTask({
      id: 'task-command',
      appId: 'app:test',
      agentId: 'agent:signed',
      conversationId: 'sl:C123',
      kind: 'async_command',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-command',
      fencingVersion: 1,
      now,
    });
    await repository.createTask({
      id: 'task-delegated',
      appId: 'app:test',
      agentId: 'agent:signed',
      conversationId: 'sl:C123',
      kind: 'delegated_agent',
      status: 'running',
      admissionClass: 'task',
      authoritySnapshotJson: {},
      privateCorrelationJson: {},
      leaseToken: 'lease-delegated',
      fencingVersion: 1,
      now,
    });

    await expect(
      createAsyncMcpTask({
        repository,
        appId: 'app:test',
        agentId: 'agent:signed',
        conversationId: 'sl:C123',
        serverName: 'crm',
        toolName: 'create_deal',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(
      [...repository.tasks.values()].filter(
        (task) => task.kind === 'mcp_tool_call',
      ),
    ).toHaveLength(1);
  });

  it('cancels running async MCP calls through the request signal', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(new Error('MCP request aborted')),
            { once: true },
          );
        }),
    );
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    registerAsyncTaskPolicy({ runHandle: 'run-handle-1', runId: 'run-1' });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runHandle: 'run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'mcp_tool_call',
    );
    if (!task) throw new Error('mcp_tool_call task was not created');
    await vi.waitFor(() => {
      expect(repository.tasks.get(task.id)?.status).toBe('running');
    });
    const service = new AsyncCommandTaskService(repository, {
      run: async () => ({}),
    });

    await expect(service.cancel(task.id)).resolves.toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => {
      expect(repository.tasks.get(task.id)?.status).toBe('cancelled');
    });
    expect(repository.tasks.get(task.id)?.receiptJson).toMatchObject({
      needsAttention:
        'check the remote MCP system before retrying; work may have already run',
    });
  });

  it('rejects async MCP calls when async task tools were not mounted', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool: vi.fn(async () => ({})),
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    registerAsyncTaskPolicy({ runHandle: 'run-handle-1', runId: 'run-1' });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runHandle: 'run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: { getAsyncTaskRepository: () => repository } as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(repository.tasks.size).toBe(0);
    expect(createProxy).not.toHaveBeenCalled();
  });

  it('rejects async MCP calls when the run lease is stale before creating a task', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'new-lease',
          fencingVersion: 8,
        })),
      } as never,
    });
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        runId: 'run-1',
        runLeaseToken: 'old-lease',
        runLeaseFencingVersion: 7,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(repository.tasks.size).toBe(0);
    expect(createProxy).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('stores scheduled async MCP job metadata outside live parentRunId', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(async () => ({}));
    const createProxy = vi.fn(async () => ({
      assertToolAllowed: vi.fn(async () => undefined),
      callTool,
      describeTool: vi.fn(),
      listTools: vi.fn(),
    }));
    configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'job-run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    const { asyncMcpCallToolHandler } = createMcpToolHandlers(
      createProxy as never,
    );
    registerAsyncTaskPolicy({
      runHandle: 'job-run-handle-1',
      runId: 'job-run-1',
      jobId: 'job-1',
    });

    await asyncMcpCallToolHandler({
      data: {
        type: 'async_mcp_call',
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'job-run-1',
        runHandle: 'job-run-handle-1',
        runLeaseToken: 'lease-1',
        runLeaseFencingVersion: 1,
        payload: {
          serverName: 'crm',
          toolName: 'create_deal',
          arguments: { name: 'Acme' },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const task = [...repository.tasks.values()].find(
      (candidate) => candidate.kind === 'mcp_tool_call',
    );
    expect(task).toMatchObject({
      parentRunId: null,
      parentJobId: 'job-1',
      parentJobRunId: 'job-run-1',
    });
  });
});
