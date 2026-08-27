import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { JOB_SEMANTIC_CHECKPOINT_MILESTONES } from '../../../domain/ports/job-semantic-checkpoints.js';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  chatJid,
  jobId,
  jobRunId,
  jobRunLeaseFencingVersion,
  jobRunLeaseToken,
  TASKS_DIR,
  threadId,
} from '../context.js';
import { makeIpcId } from '../ipc-ids.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';
import { submitTaskLifecycleDataRequest } from './task-lifecycle.js';
import {
  captchaEvidenceForChallenge,
  settleCaptchaChallenge,
} from './browser.js';
import { handleFileToolAction } from './file.js';

const CHECKPOINT_WAIT_MS = 30_000;
const HUMAN_INTERACTION_WAIT_MS = 30 * 60_000 + 20_000;
const CAPTCHA_SETTLE_WAIT_MS = 30_000;

const humanInteractionBase = {
  version: z.literal(2).default(2),
  requestId: z.string().min(1).max(200),
  attemptId: z.string().min(1).max(200),
  reason: z.string().min(1).max(2_000),
  checkpointRef: z.string().max(2_048).nullable().default(null),
  evidenceRefs: z.array(z.string().min(1).max(2_048)).max(100).default([]),
};

// Keep the provider-facing schema as one ordinary object. Nested unions are
// transported as JSON envelopes by strict OpenAI tool schemas, which makes the
// mounted MCP validator receive a string instead of the interaction object.
const humanInteractionSchema = z.object({
  ...humanInteractionBase,
  type: z.enum(['captcha', 'origin']),
  captchaChallengeId: z.string().min(1).max(512).optional(),
  challengeFingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .optional(),
  automaticAttemptEvidenceRef: z
    .string()
    .min(1)
    .max(2_048)
    .nullable()
    .optional()
    .default(null),
  permissionScope: z.object({
    origin: z.string().url().max(2_048).nullable(),
    methods: z.array(z.enum(['GET', 'HEAD'])).max(2),
  }),
});

export function registerJobCheckpointTools(server: McpServer): void {
  server.tool(
    'job_checkpoint_status',
    'Read the latest durable semantic checkpoint for this scheduled job and the immutable artifact scope to use for recipe-authoring artifacts.',
    {},
    async () => requestCheckpoint('job_checkpoint_status', {}),
  );
  server.tool(
    'job_checkpoint_save',
    'Save one durable semantic milestone for this scheduled job. Save only completed inventory, candidate, test-plan, evaluation, human-wait, runtime-boundary, or review milestones; never save individual browser actions.',
    {
      idempotencyKey: z.string().min(1).max(512),
      expectedPreviousSequence: z.number().int().nonnegative(),
      milestone: z.enum(JOB_SEMANTIC_CHECKPOINT_MILESTONES),
      safePhase: z.string().min(1).max(120),
      artifactRefs: z
        .array(
          z.object({
            artifactId: z.string().min(1).max(160),
            // Keep malformed model output inside the agentic repair loop. The
            // host remains authoritative and validates the exact SHA-256
            // contract before persisting the checkpoint.
            contentHash: z.string().min(1).max(80),
            kind: z.string().min(1).max(120),
          }),
        )
        .max(64),
      evaluatorInvocationRef: z.string().min(1).max(512).optional(),
      pendingInteractionRef: z.string().min(1).max(512).optional(),
      humanInteraction: humanInteractionSchema.optional(),
      nextAction: z.string().min(1).max(2_000),
      cumulativeRuntimeMs: z.number().int().nonnegative(),
    },
    async (args) => {
      const unresolvedCaptcha = await unresolvedCaptchaCheckpointError(args);
      if (unresolvedCaptcha) return repairableErrorResult(unresolvedCaptcha);
      if (args.humanInteraction?.type === 'captcha') {
        const evidence = captchaEvidenceForChallenge(
          args.humanInteraction.captchaChallengeId ?? '',
        );
        if (evidence) {
          args.humanInteraction.captchaChallengeId = evidence.challengeId;
          args.humanInteraction.challengeFingerprint =
            evidence.challengeFingerprint;
          args.humanInteraction.automaticAttemptEvidenceRef =
            evidence.automaticAttemptEvidenceRef;
          args.humanInteraction.evidenceRefs = [
            ...new Set([
              ...args.humanInteraction.evidenceRefs,
              evidence.screenshotEvidenceRef,
              evidence.automaticAttemptEvidenceRef,
            ]),
          ];
        }
      }
      if (args.milestone === 'human_wait' && !args.humanInteraction) {
        return repairableErrorResult(
          'human_wait requires humanInteraction so the checkpoint, typed administrator request, and same-session continuation remain atomic.',
        );
      }
      if (args.milestone !== 'human_wait' && args.humanInteraction) {
        return repairableErrorResult(
          'humanInteraction is valid only for a human_wait checkpoint.',
        );
      }
      if (
        args.humanInteraction?.type === 'captcha' &&
        (!args.humanInteraction.captchaChallengeId ||
          !args.humanInteraction.challengeFingerprint ||
          !args.humanInteraction.automaticAttemptEvidenceRef ||
          args.humanInteraction.permissionScope.origin !== null ||
          args.humanInteraction.permissionScope.methods.length !== 0)
      ) {
        return repairableErrorResult(
          'Correct and retry this tool call: CAPTCHA humanInteraction requires captchaChallengeId, challengeFingerprint, automaticAttemptEvidenceRef, permissionScope.origin=null, and permissionScope.methods=[].',
        );
      }
      if (
        args.humanInteraction?.type === 'origin' &&
        (!args.humanInteraction.permissionScope.origin ||
          args.humanInteraction.permissionScope.methods.length === 0 ||
          args.humanInteraction.automaticAttemptEvidenceRef !== null)
      ) {
        return repairableErrorResult(
          'Correct and retry this tool call: origin humanInteraction requires permissionScope.origin, one or both GET/HEAD methods, and automaticAttemptEvidenceRef=null.',
        );
      }
      const pendingInteractionRef = args.humanInteraction
        ? `interaction_${randomUUID()}`
        : undefined;
      const idempotencyKey =
        args.humanInteraction?.type === 'captcha'
          ? `captcha:${createHash('sha256').update(args.humanInteraction.captchaChallengeId!).digest('hex')}`
          : args.idempotencyKey;
      const checkpoint = await requestCheckpoint('job_checkpoint_save', {
        ...args,
        idempotencyKey,
        ...(pendingInteractionRef ? { pendingInteractionRef } : {}),
      });
      if (
        ('isError' in checkpoint && checkpoint.isError) ||
        !args.humanInteraction
      ) {
        return checkpoint;
      }
      return resolveHumanInteraction(
        checkpoint,
        args.humanInteraction,
        checkpointPendingInteractionRef(checkpoint) ?? pendingInteractionRef!,
        { ...args, idempotencyKey },
      );
    },
  );
}

const CAPTCHA_GATED_MILESTONES = new Set([
  'candidate_created',
  'candidate_repaired',
  'test_plan_created',
  'evaluation_submitted',
  'evaluation_analyzed',
  'needs_review',
]);

async function unresolvedCaptchaCheckpointError(args: {
  milestone: string;
  artifactRefs: Array<{ artifactId: string; kind: string }>;
}): Promise<string | null> {
  if (!CAPTCHA_GATED_MILESTONES.has(args.milestone)) return null;
  const inventories = args.artifactRefs.filter(
    (artifact) => artifact.kind === 'observation_inventory',
  );
  if (inventories.length === 0) return null;
  let captchaBlocked = false;
  let captchaUnproven = false;
  let captchaObserved = false;
  for (const inventory of inventories) {
    try {
      const parsed = JSON.parse(
        await handleFileToolAction({
          action: 'read',
          artifactId: inventory.artifactId,
        }),
      ) as { claims?: Array<{ capability?: unknown; status?: unknown }> };
      captchaBlocked ||= (parsed.claims ?? []).some(
        (claim) => claim.capability === 'captcha' && claim.status === 'blocked',
      );
      captchaUnproven ||= (parsed.claims ?? []).some(
        (claim) =>
          claim.capability === 'captcha' && claim.status === 'unproven',
      );
      captchaObserved ||= (parsed.claims ?? []).some(
        (claim) =>
          claim.capability === 'captcha' && claim.status === 'observed',
      );
    } catch {
      // The host still performs the authoritative artifact validation. Do not
      // turn a transient read failure into a false CAPTCHA claim.
    }
  }
  const attemptArtifacts = args.artifactRefs.filter(
    (artifact) =>
      artifact.kind === 'captcha_attempt' ||
      artifact.kind === 'captcha_automatic_attempt' ||
      artifact.kind === 'captcha_attempt_evidence' ||
      artifact.kind === 'captcha_success' ||
      artifact.kind === 'solved_automatic' ||
      artifact.kind === 'solved_human',
  );
  let solvedCaptcha = false;
  let completedAutomaticAttempts = false;
  for (const attempt of attemptArtifacts) {
    try {
      const parsed = JSON.parse(
        await handleFileToolAction({
          action: 'read',
          artifactId: attempt.artifactId,
        }),
      ) as { attemptNumber?: unknown; outcome?: unknown };
      solvedCaptcha ||=
        parsed.outcome === 'solved_automatic' ||
        parsed.outcome === 'solved_human';
      completedAutomaticAttempts ||= Number(parsed.attemptNumber) >= 4;
    } catch {
      // Invalid attempt evidence cannot satisfy either CAPTCHA gate.
    }
  }
  if (captchaObserved && !solvedCaptcha) {
    return 'The retained inventory marks CAPTCHA as observed, but this self-contained checkpoint does not include a typed solved_automatic or solved_human artifact proving that the protected surface opened. First call job_checkpoint_status and carry forward any valid captcha_success artifact retained by the latest durable checkpoint. Re-run browser_captcha_challenge with stable post-gate success_text or success_target evidence only when no valid solved artifact exists or fresh same-session browser state is required.';
  }
  if (!captchaBlocked && !captchaUnproven) return null;
  if (args.milestone === 'needs_review' && captchaUnproven && !captchaBlocked) {
    return null;
  }
  if (args.milestone === 'needs_review' && completedAutomaticAttempts)
    return null;
  return 'The retained observation inventory marks CAPTCHA as blocked or unproven. Do not author, compile, evaluate, or finalize a candidate yet. Reopen the protected surface in the current browser, call browser_captcha_challenge so Gantry performs the typed automatic solve attempts, and either replace the inventory with observed CAPTCHA-continuation evidence or create the atomic human_wait after attempt four.';
}

async function resolveHumanInteraction(
  checkpoint: Awaited<ReturnType<typeof requestCheckpoint>>,
  interaction: z.infer<typeof humanInteractionSchema>,
  interactionId: string,
  checkpointInput: {
    idempotencyKey: string;
    artifactRefs: Array<{
      artifactId: string;
      contentHash: string;
      kind: string;
    }>;
    cumulativeRuntimeMs: number;
  },
) {
  const toolInput =
    interaction.type === 'captcha'
      ? (({ captchaChallengeId: _captchaChallengeId, ...input }) => input)(
          interaction,
        )
      : interaction;
  const response = await submitTaskLifecycleDataRequest({
    type: 'caller_resolved_tool',
    payload: {
      toolName: 'website_recipe_request_human',
      toolInput,
      interactionId,
      ...(interaction.type === 'captcha' && interaction.captchaChallengeId
        ? { captchaChallengeId: interaction.captchaChallengeId }
        : {}),
    },
    responseTimeoutMs: HUMAN_INTERACTION_WAIT_MS,
  });
  if (!response?.ok) {
    return errorResult(
      response?.error ?? response?.message ?? 'Human interaction failed.',
    );
  }
  if (interaction.type === 'origin') {
    const resolvedCheckpoint = await saveResolvedHumanInteractionCheckpoint(
      checkpoint,
      checkpointInput,
      'Authorized origin interaction resolved; continue the agent workflow.',
    );
    return {
      content: [
        ...checkpoint.content,
        ...resolvedCheckpoint.content,
        {
          type: 'text' as const,
          text: 'Authorized origin interaction resolved.',
        },
      ],
    };
  }
  const resolution = record(response.data);
  const retryStatus =
    resolution.retryable === true && typeof resolution.status === 'string'
      ? resolution.status
      : '';
  if (retryStatus) {
    const nextAction =
      typeof resolution.nextAction === 'string' && resolution.nextAction.trim()
        ? resolution.nextAction.trim()
        : 'Correct the human-interaction request and retry from the same agent loop.';
    const correction = await compensateUnopenedHumanWait(
      checkpoint,
      checkpointInput,
      `${retryStatus}: ${nextAction}`,
    );
    return {
      content: [
        ...checkpoint.content,
        ...correction.content,
        {
          type: 'text' as const,
          text: `Human assistance was not opened (${retryStatus}). ${nextAction}`,
        },
      ],
    };
  }
  const answer =
    typeof resolution.humanAnswer === 'string'
      ? resolution.humanAnswer.trim()
      : '';
  if (!answer) {
    return errorResult('Authorized CAPTCHA interaction returned no answer.');
  }
  const settled = await settleCaptchaChallenge(
    interaction.captchaChallengeId!,
    answer,
    CAPTCHA_SETTLE_WAIT_MS,
    'human',
    interaction.automaticAttemptEvidenceRef,
  );
  if (settled.isError) {
    const reason =
      settled.content
        .filter(
          (item): item is { type: 'text'; text: string } =>
            item.type === 'text',
        )
        .map((item) => item.text)
        .join(' ') || 'CAPTCHA submission failed.';
    const correction = await compensateUnopenedHumanWait(
      checkpoint,
      checkpointInput,
      reason,
    );
    return {
      content: [
        ...checkpoint.content,
        ...correction.content,
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'captcha_retry_required',
            retryable: true,
            nextAction:
              'Capture the refreshed challenge, complete the required fresh automatic attempts, and create a new atomic human-wait checkpoint if still blocked.',
          }),
        },
      ],
    };
  }
  const resolvedCheckpoint = await saveResolvedHumanInteractionCheckpoint(
    checkpoint,
    checkpointInput,
    'Authorized CAPTCHA answer was submitted; inspect the bound browser and continue.',
  );
  return {
    ...settled,
    content: [
      ...checkpoint.content,
      ...resolvedCheckpoint.content,
      {
        type: 'text' as const,
        text: 'Authorized CAPTCHA answer submitted in the bound browser session.',
      },
      ...settled.content,
    ],
  };
}

async function saveResolvedHumanInteractionCheckpoint(
  checkpoint: Awaited<ReturnType<typeof requestCheckpoint>>,
  input: {
    idempotencyKey: string;
    artifactRefs: Array<{
      artifactId: string;
      contentHash: string;
      kind: string;
    }>;
    cumulativeRuntimeMs: number;
  },
  nextAction: string,
) {
  const sequence = checkpointSequence(checkpoint);
  if (sequence === undefined)
    return { content: [] as Array<{ type: 'text'; text: string }> };
  return requestCheckpoint('job_checkpoint_save', {
    idempotencyKey: `${input.idempotencyKey}:resolved`,
    expectedPreviousSequence: sequence,
    milestone: 'human_interaction_resolved',
    safePhase: 'human_interaction_resolved',
    artifactRefs: input.artifactRefs,
    nextAction,
    cumulativeRuntimeMs: input.cumulativeRuntimeMs,
  });
}

async function compensateUnopenedHumanWait(
  checkpoint: Awaited<ReturnType<typeof requestCheckpoint>>,
  input: {
    idempotencyKey: string;
    artifactRefs: Array<{
      artifactId: string;
      contentHash: string;
      kind: string;
    }>;
    cumulativeRuntimeMs: number;
  },
  reason: string,
) {
  const sequence = checkpointSequence(checkpoint);
  if (sequence === undefined)
    return { content: [] as Array<{ type: 'text'; text: string }> };
  return requestCheckpoint('job_checkpoint_save', {
    idempotencyKey: `${input.idempotencyKey}:interaction-not-opened`,
    expectedPreviousSequence: sequence,
    milestone: 'needs_review',
    safePhase: 'human_interaction_retry_required',
    artifactRefs: input.artifactRefs,
    nextAction: reason,
    cumulativeRuntimeMs: input.cumulativeRuntimeMs,
  });
}

async function requestCheckpoint(
  type: 'job_checkpoint_status' | 'job_checkpoint_save',
  payload: Record<string, unknown>,
) {
  if (!jobId || !jobRunId || !jobRunLeaseToken) {
    return errorResult('This tool requires an active scheduled job lease.');
  }
  const taskId = makeIpcId(type.replaceAll('_', '-'));
  writeIpcFile(TASKS_DIR, {
    type,
    taskId,
    jobId,
    runId: jobRunId,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE || undefined,
    runLeaseToken: jobRunLeaseToken,
    runLeaseFencingVersion:
      jobRunLeaseFencingVersion === undefined
        ? undefined
        : Number(jobRunLeaseFencingVersion),
    targetJid: chatJid,
    chatJid,
    authThreadId: threadId,
    payload,
    timestamp: nowIso(),
  });
  const response = await waitForTaskResponse(taskId, CHECKPOINT_WAIT_MS);
  if (!response?.ok) {
    const message = JSON.stringify({
      code: response?.code ?? 'checkpoint_failed',
      error: response?.error || 'Job checkpoint request failed.',
      details: response?.details ?? [],
    });
    return response?.code === 'invalid_checkpoint'
      ? repairableErrorResult(
          `Correct the checkpoint inputs and retry: ${message}`,
        )
      : errorResult(message);
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response.data ?? {}),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function repairableErrorResult(message: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'invalid_input',
          retryable: true,
          nextAction: message,
        }),
      },
    ],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checkpointPendingInteractionRef(
  checkpoint: Awaited<ReturnType<typeof requestCheckpoint>>,
): string | undefined {
  try {
    const text = checkpoint.content.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') return undefined;
    const response = record(JSON.parse(text));
    if (response.outcome !== 'replayed') return undefined;
    const ref = record(
      record(response.checkpoint).payload,
    ).pendingInteractionRef;
    return typeof ref === 'string' && ref ? ref : undefined;
  } catch {
    return undefined;
  }
}

function checkpointSequence(
  checkpoint: Awaited<ReturnType<typeof requestCheckpoint>>,
): number | undefined {
  try {
    const text = checkpoint.content.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') return undefined;
    const sequence = record(record(JSON.parse(text)).checkpoint).sequence;
    return Number.isSafeInteger(sequence) ? Number(sequence) : undefined;
  } catch {
    return undefined;
  }
}
