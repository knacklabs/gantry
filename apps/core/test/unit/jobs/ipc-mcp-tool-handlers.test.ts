import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';
import { ExternalCapabilityTaskService } from '@core/application/capabilities/external-capability-task-service.js';
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
import { FileArtifactNotFoundError } from '@core/domain/file-artifacts/file-artifact.js';
import { AsyncCommandTaskService } from '@core/jobs/async-command-task-service.js';
import { createAsyncMcpTask } from '@core/jobs/async-mcp-tool-task.js';
import { readEncryptedAsyncTaskPayload } from '@core/jobs/async-task-execution-payload.js';
import { createMcpToolHandlers } from '@core/jobs/ipc-mcp-tool-handlers.js';
import { registerExternalCapabilitySuspension } from '@core/jobs/external-capability-suspension.js';
import { registerAsyncCommandSandboxPolicy } from '@core/runtime/async-command-sandbox-policy.js';
import { stableSha256Json } from '@core/shared/stable-hash.js';
import * as ipcShared from '@core/jobs/ipc-shared.js';
import {
  HostedCapabilityCommitUncertainError,
  HostedCapabilityExecutionDeadlineError,
} from '@core/runtime/gantry-hosted-capability-module-runner.js';

const runtimeHomes: string[] = [];
const evaluationArguments = {
  candidateHash: 'candidate-hash',
  observationInventory: {
    claims: [{ evidenceRefs: ['artifact-browser-evidence'] }],
  },
};

const syncOperation = {
  executionMode: 'sync' as const,
  requiresActiveJob: true,
  resultEnvelopeSchema: { type: 'object' },
  resultEnvelopeSchemaDigest: 'sha256:test-result-schema',
};

const durableOperation = {
  executionMode: 'durable_async' as const,
  requiresActiveJob: true,
  resultEnvelopeSchema: { type: 'object' },
  resultEnvelopeSchemaDigest: 'sha256:test-result-schema',
};

const gantryHostedOperation = {
  executionMode: 'gantry_hosted' as const,
  requiresActiveJob: true,
  resultEnvelopeSchema: { type: 'object' },
  resultEnvelopeSchemaDigest: 'sha256:test-result-schema',
  suspensionCheckpoint: {
    milestone: 'validation_submitted',
    payloadPatch: {
      safePhase: 'validating',
      nextAction: 'Resume this exact validation invocation.',
    },
    invocationRefPath: ['evaluatorInvocationRef'],
  },
};

const checkpointPayloadSchema = {
  type: 'object',
  properties: {
    safePhase: { type: 'string' },
    artifactRefs: { type: 'array' },
    evaluatorInvocationRef: { type: ['string', 'null'] },
    pendingInteractionRef: { type: ['string', 'null'] },
    nextAction: { type: 'string' },
    cumulativeRuntimeMs: { type: 'integer', minimum: 0 },
  },
  required: [
    'safePhase',
    'artifactRefs',
    'evaluatorInvocationRef',
    'pendingInteractionRef',
    'nextAction',
    'cumulativeRuntimeMs',
  ],
  additionalProperties: false,
} as const;

const durableCheckpointOperation = {
  ...durableOperation,
  suspensionCheckpoint: {
    milestone: 'external_task_submitted',
    payloadPatch: {
      safePhase: 'waiting_external',
      nextAction: 'Await the external result.',
    },
    invocationRefPath: ['evaluatorInvocationRef'],
  },
};

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
  const retained = new Map<string, { artifact: unknown; content: string }>();
  const defaultArtifacts = {
    readFileArtifact: vi.fn(async (input: { virtualPath: string }) => {
      const saved = retained.get(input.virtualPath);
      if (!saved) throw new FileArtifactNotFoundError();
      return saved;
    }),
    writeFileArtifact: vi.fn(
      async (input: {
        content: string;
        virtualScope: string;
        virtualPath: string;
      }) => {
        const artifact = {
          id: 'file-artifact:88888888-8888-4888-8888-888888888888',
          virtualScope: input.virtualScope,
          contentHash: `sha256:${stableSha256Json(JSON.parse(input.content))}`,
        };
        retained.set(input.virtualPath, { artifact, content: input.content });
        return artifact;
      },
    ),
  };
  return {
    getAsyncTaskRepository: () => repository,
    getJobSemanticCheckpointRepository: () => checkpoints,
    opsRepository: {
      getJobById: vi.fn(async () => ({
        agent_task: {
          checkpointContract: {
            schema: checkpointPayloadSchema,
            schemaDigest: `sha256:${stableSha256Json(checkpointPayloadSchema)}`,
          },
        },
      })),
    },
    getFileArtifactStore: () => fileArtifacts ?? defaultArtifacts,
    runnerSandboxProvider: { enforcing: true },
  } as never;
}

describe('external capability MCP task', () => {
  it.each([
    [
      {
        serverName: 'evaluator',
        toolName: 'validate_recipe',
        capabilityId: 'evaluator@1',
        arguments: {},
      },
      ['idempotencyKey'],
    ],
    [
      {
        serverName: 'evaluator',
        toolName: 'validate_recipe',
        capabilityId: 'evaluator@1',
        idempotencyKey: 'key',
      },
      ['arguments or argumentsArtifactId'],
    ],
    [
      {
        serverName: 'evaluator',
        toolName: 'validate_recipe',
        capabilityId: 'evaluator@1',
        idempotencyKey: 'key',
        arguments: '{}',
      },
      ['arguments or argumentsArtifactId'],
    ],
  ])(
    'returns correctable envelope errors without admitting or executing a task (%j)',
    async (payload, missingFields) => {
      const acceptData = vi.fn();
      const reject = vi.fn();
      vi.spyOn(ipcShared, 'createTaskResponder').mockReturnValue({
        acceptData,
        reject,
        accept: vi.fn(),
      } as never);
      const proxyFactory = vi.fn();
      const repository = new MemoryAsyncTaskRepository();
      const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
        proxyFactory as never,
      );
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
          payload,
        },
        sourceAgentFolder: 'main_agent',
        sourceAgentFolderJids: ['sl:C123'],
        deps: asyncRuntimeDeps(repository, new MemoryJobCheckpointRepository()),
        conversationBindings: {},
      } as never);
      expect(reject).not.toHaveBeenCalled();
      expect(acceptData).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          code: 'CAPABILITY_INPUT_SCHEMA_INVALID',
          missingFields,
          recoverable: true,
          retrySamePayload: false,
        }),
        'CAPABILITY_INPUT_SCHEMA_INVALID',
      );
      expect(proxyFactory).not.toHaveBeenCalled();
      expect(repository.tasks.size).toBe(0);
    },
  );
  it.each([
    'completed',
    'conflict',
    'network',
    'fatal',
    'uncertain',
    'deadline',
    'retention',
  ] as const)(
    'handles durable hosted settlement %s truthfully',
    async (outcome) => {
      const rejectedSettlement =
        outcome === 'conflict'
          ? vi
              .spyOn(ExternalCapabilityTaskService.prototype, 'complete')
              .mockResolvedValue({ outcome })
          : null;
      const acceptData = vi.fn();
      const responder =
        outcome !== 'completed'
          ? vi.spyOn(ipcShared, 'createTaskResponder').mockReturnValue({
              acceptData,
              reject: vi.fn(),
              accept: vi.fn(),
            } as never)
          : null;
      const repository = new MemoryAsyncTaskRepository();
      const checkpoints = new MemoryJobCheckpointRepository();
      let savedArguments: string | undefined;
      const replayArtifactId =
        'file-artifact:99999999-9999-4999-8999-999999999999';
      const fileArtifacts = {
        writeFileArtifact: vi.fn(
          async (input: { content: string; virtualScope: string }) => {
            savedArguments = input.content;
            return {
              id: replayArtifactId,
              virtualScope: input.virtualScope,
              contentHash: `sha256:${stableSha256Json(JSON.parse(input.content))}`,
            };
          },
        ),
        readFileArtifact: vi.fn(async () => {
          if (savedArguments === undefined)
            throw new FileArtifactNotFoundError();
          return {
            artifact: {
              id: replayArtifactId,
              virtualScope: jobArtifactScope('job-1'),
              sizeBytes: savedArguments.length,
              contentHash: `sha256:${stableSha256Json(JSON.parse(savedArguments))}`,
            },
            content: savedArguments,
          };
        }),
      } as unknown as FileArtifactStore;
      if (outcome === 'retention') {
        vi.mocked(fileArtifacts.writeFileArtifact).mockRejectedValueOnce(
          new Error('storage unavailable'),
        );
      }
      const execute = vi.fn(
        async (
          _input: unknown,
          commitResult: (
            operation: string,
            payload: Record<string, unknown>,
          ) => Promise<unknown>,
        ) => {
          const committed = await commitResult('validation_commit', {
            proof: 'runner-result',
          });
          expect(committed).toEqual({
            status: 'proven',
            evaluationId: 'evaluation-1',
          });
          return committed;
        },
      );
      if (outcome === 'network' || outcome === 'fatal') {
        execute.mockRejectedValueOnce(
          new Error(
            outcome === 'network'
              ? 'network connection lost'
              : 'invalid signed bundle',
          ),
        );
      }
      if (outcome === 'uncertain')
        execute.mockRejectedValueOnce(
          new HostedCapabilityCommitUncertainError(
            new Error('deadline expired'),
          ),
        );
      if (outcome === 'deadline')
        execute.mockRejectedValueOnce(
          new HostedCapabilityExecutionDeadlineError(),
        );
      const callTool = vi.fn(async () => ({
        structuredContent: {
          status: 'proven',
          evaluationId: 'evaluation-1',
        },
      }));
      const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
        vi.fn(async () => ({
          preflightExternalCapabilityCall: vi.fn(async () => ({
            ok: true as const,
            operation: gantryHostedOperation,
          })),
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

      const updateJob = vi.fn(async () => undefined);
      const onSchedulerChanged = vi.fn();

      const context = {
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
            toolName: 'validate_recipe',
            capabilityId: 'manipal.website-recipe-evaluator@13',
            idempotencyKey: 'validation-1',
            arguments: evaluationArguments,
          },
        },
        sourceAgentFolder: 'main_agent',
        deps: {
          ...asyncRuntimeDeps(repository, checkpoints, fileArtifacts),
          getGantryHostedCapabilityRunner: () => ({ execute }),
          getJobControl: () => ({
            getAppSessionById: vi.fn(async () => ({ appId: 'app:test' })),
          }),
          onSchedulerChanged,
          opsRepository: {
            getJobById: vi.fn(async () => ({
              session_id: 'session-1',
              status: 'paused',
              pause_reason: `Waiting for external capability task ${[...repository.tasks.keys()][0] ?? ''}.`,
              agent_task: {
                checkpointContract: {
                  schema: checkpointPayloadSchema,
                  schemaDigest: `sha256:${stableSha256Json(checkpointPayloadSchema)}`,
                },
                trustedCapabilityContext: {
                  requestId: 'request-1',
                  attemptId: 'attempt-1',
                },
              },
            })),
            updateJob,
          },
        } as never,
        conversationBindings: {},
        sourceAgentFolderJids: ['sl:C123'],
      } as never;

      await externalCapabilityCallToolHandler(context);
      if (outcome === 'retention') {
        expect(acceptData).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({
            code: 'GANTRY_HOSTED_INPUT_RETENTION_FAILED',
            retrySamePayload: true,
          }),
          expect.any(String),
        );
        expect(execute).not.toHaveBeenCalled();
        expect(callTool).not.toHaveBeenCalled();
        await externalCapabilityCallToolHandler(context);
        expect(execute).toHaveBeenCalledOnce();
        responder?.mockRestore();
        return;
      }
      if (
        outcome === 'network' ||
        outcome === 'fatal' ||
        outcome === 'uncertain' ||
        outcome === 'deadline'
      ) {
        expect(acceptData).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({
            status: 'rejected',
            code:
              outcome === 'deadline'
                ? 'GANTRY_HOSTED_CAPABILITY_EXECUTION_DEADLINE'
                : 'GANTRY_HOSTED_CAPABILITY_FAILED',
            retrySamePayload: outcome !== 'fatal',
            retryable: outcome !== 'fatal',
          }),
          outcome === 'deadline'
            ? 'GANTRY_HOSTED_CAPABILITY_EXECUTION_DEADLINE'
            : 'GANTRY_HOSTED_CAPABILITY_FAILED',
        );
        expect([...repository.tasks.values()][0]?.status).toBe(
          outcome !== 'fatal' ? 'waiting_external' : 'cancelled',
        );
        if (outcome === 'uncertain') {
          expect(savedArguments && JSON.parse(savedArguments)).toEqual(
            evaluationArguments,
          );
          expect(acceptData).toHaveBeenLastCalledWith(
            expect.any(String),
            expect.objectContaining({ argumentsArtifactId: replayArtifactId }),
            expect.any(String),
          );
          const checkpoint = await checkpoints.getLatestCheckpoint();
          expect(checkpoint?.payload.artifactRefs).toContainEqual(
            expect.objectContaining({
              artifactId: replayArtifactId,
              kind: 'capability_arguments',
            }),
          );
          expect(checkpoint?.payload.nextAction).toContain(replayArtifactId);
          const replayContext = context as unknown as {
            data: { payload: Record<string, unknown> };
          };
          replayContext.data.payload.arguments = {
            candidateHash: 'changed-input',
          };
          await externalCapabilityCallToolHandler(context);
          expect(acceptData).toHaveBeenLastCalledWith(
            expect.any(String),
            expect.objectContaining({
              code: 'GANTRY_HOSTED_CAPABILITY_IDEMPOTENCY_CONFLICT',
            }),
            expect.any(String),
          );
          expect(execute).toHaveBeenCalledOnce();
          delete replayContext.data.payload.arguments;
          replayContext.data.payload.argumentsArtifactId = replayArtifactId;
        }
        await externalCapabilityCallToolHandler(context);
        expect(execute).toHaveBeenCalledTimes(outcome !== 'fatal' ? 2 : 1);
        responder?.mockRestore();
        return;
      }
      if (rejectedSettlement) {
        rejectedSettlement.mockRestore();
        responder?.mockRestore();
        expect(acceptData).toHaveBeenLastCalledWith(
          expect.any(String),
          expect.objectContaining({
            status: 'rejected',
            code: 'GANTRY_HOSTED_CAPABILITY_SETTLEMENT_REJECTED',
          }),
          'GANTRY_HOSTED_CAPABILITY_SETTLEMENT_REJECTED',
        );
        expect(updateJob).not.toHaveBeenCalled();
        expect(onSchedulerChanged).not.toHaveBeenCalled();
        expect(
          [...repository.tasks.values()].some(
            (task) => task.status === 'completed',
          ),
        ).toBe(false);
        return;
      }
      await externalCapabilityCallToolHandler(context);

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilityId: 'manipal.website-recipe-evaluator@13',
          operation: 'validate_recipe',
          arguments: evaluationArguments,
          runtimeContext: expect.objectContaining({
            requestId: 'request-1',
            attemptId: 'attempt-1',
            gantryJobId: 'job-1',
            gantryRunId: 'run-1',
            idempotencyKey: 'validation-1',
            capabilityTaskIdentity: expect.objectContaining({
              capabilityId: 'manipal.website-recipe-evaluator@13',
              operation: 'validate_recipe',
            }),
          }),
        }),
        expect.any(Function),
      );
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'validation_commit',
          authorizationToolName: 'validate_recipe',
          authorizationArguments: evaluationArguments,
          arguments: expect.objectContaining({
            proof: 'runner-result',
            _gantryCapabilityTask: {
              taskId: expect.any(String),
              completionToken: expect.any(String),
            },
          }),
        }),
      );
      expect(execute).toHaveBeenCalledOnce();
      const checkpointRepository =
        context.deps.getJobSemanticCheckpointRepository() as MemoryJobCheckpointRepository;
      expect(checkpointRepository.latest).toMatchObject({
        milestone: 'validation_submitted',
        payload: {
          safePhase: 'validating',
          evaluatorInvocationRef: 'invocation:validation-1',
          nextAction: expect.stringContaining(replayArtifactId),
        },
      });
      expect(updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'active',
          next_run: expect.any(String),
          pause_reason: null,
        }),
      );
      expect(onSchedulerChanged).toHaveBeenCalledWith('job-1');
      expect([...repository.tasks.values()]).toContainEqual(
        expect.objectContaining({
          kind: 'external_capability',
          status: 'completed',
        }),
      );

      await externalCapabilityCallToolHandler({
        ...context,
        data: {
          ...(context as { data: Record<string, unknown> }).data,
          payload: {
            ...((context as { data: { payload: Record<string, unknown> } }).data
              .payload ?? {}),
            arguments: { ...evaluationArguments, candidateHash: 'changed' },
          },
        },
      } as never);
      expect(execute).toHaveBeenCalledOnce();
    },
  );

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
    const preflightExternalCapabilityCall = vi.fn(async () => ({
      ok: true as const,
      operation: syncOperation,
    }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall,
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

    expect(preflightExternalCapabilityCall).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: 'manipal.website-recipe-evaluator@1',
        arguments: compileArguments,
      }),
    );
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

  it('expands generic job-scoped JSON artifact includes before capability validation', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const argumentsArtifactId =
      'file-artifact:11111111-1111-4111-8111-111111111111';
    const firstUnitArtifactId =
      'file-artifact:22222222-2222-4222-8222-222222222222';
    const secondUnitArtifactId =
      'file-artifact:33333333-3333-4333-8333-333333333333';
    const firstUnit = { id: 'first', value: { complete: true } };
    const secondUnit = { id: 'second', value: { complete: true } };
    const argumentsTemplate = {
      requestId: 'request-1',
      units: [
        { $gantryArtifactJson: firstUnitArtifactId },
        { $gantryArtifactJson: secondUnitArtifactId },
      ],
    };
    const records = new Map([
      [argumentsArtifactId, JSON.stringify(argumentsTemplate)],
      [firstUnitArtifactId, JSON.stringify(firstUnit)],
      [secondUnitArtifactId, JSON.stringify(secondUnit)],
    ]);
    const fileArtifacts = {
      readFileArtifact: vi.fn(async ({ id }: { id: string }) => {
        const content = records.get(id);
        if (!content) throw new Error('missing test artifact');
        return {
          artifact: {
            id,
            appId: 'app:test',
            agentId: 'agent:signed',
            virtualScope: jobArtifactScope('job-1'),
            virtualPath: `arguments/${id}.json`,
            version: 1,
            storageType: 'local-filesystem',
            storageRef: 'test',
            contentHash: `sha256:${id}`,
            sizeBytes: content.length,
            contentType: 'application/json',
            metadata: {},
            createdAt: '2026-08-30T00:00:00.000Z',
          },
          content,
        };
      }),
    } as unknown as FileArtifactStore;
    const expectedArguments = {
      requestId: 'request-1',
      units: [firstUnit, secondUnit],
    };
    const preflightExternalCapabilityCall = vi.fn(async () => ({
      ok: true as const,
      operation: syncOperation,
    }));
    const callTool = vi.fn(async () => ({ structuredContent: { ok: true } }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall,
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
          serverName: 'generic-capability',
          toolName: 'evaluate',
          capabilityId: 'generic.capability@1',
          idempotencyKey: 'expanded-artifact-includes',
          argumentsArtifactId,
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

    expect(preflightExternalCapabilityCall).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: expectedArguments }),
    );
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expectedArguments,
        authorizationArguments: expectedArguments,
      }),
    );
  });

  it('rejects invalid expanded arguments before invoking or admitting work', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository();
    const callTool = vi.fn();
    const preflightExternalCapabilityCall = vi.fn(async () => ({
      ok: false as const,
      status: 'rejected' as const,
      code: 'CAPABILITY_INPUT_SCHEMA_INVALID' as const,
      message:
        'External capability arguments do not match the reviewed input schema.',
      repairable: true,
      retryable: false,
      retrySamePayload: false,
      diagnostics: [
        {
          instancePath: '/recipe/site',
          keyword: 'invalid_type',
          message: 'Value has the wrong type.',
        },
      ],
    }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall,
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
          idempotencyKey: 'invalid-compile',
          arguments: { recipe: { site: 42 } },
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(repository, checkpoints),
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(preflightExternalCapabilityCall).toHaveBeenCalledOnce();
    expect(callTool).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(0);
    expect(checkpoints.latest?.sequence).toBe(1);
  });

  it('accepts the signed app conversation for a scheduled job without a chat route', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall: vi.fn(async () => ({
          ok: true as const,
          operation: durableOperation,
        })),
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

  it('recovers a legacy waiting task before persisting its suspension checkpoint', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository();
    const abort = vi.fn();
    const unregister = registerExternalCapabilitySuspension({
      jobId: 'job-1',
      runId: 'run-1',
      abort,
    });
    const preflightExternalCapabilityCall = vi.fn(async () => ({
      ok: true as const,
      operation: durableCheckpointOperation,
    }));
    const callTool = vi.fn(async () => ({ evaluationId: 'evaluation-1' }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall,
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
    const stranded = await new ExternalCapabilityTaskService(repository).accept(
      {
        appId: 'app:test',
        agentId: 'agent:signed',
        conversationId: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        capabilityId: 'manipal.website-recipe-evaluator@1',
        operation: 'evaluation.submit',
        contentDigest: `sha256:${stableSha256Json(evaluationArguments)}`,
        invocationRef: 'invocation:evaluation-submit-1',
        idempotencyKey: 'evaluation-submit-1',
      },
    );
    delete repository.tasks.get(stranded.taskId)?.authoritySnapshotJson
      .contentDigest;

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
    expect(preflightExternalCapabilityCall).toHaveBeenCalledWith(
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
      milestone: 'external_task_submitted',
      payload: {
        safePhase: 'waiting_external',
        evaluatorInvocationRef: 'invocation:evaluation-submit-1',
        nextAction: 'Await the external result.',
      },
    });
    unregister();
  });

  it('completes deterministic revision results without suspending the job', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository();
    const callTool = vi.fn(async () => ({
      structuredContent: {
        status: 'revision_required',
        diagnostics: ['candidate selector is invalid'],
      },
    }));
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall: vi.fn(async () => ({
          ok: true as const,
          operation: durableCheckpointOperation,
        })),
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
          toolName: 'validate_recipe',
          capabilityId: 'manipal.website-recipe-evaluator@12',
          idempotencyKey: 'validation-1',
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
    expect(task).toMatchObject({ status: 'completed' });
    expect(callTool).toHaveBeenCalledOnce();
    expect(checkpoints.latest?.sequence).toBe(1);
  });

  it('returns a durable capability submission rejection to the agent instead of failing the run', async () => {
    const repository = new MemoryAsyncTaskRepository();
    const checkpoints = new MemoryJobCheckpointRepository();
    const callTool = vi.fn(async () => {
      throw new Error('Test plan must contain between 1 and 100 cases.');
    });
    const { externalCapabilityCallToolHandler } = createMcpToolHandlers(
      vi.fn(async () => ({
        preflightExternalCapabilityCall: vi.fn(async () => ({
          ok: true as const,
          operation: durableOperation,
        })),
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

    await expect(
      externalCapabilityCallToolHandler({
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
            serverName: 'example-capability',
            toolName: 'submit',
            capabilityId: 'example.capability@1',
            idempotencyKey: 'rejected-submission',
            arguments: evaluationArguments,
          },
        },
        sourceAgentFolder: 'main_agent',
        deps: asyncRuntimeDeps(repository, checkpoints),
        conversationBindings: {},
        sourceAgentFolderJids: ['sl:C123'],
      }),
    ).resolves.toBeUndefined();

    expect(callTool).toHaveBeenCalledOnce();
    expect([...repository.tasks.values()]).toContainEqual(
      expect.objectContaining({
        kind: 'external_capability',
        status: 'cancelled',
      }),
    );
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
        preflightExternalCapabilityCall: vi.fn(async () => ({
          ok: true as const,
          operation: durableOperation,
        })),
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
    expect(checkpoints.latest?.sequence).toBe(1);
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
  it('returns malformed artifact-backed capability arguments as a repairable result', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-capability-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('GANTRY_HOME', runtimeHome);
    const ipcAuth = await import('@core/runtime/ipc-auth.js');
    const { createMcpToolHandlers: createHandlers } =
      await import('@core/jobs/ipc-mcp-tool-handlers.js');
    const artifactId = 'file-artifact:33333333-3333-4333-8333-333333333333';
    const fileArtifacts = {
      readFileArtifact: vi.fn(async () => ({
        artifact: {
          id: artifactId,
          appId: 'app:test',
          agentId: 'agent:signed',
          virtualScope: jobArtifactScope('job-1'),
          virtualPath: 'compile-input.json',
          version: 1,
          storageType: 'local-filesystem',
          storageRef: 'test',
          contentHash: 'sha256:malformed',
          sizeBytes: 10,
          contentType: 'application/json',
          metadata: {},
          createdAt: '2026-08-29T00:00:00.000Z',
        },
        content: '{"recipe":{}}}',
      })),
    } as unknown as FileArtifactStore;
    const createProxy = vi.fn();
    const { externalCapabilityCallToolHandler } = createHandlers(
      createProxy as never,
    );
    const responseKeyId =
      ipcAuth.createIpcAuthEnvelope('main_agent').responseKeyId;

    await externalCapabilityCallToolHandler({
      data: {
        type: 'external_capability_call',
        taskId: 'malformed-capability-artifact',
        responseKeyId,
        appId: 'app:test',
        agentId: 'agent:signed',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jobId: 'job-1',
        runId: 'run-1',
        sourceJobId: 'job-1',
        sourceRunId: 'run-1',
        payload: {
          serverName: 'example-capability',
          toolName: 'compile',
          capabilityId: 'example.capability@1',
          idempotencyKey: 'malformed-artifact',
          argumentsArtifactId: artifactId,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: asyncRuntimeDeps(
        new MemoryAsyncTaskRepository(),
        new MemoryJobCheckpointRepository(),
        fileArtifacts,
      ),
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
          'task-malformed-capability-artifact.json',
        ),
        'utf8',
      ),
    );
    expect(response).toMatchObject({
      ok: true,
      data: {
        status: 'rejected',
        code: 'CAPABILITY_ARGUMENTS_PARSE_INVALID',
        repairable: true,
        retrySamePayload: false,
      },
    });
    expect(createProxy).not.toHaveBeenCalled();
  });

  it('returns temporary capability preflight outages as retryable tool results', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-capability-preflight-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.resetModules();
    vi.stubEnv('GANTRY_HOME', runtimeHome);
    const ipcAuth = await import('@core/runtime/ipc-auth.js');
    const pendingInteractionDurability =
      await import('@core/application/interactions/pending-interaction-durability.js');
    const { createMcpToolHandlers: createHandlers } =
      await import('@core/jobs/ipc-mcp-tool-handlers.js');
    const createProxy = vi.fn(async () => {
      throw new Error('Streamable HTTP error: Error POSTing to endpoint');
    });
    const { externalCapabilityCallToolHandler } = createHandlers(
      createProxy as never,
    );
    pendingInteractionDurability.configurePendingInteractionDurability({
      repository: {
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-1',
          fencingVersion: 1,
        })),
      } as never,
    });
    const responseKeyId =
      ipcAuth.createIpcAuthEnvelope('main_agent').responseKeyId;

    await expect(
      externalCapabilityCallToolHandler({
        data: {
          type: 'external_capability_call',
          taskId: 'capability-preflight-unavailable',
          responseKeyId,
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
            serverName: 'example-capability',
            toolName: 'submit',
            capabilityId: 'example.capability@1',
            idempotencyKey: 'preflight-unavailable',
            arguments: evaluationArguments,
          },
        },
        sourceAgentFolder: 'main_agent',
        deps: asyncRuntimeDeps(new MemoryAsyncTaskRepository()),
        conversationBindings: {},
        sourceAgentFolderJids: ['sl:C123'],
      }),
    ).resolves.toBeUndefined();

    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeHome,
          'data',
          'ipc',
          'main_agent',
          'task-responses',
          'task-capability-preflight-unavailable.json',
        ),
        'utf8',
      ),
    );
    expect(response).toMatchObject({
      ok: true,
      data: {
        status: 'rejected',
        code: 'CAPABILITY_PREFLIGHT_UNAVAILABLE',
        repairable: true,
        retryable: true,
        retrySamePayload: true,
      },
    });
  });

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
