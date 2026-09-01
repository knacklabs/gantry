import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

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

const CHECKPOINT_WAIT_MS = 30_000;
const HUMAN_INTERACTION_WAIT_MS = 30 * 60_000 + 20_000;
const CAPTCHA_SETTLE_WAIT_MS = 30_000;

const humanInteractionSchema = z.object({
  toolName: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/u),
  toolInput: z.record(z.string(), z.unknown()),
  browserChallenge: z
    .object({
      challengeId: z.string().min(1).max(512),
      answerResultField: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
    })
    .optional(),
});

export function registerJobCheckpointTools(server: McpServer): void {
  server.tool(
    'job_checkpoint_status',
    'Read the latest durable semantic checkpoint and immutable artifact scope for this scheduled job.',
    {},
    async () => requestCheckpoint('job_checkpoint_status', {}),
  );
  server.tool(
    'job_checkpoint_save',
    'Save one durable semantic milestone for this scheduled job. Save semantic boundaries, not individual tool actions.',
    {
      idempotencyKey: z.string().min(1).max(512),
      expectedPreviousSequence: z.number().int().nonnegative(),
      milestone: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
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
      evaluatorInvocationRef: z.string().min(1).max(512).nullable().optional(),
      pendingInteractionRef: z.string().min(1).max(512).nullable().optional(),
      humanInteraction: humanInteractionSchema.optional(),
      nextAction: z.string().min(1).max(2_000),
      cumulativeRuntimeMs: z.number().int().nonnegative(),
    },
    async (args) => {
      if (args.humanInteraction?.browserChallenge) {
        const evidence = captchaEvidenceForChallenge(
          args.humanInteraction.browserChallenge.challengeId,
        );
        if (!evidence) {
          return repairableErrorResult(
            'Correct and retry this tool call: browserChallenge must reference an active challenge created by browser_captcha_challenge.',
          );
        }
        args.humanInteraction.browserChallenge.challengeId =
          evidence.challengeId;
        args.humanInteraction.toolInput = {
          ...args.humanInteraction.toolInput,
          challengeFingerprint: evidence.challengeFingerprint,
          automaticAttemptEvidenceRef: evidence.automaticAttemptEvidenceRef,
          evidenceRefs: [
            ...new Set([
              ...stringArray(args.humanInteraction.toolInput.evidenceRefs),
              evidence.screenshotEvidenceRef,
              evidence.automaticAttemptEvidenceRef,
            ]),
          ],
        };
      }
      const pendingInteractionRef = args.humanInteraction
        ? `interaction_${randomUUID()}`
        : undefined;
      const idempotencyKey = args.humanInteraction?.browserChallenge
        ? `browser-challenge:${createHash('sha256').update(args.humanInteraction.browserChallenge.challengeId).digest('hex')}`
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
  const response = await submitTaskLifecycleDataRequest({
    type: 'caller_resolved_tool',
    payload: {
      toolName: interaction.toolName,
      toolInput: interaction.toolInput,
      interactionId,
      ...(interaction.browserChallenge
        ? { captchaChallengeId: interaction.browserChallenge.challengeId }
        : {}),
    },
    responseTimeoutMs: HUMAN_INTERACTION_WAIT_MS,
  });
  if (!response?.ok) {
    return errorResult(
      response?.error ?? response?.message ?? 'Human interaction failed.',
    );
  }
  if (!interaction.browserChallenge) {
    const resolvedCheckpoint = await saveResolvedHumanInteractionCheckpoint(
      checkpoint,
      checkpointInput,
      'Caller-resolved interaction completed; continue the agent workflow.',
    );
    return {
      content: [
        ...checkpoint.content,
        ...resolvedCheckpoint.content,
        {
          type: 'text' as const,
          text: 'Caller-resolved interaction completed.',
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
  const answerValue =
    resolution[interaction.browserChallenge.answerResultField];
  const answer = typeof answerValue === 'string' ? answerValue.trim() : '';
  if (!answer) {
    return errorResult(
      `Caller-resolved browser challenge returned no ${interaction.browserChallenge.answerResultField}.`,
    );
  }
  const settled = await settleCaptchaChallenge(
    interaction.browserChallenge.challengeId,
    answer,
    CAPTCHA_SETTLE_WAIT_MS,
    'human',
    typeof interaction.toolInput.automaticAttemptEvidenceRef === 'string'
      ? interaction.toolInput.automaticAttemptEvidenceRef
      : undefined,
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
    'Caller-resolved browser challenge answer was submitted; inspect the bound browser and continue.',
  );
  return {
    ...settled,
    content: [
      ...checkpoint.content,
      ...resolvedCheckpoint.content,
      {
        type: 'text' as const,
        text: 'Caller-resolved browser challenge answer submitted in the bound browser session.',
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
    milestone: 'interaction_resolution_failed',
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
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
