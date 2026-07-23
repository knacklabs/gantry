import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import { resolveModelSelection } from '../shared/model-catalog.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import {
  providerIdForFamilyMember,
  type FamilyOrderOverrides,
} from '../shared/model-families.js';
import { isFailoverEligibleError } from './failover-eligibility.js';
import {
  resolveModelFamilyCandidatesForApp,
  type ConfiguredModelProvidersLookup,
} from './model-family-resolution.js';

// Shared helpers for the runtime model-family failover loop, used by both the
// live lane (group-agent-runner.ts) and the jobs lane (jobs/execution.ts). The
// loop bodies stay in their files because their spawn shapes and lease handling
// differ; this module owns the cross-lane decisions so neither file grows past
// its line budget.

// Resolve the configured-first failover candidate list for a turn's requested
// model. Returns [] when there is no requested model or no configured-provider
// lookup, so the caller keeps exact pre-failover behavior (spawn derives the
// default model). Otherwise candidates[0] equals the single-rewrite default.
export async function resolveTurnFailoverCandidates(input: {
  requestedModel: string | undefined;
  appId: string;
  listConfiguredProviders: ConfiguredModelProvidersLookup | undefined;
  familyOrder: FamilyOrderOverrides | undefined;
}): Promise<string[]> {
  if (!input.requestedModel || !input.listConfiguredProviders) return [];
  return resolveModelFamilyCandidatesForApp({
    alias: input.requestedModel,
    appId: input.appId,
    listConfiguredProviders: input.listConfiguredProviders,
    familyOrder: input.familyOrder,
  });
}

// Per-candidate executionProviderId: each concrete family member resolves to its
// own provider route, so a failover to a different provider must recompute the
// lease/session execution provider. Falls back to the supplied default when the
// alias can't be resolved (it then fails loudly downstream at spawn).
export function executionProviderIdForCandidate(
  alias: string,
  fallback: ExecutionProviderId | undefined,
  agentHarness?: AgentHarness,
): ExecutionProviderId {
  const resolved = resolveModelSelection(alias);
  if (!resolved.ok) {
    if (fallback) return fallback;
    throw new Error(`Unable to resolve model candidate: ${alias}`);
  }
  const route = resolveExecutionRoute({ entry: resolved.entry, agentHarness });
  if (route.ok) return route.value.executionProviderId as ExecutionProviderId;
  if (fallback) return fallback;
  throw new Error(
    `Unable to resolve execution provider for model candidate: ${alias}`,
  );
}

// The load-bearing failover decision, identical for both lanes: advance to the
// next candidate ONLY when the run errored, NO visible output has streamed yet,
// the error is provider-specific (eligible), and another candidate exists. The
// streamed-output guard is the safety boundary — a provider failing mid-stream
// must not re-run (it would double-stream). `attempt` is the zero-based index of
// the candidate that just ran; `candidateCount` bounds the loop.
export function shouldFailoverToNextCandidate(input: {
  status: 'success' | 'error' | string;
  error: string | undefined;
  hasStreamedOutput: boolean;
  attempt: number;
  candidateCount: number;
}): boolean {
  if (input.status !== 'error') return false;
  if (input.hasStreamedOutput) return false;
  if (input.attempt >= input.candidateCount - 1) return false;
  return isFailoverEligibleError(input.error);
}

// One-line observability summary for an emitted failover, e.g.
// "Provider <a> (<modelA>) failed (401 ...); retried on <b> (<modelB>).".
export function describeFailover(input: {
  fromProviderId: string;
  toProviderId: string;
  fromModel: string;
  toModel: string;
  reason: string | undefined;
}): string {
  const reason = (input.reason ?? 'provider error').slice(0, 200);
  return `Provider ${input.fromProviderId} (${input.fromModel}) failed (${reason}); retried on ${input.toProviderId} (${input.toModel}).`;
}

// Minimal output shape both lanes share for the failover decision.
export interface FailoverAttemptOutput {
  status: 'success' | 'error' | string;
  error?: string;
}

// Observability details for a single failover advance, passed to `onFailover` so
// a lane can emit a RUN_FAILOVER event. `fromModel`/`toModel` are the concrete
// family members; `reason` is the eligibility-class error text.
export interface FailoverAdvanceDetails {
  toProviderId: ExecutionProviderId;
  fromModel: string;
  toModel: string;
  reason: string | undefined;
}

// RUN_FAILOVER observability event (no secrets): the provider advance
// (from -> to), the requested family/alias, the concrete models, and the
// eligibility-class reason. Best-effort: a missing emitter/appId is skipped, and
// publish failures are swallowed (observability must never break failover).
export function publishRunFailoverEvent(input: {
  publish:
    ((event: RuntimeEventPublishInput) => Promise<unknown> | void) | undefined;
  appId: string | undefined;
  agentId?: string;
  runId?: string;
  conversationId: string;
  threadId?: string | null;
  fromProvider: string;
  family: string | null;
  details: FailoverAdvanceDetails;
}): void {
  if (!input.publish || !input.appId) return;
  void Promise.resolve(
    input.publish({
      appId: input.appId as never,
      ...(input.agentId ? { agentId: input.agentId as never } : {}),
      ...(input.runId ? { runId: input.runId as never } : {}),
      conversationId: input.conversationId as never,
      ...(input.threadId ? { threadId: input.threadId as never } : {}),
      eventType: RUNTIME_EVENT_TYPES.RUN_FAILOVER,
      actor: 'runtime',
      responseMode: 'none',
      payload: {
        fromProvider: input.fromProvider,
        toProvider: input.details.toProviderId,
        family: input.family,
        fromModel: input.details.fromModel,
        toModel: input.details.toModel,
        reason: (input.details.reason ?? 'provider error').slice(0, 200),
      },
    }),
  ).catch(() => {});
}

// Generic candidate-iterating failover loop shared by the live and jobs lanes.
// Given the first attempt's output, it advances through the remaining candidates
// while `shouldFailoverToNextCandidate` holds — re-invoking on each next
// candidate's concrete model and provider. `hasStreamedOutput()` is read FRESH
// each iteration (the safety boundary). `onFailover` records the switch (update
// the lane's active executionProviderId) and is called BEFORE re-invoking with
// the recomputed provider; `log` emits the observable one-line summary. Bounded
// to the candidate count.
export async function runFamilyFailoverLoop<
  O extends FailoverAttemptOutput,
>(input: {
  candidates: readonly string[];
  initialOutput: O;
  fallbackProviderId: ExecutionProviderId;
  agentHarness?: AgentHarness;
  hasStreamedOutput: () => boolean;
  invoke: (model: string) => Promise<O>;
  onFailover: (
    toProviderId: ExecutionProviderId,
    details: FailoverAdvanceDetails,
  ) => ExecutionProviderId;
  log: (message: string) => void;
}): Promise<O> {
  let output = input.initialOutput;
  const candidateCount = Math.max(1, input.candidates.length);
  for (
    let attempt = 0;
    shouldFailoverToNextCandidate({
      status: output.status,
      error: output.error,
      hasStreamedOutput: input.hasStreamedOutput(),
      attempt,
      candidateCount,
    });
    attempt += 1
  ) {
    const toModel = input.candidates[attempt + 1];
    if (!toModel) break;
    const toProviderId = executionProviderIdForCandidate(
      toModel,
      input.fallbackProviderId,
      input.agentHarness,
    );
    const fromModel = input.candidates[attempt] ?? '(default)';
    const fromProviderId = input.onFailover(toProviderId, {
      toProviderId,
      fromModel,
      toModel,
      reason: output.error,
    });
    input.log(
      describeFailover({
        fromProviderId,
        toProviderId: providerIdForFamilyMember(toModel) ?? toProviderId,
        fromModel,
        toModel,
        reason: output.error,
      }),
    );
    output = await input.invoke(toModel);
  }
  return output;
}
