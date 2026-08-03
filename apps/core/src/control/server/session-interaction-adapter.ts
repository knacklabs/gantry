import { SessionInteractionModule } from '../../application/sessions/session-interaction-module.js';
import type { ControlRouteContext } from './handler-context.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../../application/jobs/job-access.js';

export type SessionEventSubscription = Awaited<
  ReturnType<SessionInteractionModule['subscribeEvents']>
>;

export async function ensureSessionForControl(
  ctx: ControlRouteContext,
  input: Parameters<SessionInteractionModule['ensureSession']>[0],
): Promise<Awaited<ReturnType<SessionInteractionModule['ensureSession']>>> {
  const result = await ctx.sessionInteraction.ensureSession(input);
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
  const accepted = await ctx.sessionInteraction.acceptMessage(
    input,
    ctx.liveTurnsEnabled === false ? null : DEFAULT_JOB_RUNTIME_APP_ID,
  );
  if (!accepted.enqueue.durableAdmissionCreated) {
    ctx.app.queue.enqueueMessageCheck(accepted.enqueue.queueKey);
  }
  return accepted;
}
