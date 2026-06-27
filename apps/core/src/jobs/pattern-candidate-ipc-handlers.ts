import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { applyPatternCandidateChoice } from '../memory/pattern-candidate-decision.js';
import { buildProactiveSurfacingMetricPayloads } from '../runtime/proactive-surfacing-metrics.js';
import {
  isPatternActionKind,
  type PatternActionKind,
} from '../shared/pattern-candidate-action-kind.js';
import { nowIso } from '../shared/time/datetime.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';
import {
  acceptPatternCandidateForAction,
  candidateBelongsToRequest,
} from './pattern-candidate-skill-proposal.js';

type PatternCandidateRuntimeDeps = {
  getStorage: () => {
    repositories: {
      patternCandidates?: PatternCandidateRepository;
    };
  };
};

let runtimeDeps: PatternCandidateRuntimeDeps | null = null;

export function configurePatternCandidateIpcHandlers(
  deps: PatternCandidateRuntimeDeps,
): void {
  runtimeDeps = deps;
}

function getRuntimeDeps(): PatternCandidateRuntimeDeps {
  if (!runtimeDeps) {
    throw new Error('Pattern candidate IPC handlers are not configured.');
  }
  return runtimeDeps;
}

const NON_SKILL_ACCEPT_ACTION_KINDS = new Set<PatternActionKind>([
  'scheduler_job',
  'durable_capability',
  'memory_update',
]);

function isNonSkillAcceptActionKind(
  value: unknown,
): value is PatternActionKind {
  return isPatternActionKind(value) && NON_SKILL_ACCEPT_ACTION_KINDS.has(value);
}

async function publishAcceptedMetric(input: {
  context: Parameters<TaskHandler>[0];
  candidate: NonNullable<
    Awaited<ReturnType<PatternCandidateRepository['getById']>>
  >;
  targetJid: string;
}): Promise<void> {
  const { data, deps } = input.context;
  if (!deps.publishRuntimeEvent || !data.appId) return;
  const payloads = buildProactiveSurfacingMetricPayloads({
    subjectId: input.candidate.subjectId,
    candidates: [
      {
        signature: input.candidate.signature,
        status: 'accepted',
      },
    ],
    outcome: 'accepted',
  });
  for (const payload of payloads) {
    await deps
      .publishRuntimeEvent({
        appId: data.appId as never,
        agentId: input.candidate.agentId as never,
        ...(data.runId ? { runId: data.runId as never } : {}),
        conversationId: input.targetJid as never,
        ...(data.authThreadId ? { threadId: data.authThreadId as never } : {}),
        eventType: RUNTIME_EVENT_TYPES.PROACTIVE_SURFACING_OUTCOME,
        actor: 'runtime',
        responseMode: 'none',
        payload,
      })
      .catch(() => undefined);
  }
}

export const patternCandidateDecisionHandler: TaskHandler = async (context) => {
  const { accept, reject } = createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
  const { data, sourceAgentFolder } = context;
  const payload = data.payload || {};
  if (!data.appId) {
    reject(
      'Pattern candidate decisions require signed app scope.',
      'forbidden',
    );
    return;
  }
  const patternCandidateId = toTrimmedString(payload.patternCandidateId, {
    maxLen: 512,
  });
  const choice = toTrimmedString(payload.choice, { maxLen: 32 });
  const actionKind = toTrimmedString(payload.actionKind, { maxLen: 64 });
  if (!patternCandidateId) {
    reject('Missing required field: patternCandidateId.', 'invalid_request');
    return;
  }
  if (choice !== 'accept' && choice !== 'not_now' && choice !== 'dismiss') {
    reject('Invalid pattern candidate decision.', 'invalid_request');
    return;
  }
  const targetJid = data.targetJid || data.chatJid || '';
  if (!context.sourceAgentFolderJids.includes(targetJid)) {
    reject(
      'Pattern candidate decision must target a chat bound to the requesting agent.',
      'forbidden',
    );
    return;
  }
  const repo = getRuntimeDeps().getStorage().repositories.patternCandidates;
  if (!repo) {
    reject(
      'Pattern candidate repository is not available.',
      'preflight_failed',
    );
    return;
  }
  const candidate = await repo.getById(patternCandidateId);
  const agentId = memoryAgentIdForWorkspaceFolder(sourceAgentFolder);
  if (!candidate) {
    reject('Pattern candidate is not valid for this request.', 'forbidden');
    return;
  }
  if (
    !candidateBelongsToRequest({
      candidate,
      appId: data.appId,
      agentId,
      targetJid,
      memoryUserId: data.memoryUserId,
    })
  ) {
    reject('Pattern candidate is not valid for this request.', 'forbidden');
    return;
  }
  if (choice === 'accept') {
    if (!isNonSkillAcceptActionKind(actionKind)) {
      reject(
        'Pattern accept decisions require actionKind scheduler_job, durable_capability, or memory_update.',
        'invalid_request',
      );
      return;
    }
    const accepted = await acceptPatternCandidateForAction({
      repo,
      candidateId: patternCandidateId,
      appId: data.appId,
      sourceAgentFolder,
      targetJid,
      memoryUserId: data.memoryUserId,
      actionKind,
    });
    if (!accepted.ok) {
      reject(accepted.error, accepted.code);
      return;
    }
    await publishAcceptedMetric({ context, candidate, targetJid });
    accept(
      'Pattern acceptance recorded.',
      'pattern_candidate_acceptance_recorded',
    );
    return;
  }
  const transitioned = await applyPatternCandidateChoice({
    repo,
    candidateId: patternCandidateId,
    choice,
    nowIso: nowIso(),
  });
  if (!transitioned) {
    reject(
      'Pattern candidate is no longer available for this request.',
      'invalid_state',
    );
    return;
  }
  accept('Pattern decision recorded.', 'pattern_candidate_decision_recorded');
};
