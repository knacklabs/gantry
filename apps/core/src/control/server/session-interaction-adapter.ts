import { createHash, randomUUID } from 'node:crypto';

import { SessionInteractionModule } from '../../application/sessions/session-interaction-module.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { adaptSessionControlPort } from './session-control-port.js';
import type { ControlRouteContext } from './handler-context.js';
import { nowIso } from '../../shared/time/datetime.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../../application/jobs/job-access.js';

export type SessionEventSubscription = Awaited<
  ReturnType<SessionInteractionModule['subscribeEvents']>
>;

export function createSessionInteractionModule(
  input: {
    liveAdmissionAppId?: string | null;
    getConfiguredAgentRuntime?: ControlRouteContext['getConfiguredAgentRuntime'];
  } = {},
): SessionInteractionModule {
  return new SessionInteractionModule({
    control: adaptSessionControlPort(getRuntimeControlRepository()),
    ops: getRuntimeRepositories(),
    repositories: getRuntimeStorage().repositories,
    runtimeEvents: getRuntimeEventExchange(),
    liveAdmissionAppId: input.liveAdmissionAppId,
    getConfiguredAgentRuntime: input.getConfiguredAgentRuntime,
    now: () => nowIso() as never,
    createId: randomUUID,
    stableHash: (input) => createHash('sha256').update(input).digest('hex'),
  });
}

export async function ensureSessionForControl(
  ctx: ControlRouteContext,
  input: Parameters<SessionInteractionModule['ensureSession']>[0],
): Promise<Awaited<ReturnType<SessionInteractionModule['ensureSession']>>> {
  const result = await createSessionInteractionModule().ensureSession(input);
  await ctx.app.registerGroup(
    result.registerGroup.conversationJid,
    result.registerGroup.group,
  );
  return result;
}

export async function acceptMessageForControl(
  ctx: ControlRouteContext,
  input: Parameters<SessionInteractionModule['acceptMessage']>[0],
): Promise<Awaited<ReturnType<SessionInteractionModule['acceptMessage']>>> {
  const accepted = await createSessionInteractionModule({
    liveAdmissionAppId:
      ctx.liveTurnsEnabled === false ? null : DEFAULT_JOB_RUNTIME_APP_ID,
    getConfiguredAgentRuntime: ctx.getConfiguredAgentRuntime,
  }).acceptMessage(input);
  if (!accepted.enqueue.durableAdmissionCreated) {
    ctx.app.queue.enqueueMessageCheck(accepted.enqueue.queueKey);
  }
  return accepted;
}
