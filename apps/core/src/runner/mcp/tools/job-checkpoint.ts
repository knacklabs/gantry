import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

const CHECKPOINT_WAIT_MS = 30_000;

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
            contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            kind: z.string().min(1).max(120),
          }),
        )
        .max(64),
      evaluatorInvocationRef: z.string().min(1).max(512).optional(),
      pendingInteractionRef: z.string().min(1).max(512).optional(),
      nextAction: z.string().min(1).max(2_000),
      cumulativeRuntimeMs: z.number().int().nonnegative(),
    },
    async (args) => requestCheckpoint('job_checkpoint_save', args),
  );
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
    return errorResult(response?.error || 'Job checkpoint request failed.');
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
