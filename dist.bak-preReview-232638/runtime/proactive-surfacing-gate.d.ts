import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { PatternSubjectScope } from '../shared/pattern-candidate-subject.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import { type ProactiveSurfacingOutcome, type ProactiveSurfacingMetricCandidate } from './proactive-surfacing-metrics.js';
export type AgentLockStatus = 'locked' | 'full' | 'unknown';
export declare function proactiveSurfacingAllowed(deps: GroupProcessingDeps, scope: PatternSubjectScope): Promise<{
    allowed: boolean;
    subjectId?: string;
    failClosedOutcome?: ProactiveSurfacingOutcome;
}>;
export declare function publishProactiveSurfacingOutcomeEvent(input: {
    publish: ((event: RuntimeEventPublishInput) => Promise<void> | void) | undefined;
    appId: string | undefined;
    agentId?: string;
    runId?: string;
    conversationId: string;
    threadId?: string | null;
    subjectId: string | undefined;
    candidates: ProactiveSurfacingMetricCandidate[];
    outcome: ProactiveSurfacingOutcome;
}): void;
