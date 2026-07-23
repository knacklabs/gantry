import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { PatternSubjectScope } from '../shared/pattern-candidate-subject.js';
import { patternSubjectForScope } from '../shared/pattern-candidate-subject.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import {
  buildProactiveSurfacingMetricPayloads,
  type ProactiveSurfacingOutcome,
  type ProactiveSurfacingMetricCandidate,
} from './proactive-surfacing-metrics.js';

export type AgentLockStatus = 'locked' | 'full' | 'unknown';

export async function proactiveSurfacingAllowed(
  deps: GroupProcessingDeps,
  scope: PatternSubjectScope,
): Promise<{
  allowed: boolean;
  subjectId?: string;
  failClosedOutcome?: ProactiveSurfacingOutcome;
}> {
  if (deps.getAgentLockStatus?.(scope.folder) !== 'full') {
    return { allowed: false };
  }
  const subject = patternSubjectForScope(scope);
  if (!subject) return { allowed: false };
  const repo = deps.getProactiveSurfacingRepository?.();
  if (!repo) {
    return {
      allowed: false,
      subjectId: subject.subjectId,
      failClosedOutcome: 'opt_in_unavailable',
    };
  }
  try {
    const optIn = await repo.getBySubject({
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
    });
    if (optIn?.proactiveSurfacingEnabled === false) {
      return {
        allowed: false,
        subjectId: subject.subjectId,
        failClosedOutcome: 'opted_out',
      };
    }
    return {
      allowed: optIn?.proactiveSurfacingEnabled === true,
      subjectId: subject.subjectId,
    };
  } catch {
    return {
      allowed: false,
      subjectId: subject.subjectId,
      failClosedOutcome: 'opt_in_unavailable',
    };
  }
}

export function publishProactiveSurfacingOutcomeEvent(input: {
  publish:
    ((event: RuntimeEventPublishInput) => Promise<void> | void) | undefined;
  appId: string | undefined;
  agentId?: string;
  runId?: string;
  conversationId: string;
  threadId?: string | null;
  subjectId: string | undefined;
  candidates: ProactiveSurfacingMetricCandidate[];
  outcome: ProactiveSurfacingOutcome;
}): void {
  if (!input.publish || !input.appId || !input.subjectId) return;
  const payloads = buildProactiveSurfacingMetricPayloads({
    subjectId: input.subjectId,
    candidates: input.candidates,
    outcome: input.outcome,
  });
  for (const payload of payloads) {
    void Promise.resolve(
      input.publish({
        appId: input.appId as never,
        ...(input.agentId ? { agentId: input.agentId as never } : {}),
        ...(input.runId ? { runId: input.runId as never } : {}),
        conversationId: input.conversationId as never,
        ...(input.threadId ? { threadId: input.threadId as never } : {}),
        eventType: RUNTIME_EVENT_TYPES.PROACTIVE_SURFACING_OUTCOME,
        actor: 'runtime',
        responseMode: 'none',
        payload,
      }),
    ).catch(() => {});
  }
}
