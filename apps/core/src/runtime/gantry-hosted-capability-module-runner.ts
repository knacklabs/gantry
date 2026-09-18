import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type { FileArtifactId } from '../domain/file-artifacts/file-artifact.js';
import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import { jobArtifactScope } from '../domain/ports/job-semantic-checkpoints.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import type {
  GantryHostedCapabilityRunInput,
  GantryHostedCapabilityRunner,
} from '../domain/ports/gantry-hosted-capability-runner.js';
import type {
  BrowserSessionStatus,
  LaunchBrowserOptions,
} from './browser-capability-types.js';
import { resolvePublicEgressAddress } from '../shared/egress-target-resolution.js';
import { stableSha256Json } from '../shared/stable-hash.js';
import { nowIso } from '../shared/time/datetime.js';
import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import { registerVerifiedHostedCapabilityWait } from './hosted-capability-wait.js';
import {
  type IsolatedValidationBrowserSession,
  withIsolatedValidationBrowserSession,
} from './browser-isolated-validation-session.js';

const CONFIG_ENV = 'GANTRY_HOSTED_CAPABILITY_RUNNERS_JSON';
const FILE_ARTIFACT_ID = /^file-artifact:[0-9a-f-]{36}$/iu;

export class HostedCapabilityCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super(
      'Gantry hosted capability commit outcome is uncertain; reconcile the identical invocation.',
      { cause },
    );
  }
}

/**
 * The module's own bounded execution window elapsed while its durable task and
 * parent run are still authoritative. This is deliberately distinct from a
 * lease/cancellation failure: callers can resume the identical invocation and
 * retain case checkpoints, but must not accept a late result from this run.
 */
export class HostedCapabilityExecutionDeadlineError extends Error {
  constructor() {
    super('Gantry hosted validation execution deadline expired.');
  }
}

interface RunnerRegistration {
  readonly capabilityId: string;
  readonly operation: string;
  readonly modulePath: string;
  readonly sha256: string;
  readonly resultCommitOperation?: string;
  /**
   * Product-owned acknowledgement lookup.  The generic runner only knows that
   * a submitted result may need reconciliation; the product supplies the
   * private operation name.
   */
  readonly resultReconcileOperation?: string;
  readonly resultCommitUrl?: string;
  readonly resultCommitTokenEnv?: string;
}

interface BrowserAttestation {
  executableSha256: string | null;
  version: string | null;
}

interface ValidationFence {
  leaseToken: string;
  fencingVersion: number;
  deadlineAtMs: number;
}

interface HostedCapabilityModuleHost {
  writeBinaryArtifact(input: {
    bodyBase64: string;
    contentType: string;
  }): Promise<{
    artifactId: string;
    contentHash: string;
    sizeBytes: number;
    contentType: string;
  }>;
  readPreviousCapabilityResult(): Promise<{
    taskId: string;
    contentDigest: string;
    resultHash: string;
    result: Record<string, unknown>;
  } | null>;
  readJsonArtifact(artifactId: string): Promise<{
    artifactId: string;
    contentHash: string;
    value: unknown;
  }>;
  withBrowserSession<T>(
    execute: (session: IsolatedValidationBrowserSession) => Promise<T>,
    options?: { readonly deadlineAtMs: number },
  ): Promise<T>;
  readValidationCheckpoint(): Promise<{
    completedCases: Record<string, unknown>;
  }>;
  saveValidationCase(input: { caseId: string; result: unknown }): Promise<void>;
  throwIfCancelled(): Promise<void>;
  fetch(input: {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    deadlineAtMs?: number;
  }): Promise<{
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyBase64: string;
  }>;
}

interface HostedCapabilityModule {
  execute(
    input: GantryHostedCapabilityRunInput,
    host: HostedCapabilityModuleHost,
  ): Promise<unknown>;
}

export function createConfiguredGantryHostedCapabilityRunner(input: {
  readonly env?: string;
  readonly getFileArtifactStore: () => FileArtifactStore | undefined;
  readonly getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
  readonly openBrowserSession: (
    profileName: string,
    options: LaunchBrowserOptions,
  ) => Promise<BrowserSessionStatus>;
  readonly closeBrowserSession?: (profileName: string) => Promise<unknown>;
}): GantryHostedCapabilityRunner | undefined {
  const registrations = parseRegistrations(
    input.env ?? process.env[CONFIG_ENV],
  );
  if (registrations.length === 0) return undefined;
  return new SignedModuleCapabilityRunner(registrations, input);
}

class SignedModuleCapabilityRunner implements GantryHostedCapabilityRunner {
  constructor(
    private readonly registrations: readonly RunnerRegistration[],
    private readonly deps: {
      readonly getFileArtifactStore: () => FileArtifactStore | undefined;
      readonly getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
      readonly openBrowserSession: (
        profileName: string,
        options: LaunchBrowserOptions,
      ) => Promise<BrowserSessionStatus>;
      readonly closeBrowserSession?: (profileName: string) => Promise<unknown>;
    },
  ) {}

  async execute(
    input: GantryHostedCapabilityRunInput,
    commitResult?: (
      operation: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<unknown> {
    let disposeHostedWait = () => {};
    try {
      const deadlineAtMs = Date.now() + (input.deadlineMs ?? 60_000);
      remainingValidationTime(deadlineAtMs);
      const registration = this.registrations.find(
        (candidate) =>
          candidate.capabilityId === input.capabilityId &&
          candidate.operation === input.operation,
      );
      if (!registration) {
        throw new Error(
          `No signed Gantry-hosted runner is installed for ${input.capabilityId}.${input.operation}.`,
        );
      }
      const source = await readFile(registration.modulePath);
      const actual = createHash('sha256').update(source).digest('hex');
      if (actual !== registration.sha256) {
        throw new Error(
          `Gantry-hosted runner digest mismatch for ${input.capabilityId}.${input.operation}.`,
        );
      }
      const loaded = (await import(
        `data:text/javascript;base64,${source.toString('base64')}`
      )) as Partial<HostedCapabilityModule>;
      if (typeof loaded.execute !== 'function') {
        throw new Error('Gantry-hosted runner module must export execute().');
      }
      const executeModule = loaded.execute;
      const browserAttestation: BrowserAttestation = {
        executableSha256: null,
        version: null,
      };
      const taskId = capabilityTaskIdentity(input.runtimeContext);
      const task = await this.validationTask(input, taskId);
      const validationFence: ValidationFence = {
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        deadlineAtMs,
      };
      if (input.parentRunLease) {
        disposeHostedWait = registerVerifiedHostedCapabilityWait({
          appId: input.appId,
          agentId: input.agentId,
          jobId: input.jobId,
          runId: input.runId,
          runLeaseToken: input.parentRunLease.leaseToken,
          runLeaseFencingVersion: input.parentRunLease.fencingVersion,
          taskId,
          deadlineAtMs,
          verifyAuthority: async () => {
            await this.validationTask(input, taskId, validationFence);
          },
        });
      }
      const acknowledged = task.privateCorrelationJson.hostedCommit;
      let legacySubmitted: Record<string, unknown> | undefined;
      if (
        acknowledged &&
        typeof acknowledged === 'object' &&
        !Array.isArray(acknowledged)
      ) {
        const state = acknowledged as Record<string, unknown>;
        if (state.argumentsSha256 !== stableSha256Json(input.arguments)) {
          throw new Error('Hosted commit replay arguments do not match.');
        }
        const tested = state.runnerAttestation as
          | Record<string, unknown>
          | undefined;
        // Older acknowledgements already contain the authoritative response and
        // its hash. Replay them under the task fence; do not fabricate attestation.
        if (tested === undefined && state.status === 'acknowledged') {
          await this.validationTask(input, taskId, validationFence);
          return acknowledgedHostedResult(state);
        }
        if (tested === undefined && state.status === 'submitted') {
          legacySubmitted = state;
        } else {
          if (tested?.sha256 !== `sha256:${registration.sha256}`) {
            throw new Error(
              'Hosted commit replay runner digest does not match.',
            );
          }
          const executable = optionalString(tested.browserExecutableSha256);
          if (executable && !/^sha256:[a-f0-9]{64}$/u.test(executable)) {
            throw new Error('Hosted commit replay browser digest is invalid.');
          }
          browserAttestation.executableSha256 = executable?.slice(7) ?? null;
          browserAttestation.version =
            optionalString(tested.browserVersion) ?? null;
        }
        if (state.status === 'acknowledged') {
          await this.validationTask(input, taskId, validationFence);
          return acknowledgedHostedResult(state);
        }
        if (
          state.status === 'submitted' &&
          state.runnerAttestation !== undefined &&
          registration.resultReconcileOperation
        ) {
          const reconciliation = await this.reconcileSubmittedHostedCommit({
            input,
            taskId,
            fence: validationFence,
            state,
            commitResult,
            operation: registration.resultReconcileOperation,
          });
          if (reconciliation.status === 'acknowledged') {
            const settled = await this.recordHostedCommit(
              input,
              taskId,
              validationFence,
              {
                ...state,
                status: 'acknowledged',
                result: reconciliation.result,
                resultSha256: stableSha256Json(reconciliation.result),
              },
              false,
            );
            return acknowledgedHostedResult(settled);
          }
          if (reconciliation.status === 'absent') {
            await this.recordHostedCommit(
              input,
              taskId,
              validationFence,
              { ...state, status: 'reconciliation_absent' },
              false,
            );
            throw new HostedCapabilityCommitUncertainError(
              new Error(
                'The authoritative validation commit is absent; resume from the durable checkpoint under a new capability task.',
              ),
            );
          }
          throw new HostedCapabilityCommitUncertainError(
            new Error(
              'The authoritative validation commit is still pending; wait for its durable acknowledgement before resuming.',
            ),
          );
        }
        if (state.status === 'reconciliation_absent') {
          throw new HostedCapabilityCommitUncertainError(
            new Error(
              'The authoritative validation commit was confirmed absent; the recovery coordinator must resume from the durable checkpoint under a new capability task.',
            ),
          );
        }
      }
      const host = this.hostFor(input, browserAttestation, validationFence);
      const { parentRunLease: _parentRunLease, ...moduleInput } = input;
      const result = await withinValidationDeadline(deadlineAtMs, () =>
        executeModule(moduleInput, host),
      );
      await this.validationTask(input, taskId, validationFence);
      if (!registration.resultCommitOperation) return result;
      if (!commitResult) {
        throw new Error('Hosted result commit transport is unavailable.');
      }
      const payload = {
        capabilityId: input.capabilityId,
        operation: input.operation,
        taskIdentity: capabilityTaskIdentity(input.runtimeContext),
        invocation: {
          appId: input.appId,
          jobId: input.jobId,
          runId: input.runId,
          arguments: input.arguments,
          runtimeContext: input.runtimeContext,
        },
        runnerAttestation: {
          sha256: `sha256:${registration.sha256}`,
          browserExecutableSha256: browserAttestation.executableSha256
            ? `sha256:${browserAttestation.executableSha256}`
            : null,
          browserVersion: browserAttestation.version,
        },
        result,
      };
      if (legacySubmitted) {
        try {
          if (legacySubmitted.payloadSha256 !== stableSha256Json(payload)) {
            // The old payload hash also binds its missing browser metadata. Read
            // the pinned browser configuration in a clean session, not new test
            // evidence; accept it only if the entire original payload matches.
            await withinValidationDeadline(deadlineAtMs, () =>
              host.withBrowserSession(async () => undefined),
            );
            payload.runnerAttestation.browserExecutableSha256 =
              browserAttestation.executableSha256
                ? `sha256:${browserAttestation.executableSha256}`
                : null;
            payload.runnerAttestation.browserVersion =
              browserAttestation.version;
          }
          if (legacySubmitted.payloadSha256 !== stableSha256Json(payload)) {
            throw new Error(
              'Legacy hosted commit payload cannot be reconstructed exactly. Reconcile the authoritative remote outcome before administrator continuation; do not submit changed content under this key.',
            );
          }
        } catch (error) {
          throw new HostedCapabilityCommitUncertainError(error);
        }
      }
      const intent = {
        status: 'submitted',
        operation: registration.resultCommitOperation,
        argumentsSha256: stableSha256Json(input.arguments),
        payloadSha256: stableSha256Json(payload),
        runnerAttestation: payload.runnerAttestation,
      };
      const currentCommit = await this.recordHostedCommit(
        input,
        taskId,
        validationFence,
        intent,
        true,
      );
      if (currentCommit.status === 'acknowledged') {
        await this.validationTask(input, taskId, validationFence);
        return acknowledgedHostedResult(currentCommit);
      }
      try {
        const committed = await withinValidationDeadline(
          deadlineAtMs,
          async () => {
            const current = await this.validationTask(
              input,
              taskId,
              validationFence,
            );
            const latest = current.privateCorrelationJson.hostedCommit as
              | Record<string, unknown>
              | undefined;
            if (latest?.status === 'acknowledged')
              return acknowledgedHostedResult(latest);
            // No further local wait separates this check from submission. A remote
            // acknowledgement can still race the read: the receiver must deduplicate
            // identical task-bound payloads (Manipal's evaluation admission does).
            const response = boundedPreviousResult(
              await commitResult(registration.resultCommitOperation!, payload),
            );
            // An acknowledgement is reconciliation evidence, not task settlement.
            // Retain it even after execution expiry, but never across a changed task fence.
            await this.recordHostedCommit(
              input,
              taskId,
              validationFence,
              {
                ...intent,
                status: 'acknowledged',
                result: response,
                resultSha256: stableSha256Json(response),
              },
              false,
            );
            return response;
          },
        );
        await this.validationTask(input, taskId, validationFence);
        return committed;
      } catch (error) {
        throw new HostedCapabilityCommitUncertainError(error);
      }
    } finally {
      disposeHostedWait();
    }
  }

  private async recordHostedCommit(
    input: GantryHostedCapabilityRunInput,
    taskId: string,
    fence: ValidationFence,
    state: Record<string, unknown>,
    enforceDeadline: boolean,
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.validationTask(
        input,
        taskId,
        fence,
        enforceDeadline,
      );
      const previous = task.privateCorrelationJson.hostedCommit as
        | Record<string, unknown>
        | undefined;
      if (
        previous?.payloadSha256 &&
        previous.payloadSha256 !== state.payloadSha256
      ) {
        throw new Error('Hosted commit replay payload does not match.');
      }
      if (previous?.status === 'acknowledged') {
        if (
          state.status === 'acknowledged' &&
          previous.resultSha256 !== state.resultSha256
        ) {
          throw new Error(
            'Hosted commit returned conflicting acknowledgements.',
          );
        }
        return previous;
      }
      const updated = await this.validationRepository().transitionTask({
        taskId,
        leaseToken: fence.leaseToken,
        fencingVersion: fence.fencingVersion,
        status: 'waiting_external',
        now: nowIso(),
        expectedUpdatedAt: task.updatedAt,
        expectedPrivateCorrelationJson: task.privateCorrelationJson,
        privateCorrelationJson: {
          ...task.privateCorrelationJson,
          hostedCommit: state,
        },
      });
      if (updated) return state;
    }
    throw new Error('Hosted commit checkpoint was concurrently modified.');
  }

  private async reconcileSubmittedHostedCommit(input: {
    input: GantryHostedCapabilityRunInput;
    taskId: string;
    fence: ValidationFence;
    state: Record<string, unknown>;
    commitResult:
      | ((
          operation: string,
          payload: Record<string, unknown>,
        ) => Promise<unknown>)
      | undefined;
    operation: string;
  }): Promise<
    | { status: 'acknowledged'; result: Record<string, unknown> }
    | { status: 'pending' }
    | { status: 'absent' }
  > {
    if (!input.commitResult) return { status: 'pending' };
    const payloadSha256 = requiredString(
      input.state.payloadSha256,
      'Hosted commit payload hash',
    ).replace(/^sha256:/u, '');
    if (!/^[a-f0-9]{64}$/iu.test(payloadSha256)) {
      throw new Error('Hosted commit payload hash is invalid.');
    }
    await this.validationTask(input.input, input.taskId, input.fence);
    const response = boundedPreviousResult(
      await withinValidationDeadline(input.fence.deadlineAtMs, () =>
        input.commitResult!(input.operation, {
          capabilityId: input.input.capabilityId,
          operation: input.input.operation,
          taskIdentity: input.taskId,
          payloadSha256: `sha256:${payloadSha256.toLowerCase()}`,
          invocation: {
            appId: input.input.appId,
            jobId: input.input.jobId,
            runId: input.input.runId,
            runtimeContext: input.input.runtimeContext,
          },
        }),
      ),
    );
    const status = requiredString(response.status, 'Hosted reconciliation status');
    if (status === 'acknowledged') {
      return { status, result: boundedPreviousResult(response.result) };
    }
    if (status === 'pending' || status === 'absent') return { status };
    throw new Error('Hosted reconciliation returned an invalid status.');
  }

  private hostFor(
    input: GantryHostedCapabilityRunInput,
    browserAttestation: BrowserAttestation,
    validationFence: ValidationFence,
  ): HostedCapabilityModuleHost {
    const capabilityTaskId = capabilityTaskIdentity(input.runtimeContext);
    const allowedOrigins = validationOrigins(input.runtimeContext);
    const allowedMethodsByOrigin = validationOriginMethods(
      input.runtimeContext,
      allowedOrigins,
    );
    return {
      readPreviousCapabilityResult: async () => {
        const current = await this.validationTask(
          input,
          capabilityTaskId,
          validationFence,
        );
        const previousTaskId = optionalString(
          current.privateCorrelationJson.previousCapabilityTaskId,
        );
        if (!previousTaskId) return null;
        if (previousTaskId === current.id) {
          throw new Error('Gantry hosted capability predecessor is invalid.');
        }
        const previous =
          await this.validationRepository().getTask(previousTaskId);
        const previousAuthority = previous?.authoritySnapshotJson ?? {};
        if (
          !previous ||
          previous.appId !== current.appId ||
          previous.agentId !== current.agentId ||
          previous.parentJobId !== current.parentJobId ||
          previous.kind !== 'external_capability' ||
          previous.status !== 'completed' ||
          previousAuthority.capabilityId !== input.capabilityId ||
          previousAuthority.operation !== input.operation
        ) {
          throw new Error(
            'Gantry hosted capability predecessor scope is invalid.',
          );
        }
        const contentDigest = requiredString(
          previousAuthority.contentDigest,
          'predecessor.contentDigest',
        );
        const result = boundedPreviousResult(
          previous.privateCorrelationJson.result,
        );
        return {
          taskId: previous.id,
          contentDigest,
          resultHash: `sha256:${stableSha256Json(result)}`,
          result,
        };
      },
      readJsonArtifact: async (artifactId) => {
        await this.validationTask(input, capabilityTaskId, validationFence);
        if (!FILE_ARTIFACT_ID.test(artifactId)) {
          throw new Error('Hosted capability artifact ID is invalid.');
        }
        const store = this.deps.getFileArtifactStore();
        if (!store)
          throw new Error('Gantry file artifact store is unavailable.');
        const loaded = await store.readFileArtifact({
          id: artifactId as FileArtifactId,
          appId: input.appId,
          agentId: input.agentId,
        });
        if (loaded.artifact.virtualScope !== jobArtifactScope(input.jobId)) {
          throw new Error('Hosted capability artifact is outside this job.');
        }
        const text =
          typeof loaded.content === 'string'
            ? loaded.content
            : Buffer.from(loaded.content).toString('utf8');
        return {
          artifactId,
          contentHash: loaded.artifact.contentHash,
          value: JSON.parse(text) as unknown,
        };
      },
      writeBinaryArtifact: async ({ bodyBase64, contentType }) => {
        await this.validationTask(input, capabilityTaskId, validationFence);
        const limit = validationResponseLimit(input.runtimeContext);
        if (
          typeof bodyBase64 !== 'string' ||
          bodyBase64.length > Math.ceil(limit / 3) * 4
        )
          throw new Error(
            'Hosted capability binary artifact exceeds its size limit.',
          );
        const content = Buffer.from(bodyBase64, 'base64');
        if (
          !content.length ||
          content.length > limit ||
          content.toString('base64') !== bodyBase64
        )
          throw new Error(
            'Hosted capability binary artifact is invalid or exceeds its size limit.',
          );
        if (
          typeof contentType !== 'string' ||
          contentType.length > 200 ||
          /[\r\n]/u.test(contentType)
        )
          throw new Error('Hosted capability binary content type is invalid.');
        const store = this.deps.getFileArtifactStore();
        if (!store)
          throw new Error('Gantry file artifact store is unavailable.');
        const digest = createHash('sha256').update(content).digest('hex');
        const owner = createHash('sha256')
          .update(capabilityTaskId)
          .digest('hex');
        const artifact = await withinValidationDeadline(
          validationFence.deadlineAtMs,
          () =>
            store.writeFileArtifact({
              appId: input.appId,
              agentId: input.agentId,
              virtualScope: jobArtifactScope(input.jobId),
              virtualPath: `capability-artifacts/${owner}/${digest}`,
              content,
              contentType,
            }),
        );
        await this.validationTask(input, capabilityTaskId, validationFence);
        if (
          artifact.contentHash !== `sha256:${digest}` ||
          artifact.sizeBytes !== content.length
        )
          throw new Error(
            'Hosted capability binary artifact persistence integrity failed.',
          );
        return {
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
          sizeBytes: artifact.sizeBytes,
          contentType: artifact.contentType,
        };
      },
      withBrowserSession: async (execute, options) => {
        const deadlineAtMs = validationOperationDeadline(
          validationFence.deadlineAtMs,
          options?.deadlineAtMs,
        );
        const profileName = `hosted-validation-${createHash('sha256')
          .update(`${input.appId}\0${capabilityTaskId}`)
          .digest('hex')
          .slice(0, 16)}`;
        await this.validationTask(input, capabilityTaskId, validationFence);
        try {
          const opening = this.deps.openBrowserSession(profileName, {
            deadlineAtMs,
            // Direct executor/CDP activity does not touch the exploration idle
            // timer. Keep this owned session alive until its absolute deadline;
            // the finally block still closes it on completion or cancellation.
            keepAliveMs: remainingValidationTime(deadlineAtMs),
          });
          // A startup that finishes after expiry must not leave its browser alive.
          void opening
            .then(async () => {
              if (Date.now() >= deadlineAtMs) {
                await this.deps.closeBrowserSession?.(profileName);
              }
            })
            .catch(() => undefined);
          const browser = await withinValidationDeadline(
            deadlineAtMs,
            () => opening,
          );
          if (!browser.cdpReady || !browser.port) {
            throw new Error('Gantry validation browser is unavailable.');
          }
          const port = browser.port;
          if (browser.chromeExecutable) {
            browserAttestation.executableSha256 = createHash('sha256')
              .update(
                await withinValidationDeadline(deadlineAtMs, () =>
                  readFile(browser.chromeExecutable!),
                ),
              )
              .digest('hex');
          }
          return await withinValidationDeadline(deadlineAtMs, () =>
            withIsolatedValidationBrowserSession({
              profileName,
              port,
              allowedOrigins: [...allowedOrigins],
              allowedMethodsByOrigin,
              timeoutMs: remainingValidationTime(deadlineAtMs),
              execute: async (session) => {
                browserAttestation.version =
                  session.context.browser()?.version() ?? null;
                return await execute(session);
              },
            }),
          );
        } finally {
          await this.deps.closeBrowserSession?.(profileName);
        }
      },
      readValidationCheckpoint: async () => {
        const task = await this.validationTask(
          input,
          capabilityTaskId,
          validationFence,
        );
        return {
          completedCases: validationCases(
            task.privateCorrelationJson.hostedValidation,
          ),
        };
      },
      saveValidationCase: async ({ caseId, result }) => {
        const normalizedCaseId = requiredString(caseId, 'caseId');
        if (normalizedCaseId.length > 200) {
          throw new Error('Validation caseId is too long.');
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const task = await this.validationTask(
            input,
            capabilityTaskId,
            validationFence,
          );
          const completedCases = validationCases(
            task.privateCorrelationJson.hostedValidation,
          );
          if (Object.hasOwn(completedCases, normalizedCaseId)) {
            if (
              stableSha256Json(completedCases[normalizedCaseId]) !==
              stableSha256Json(result)
            ) {
              throw new Error(
                `Validation case ${normalizedCaseId} was already checkpointed with different content.`,
              );
            }
            return;
          }
          const nextCases = { ...completedCases, [normalizedCaseId]: result };
          if (
            Buffer.byteLength(JSON.stringify(nextCases), 'utf8') >
            192 * 1024
          ) {
            throw new Error(
              'Validation case checkpoint exceeds its size limit.',
            );
          }
          const repository = this.validationRepository();
          const now = nowIso();
          const updated = await repository.transitionTask({
            taskId: task.id,
            leaseToken: task.leaseToken,
            fencingVersion: task.fencingVersion,
            status: 'waiting_external',
            now,
            heartbeatAt: now,
            expectedUpdatedAt: task.updatedAt,
            expectedPrivateCorrelationJson: task.privateCorrelationJson,
            privateCorrelationJson: {
              ...task.privateCorrelationJson,
              hostedValidation: { completedCases: nextCases },
              progress: {
                phase: 'gantry_hosted_validation',
                lastProgress: `Completed validation case ${normalizedCaseId}.`,
                lastToolSummary: `${input.capabilityId}.${input.operation}`,
              },
            },
          });
          if (updated) return;
        }
        throw new Error('Validation checkpoint was concurrently modified.');
      },
      throwIfCancelled: async () => {
        await this.validationTask(input, capabilityTaskId, validationFence);
      },
      fetch: async (request) => {
        await this.validationTask(input, capabilityTaskId, validationFence);
        return await fetchForValidation({
          request,
          allowedOrigins,
          allowedMethodsByOrigin,
          deadlineAtMs: validationOperationDeadline(
            validationFence.deadlineAtMs,
            request.deadlineAtMs,
          ),
          maxResponseBytes: validationResponseLimit(input.runtimeContext),
        });
      },
    };
  }

  private validationRepository(): AsyncTaskRepository {
    const repository = this.deps.getAsyncTaskRepository?.();
    if (!repository) {
      throw new Error(
        'Gantry hosted validation checkpoint store is unavailable.',
      );
    }
    return repository;
  }

  private async validationTask(
    input: GantryHostedCapabilityRunInput,
    taskId: string,
    expectedFence?: ValidationFence,
    enforceDeadline = true,
  ) {
    if (expectedFence && enforceDeadline)
      remainingValidationTime(expectedFence.deadlineAtMs);
    if (
      input.parentRunLease &&
      enforceDeadline &&
      !(await isActiveRunLeaseForInteraction({
        runId: input.runId,
        runLeaseToken: input.parentRunLease.leaseToken,
        runLeaseFencingVersion: input.parentRunLease.fencingVersion,
      }))
    ) {
      throw new Error(
        'Gantry hosted validation parent run lease is no longer active.',
      );
    }
    // A durable task-store read is part of the validation operation. A stalled
    // database/network read must not let a hosted validation outlive its one
    // absolute deadline.
    const task = expectedFence && enforceDeadline
      ? await withinValidationDeadline(expectedFence.deadlineAtMs, () =>
          this.validationRepository().getTask(taskId),
        )
      : await this.validationRepository().getTask(taskId);
    if (
      input.parentRunLease &&
      enforceDeadline &&
      !(await isActiveRunLeaseForInteraction({
        runId: input.runId,
        runLeaseToken: input.parentRunLease.leaseToken,
        runLeaseFencingVersion: input.parentRunLease.fencingVersion,
      }))
    )
      throw new Error(
        'Gantry hosted validation parent run lease is no longer active.',
      );
    if (expectedFence && enforceDeadline)
      remainingValidationTime(expectedFence.deadlineAtMs);
    if (
      !task ||
      task.kind !== 'external_capability' ||
      task.appId !== input.appId ||
      task.agentId !== input.agentId ||
      task.parentJobId !== input.jobId ||
      task.authoritySnapshotJson.capabilityId !== input.capabilityId ||
      task.authoritySnapshotJson.operation !== input.operation
    ) {
      throw new Error('Gantry hosted validation task identity is invalid.');
    }
    if (task.status !== 'waiting_external') {
      throw new Error(`Gantry hosted validation task is ${task.status}.`);
    }
    if (
      expectedFence &&
      (task.leaseToken !== expectedFence.leaseToken ||
        task.fencingVersion !== expectedFence.fencingVersion)
    ) {
      throw new Error('Gantry hosted validation task lease changed.');
    }
    return task;
  }
}

function validationOriginMethods(
  context: Record<string, unknown>,
  origins: ReadonlySet<string>,
): Record<string, readonly string[]> | undefined {
  const policy = context.allowedMethodsByOrigin;
  if (policy === undefined) return undefined;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    throw new Error('Invalid trusted origin method policy.');
  return Object.fromEntries(
    Object.entries(policy).map(([origin, methods]) => {
      if (
        !origins.has(origin) ||
        !Array.isArray(methods) ||
        methods.length === 0 ||
        methods.some((method) => !['GET', 'HEAD'].includes(method))
      ) {
        throw new Error('Invalid trusted origin method policy.');
      }
      return [origin, methods];
    }),
  );
}

function boundedPreviousResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gantry hosted capability predecessor result is invalid.');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) {
    throw new Error(
      'Gantry hosted capability predecessor result exceeds its size limit.',
    );
  }
  return value as Record<string, unknown>;
}

function acknowledgedHostedResult(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result = boundedPreviousResult(state.result);
  if (state.resultSha256 !== stableSha256Json(result)) {
    throw new Error('Hosted commit acknowledgement hash is invalid.');
  }
  return result;
}

function parseRegistrations(raw: string | undefined): RunnerRegistration[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${CONFIG_ENV} must contain a JSON array.`);
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${CONFIG_ENV}[${index}] must be an object.`);
    }
    const item = value as Record<string, unknown>;
    const capabilityId = requiredString(item.capabilityId, 'capabilityId');
    const operation = requiredString(item.operation, 'operation');
    const modulePath = requiredString(item.modulePath, 'modulePath');
    const sha256 = requiredString(item.sha256, 'sha256')
      .toLowerCase()
      .replace(/^sha256:/u, '');
    if (!modulePath.startsWith('/')) {
      throw new Error(`${CONFIG_ENV}[${index}].modulePath must be absolute.`);
    }
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(
        `${CONFIG_ENV}[${index}].sha256 must be a SHA-256 digest.`,
      );
    }
    const resultCommitOperation = optionalString(item.resultCommitOperation);
    const resultReconcileOperation = optionalString(
      item.resultReconcileOperation,
    );
    if (
      resultCommitOperation &&
      !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(resultCommitOperation)
    ) {
      throw new Error(
        `${CONFIG_ENV}[${index}].resultCommitOperation is invalid.`,
      );
    }
    if (
      resultReconcileOperation &&
      !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(resultReconcileOperation)
    ) {
      throw new Error(
        `${CONFIG_ENV}[${index}].resultReconcileOperation is invalid.`,
      );
    }
    return {
      capabilityId,
      operation,
      modulePath,
      sha256,
      ...(resultCommitOperation ? { resultCommitOperation } : {}),
      ...(resultReconcileOperation ? { resultReconcileOperation } : {}),
    };
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Trusted allowedOrigins must be a string array.');
  }
  return value as string[];
}

function capabilityTaskIdentity(
  runtimeContext: Record<string, unknown>,
): string {
  const identity = runtimeContext.capabilityTaskIdentity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('Trusted capability task identity is unavailable.');
  }
  return requiredString(
    (identity as Record<string, unknown>).taskId,
    'capabilityTaskIdentity.taskId',
  );
}

function validationCases(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cases = (value as Record<string, unknown>).completedCases;
  return cases && typeof cases === 'object' && !Array.isArray(cases)
    ? { ...(cases as Record<string, unknown>) }
    : {};
}

function validationOrigins(
  runtimeContext: Record<string, unknown>,
): Set<string> {
  const origins = new Set(
    stringArray(runtimeContext.allowedOrigins).map((value) => {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error(`Invalid validation origin: ${value}`);
      }
      return url.origin;
    }),
  );
  if (origins.size === 0) {
    throw new Error('Recipe validation requires at least one allowed origin.');
  }
  return origins;
}

function validationResponseLimit(
  runtimeContext: Record<string, unknown>,
): number {
  const limits = runtimeContext.runtimeLimits;
  const requested =
    limits && typeof limits === 'object' && !Array.isArray(limits)
      ? Number((limits as Record<string, unknown>).maxDocumentBytes)
      : Number.NaN;
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.trunc(requested), 25 * 1024 * 1024)
    : 10 * 1024 * 1024;
}

export async function fetchForValidation(input: {
  request: {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  };
  allowedOrigins: ReadonlySet<string>;
  allowedMethodsByOrigin?: Readonly<Record<string, readonly string[]>>;
  deadlineAtMs: number;
  maxResponseBytes: number;
}) {
  let url = new URL(input.request.url);
  let method = input.request.method;
  let body = input.request.body;
  let headers = safeRequestHeaders(input.request.headers ?? {});
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    remainingValidationTime(input.deadlineAtMs);
    if (url.username || url.password) {
      throw new Error('Validation request URL credentials are not allowed.');
    }
    if (!input.allowedOrigins.has(url.origin)) {
      throw new Error(
        `Validation request origin is not allowed: ${url.origin}`,
      );
    }
    if (
      input.allowedMethodsByOrigin?.[url.origin] &&
      !input.allowedMethodsByOrigin[url.origin]!.includes(method)
    ) {
      throw new Error(
        `Validation request method is not allowed: ${url.origin}`,
      );
    }
    const resolved = await resolvePublicEgressAddress(url.hostname);
    if (!resolved.ok) {
      throw new Error(
        `Validation request target is not public: ${url.hostname}`,
      );
    }
    const remainingMs = remainingValidationTime(input.deadlineAtMs);
    const response = await requestValidationAddress({
      url,
      address: resolved.address,
      family: resolved.family,
      method,
      headers,
      body: method === 'POST' ? body : undefined,
      timeoutMs: Math.min(30_000, remainingMs),
      maxResponseBytes: input.maxResponseBytes,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error('Validation redirect has no location.');
      if (redirectCount === 5) {
        throw new Error('Validation request exceeded the redirect limit.');
      }
      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== url.origin) {
        // Custom API-key headers are credential-bearing too: forward none.
        headers = {};
        if (body !== undefined && response.status !== 303) {
          throw new Error(
            'Validation cross-origin redirect cannot forward a request body.',
          );
        }
      }
      url = nextUrl;
      if (response.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    remainingValidationTime(input.deadlineAtMs);
    return {
      url: url.href,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      bodyBase64: response.body.toString('base64'),
    };
  }
  throw new Error('Validation request redirect state is invalid.');
}

function validationOperationDeadline(
  parentDeadlineAtMs: number,
  requested?: number,
): number {
  if (requested !== undefined && !Number.isSafeInteger(requested)) {
    throw new Error('Hosted capability operation deadline is invalid.');
  }
  const deadlineAtMs = Math.min(
    parentDeadlineAtMs,
    requested ?? parentDeadlineAtMs,
  );
  remainingValidationTime(deadlineAtMs);
  return deadlineAtMs;
}

function remainingValidationTime(deadlineAtMs: number): number {
  const remaining = deadlineAtMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new HostedCapabilityExecutionDeadlineError();
  }
  return Math.ceil(remaining);
}

async function withinValidationDeadline<T>(
  deadlineAtMs: number,
  execute: () => Promise<T>,
): Promise<T> {
  const remaining = remainingValidationTime(deadlineAtMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HostedCapabilityExecutionDeadlineError(),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestValidationAddress(input: {
  url: URL;
  address: string;
  family: 4 | 6;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}> {
  if (input.url.username || input.url.password) {
    throw new Error('Validation request URL credentials are not allowed.');
  }
  const transport = input.url.protocol === 'https:' ? https : http;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: input.address, family: input.family }]);
      return;
    }
    callback(null, input.address, input.family);
  };
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port || undefined,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: input.headers,
        signal: AbortSignal.timeout(input.timeoutMs),
        lookup,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const statusText = response.statusMessage ?? '';
        const headers = responseHeaders(response.headers);
        const declaredLength = Number(headers['content-length']);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > input.maxResponseBytes
        ) {
          response.destroy();
          reject(new Error('Validation response exceeds its size limit.'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > input.maxResponseBytes) {
            response.destroy(
              new Error('Validation response exceeds its size limit.'),
            );
            return;
          }
          chunks.push(bytes);
        });
        response.once('end', () => {
          resolve({
            status,
            statusText,
            headers,
            body: Buffer.concat(chunks, total),
          });
        });
        response.once('error', reject);
      },
    );
    request.once('error', reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

function responseHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result[name] = value.join(', ');
    else if (value !== undefined) result[name] = String(value);
  }
  return result;
}

function safeRequestHeaders(headers: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      ['host', 'connection', 'content-length', 'transfer-encoding'].includes(
        normalized,
      ) ||
      normalized.startsWith('proxy-')
    ) {
      throw new Error(`Validation request header is not allowed: ${name}`);
    }
    result[name] = String(value);
  }
  return result;
}
