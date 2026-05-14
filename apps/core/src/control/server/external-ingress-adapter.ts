import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { ExternalIngressModule } from '../../application/external-ingress/external-ingress-module.js';
import { SessionInteractionModule } from '../../application/sessions/session-interaction-module.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { nowIso } from './app-identity.js';
import type { ControlRouteContext } from './handler-context.js';
import {
  TRIGGER_RATE_LIMIT_PER_APP,
  TRIGGER_RATE_LIMIT_PER_JOB,
} from './rate-limit.js';
import { adaptSessionControlPort } from './session-control-port.js';
import { createJobManagementService } from './routes/jobs.js';

export function createExternalIngressModule(
  ctx: ControlRouteContext,
): ExternalIngressModule {
  const control = getRuntimeControlRepository();
  const sessions = new SessionInteractionModule({
    control: adaptSessionControlPort(control),
    ops: getRuntimeRepositories(),
    repositories: getRuntimeStorage().repositories,
    runtimeEvents: getRuntimeEventExchange(),
    now: nowIso,
    createId: randomUUID,
    stableHash: (input) => createHash('sha256').update(input).digest('hex'),
  });
  return new ExternalIngressModule({
    control,
    sessions,
    jobs: createJobManagementService(ctx),
    now: nowIso,
    createSecret: () => randomBytes(32).toString('hex'),
    createInvocationId: randomUUID,
    signatureCrypto: nodeSignatureCrypto,
    consumeTriggerRateLimit: (key, limit) =>
      ctx.triggerRateLimiter.consume(key, limit),
    perAppTriggerLimit: TRIGGER_RATE_LIMIT_PER_APP,
    perJobTriggerLimit: TRIGGER_RATE_LIMIT_PER_JOB,
  });
}

export async function invokeExternalIngressForControl(
  ctx: ControlRouteContext,
  input: Parameters<ExternalIngressModule['invoke']>[0],
): Promise<Awaited<ReturnType<ExternalIngressModule['invoke']>>> {
  const result = await createExternalIngressModule(ctx).invoke(input);
  if (
    'registerGroup' in result &&
    result.registerGroup &&
    typeof result.registerGroup === 'object' &&
    'conversationJid' in result.registerGroup &&
    typeof result.registerGroup.conversationJid === 'string' &&
    'group' in result.registerGroup
  ) {
    await ctx.app.registerGroup(
      result.registerGroup.conversationJid,
      result.registerGroup.group as never,
    );
  }
  if (
    'enqueue' in result &&
    result.enqueue &&
    typeof result.enqueue === 'object' &&
    'queueKey' in result.enqueue &&
    typeof result.enqueue.queueKey === 'string'
  ) {
    ctx.app.queue.enqueueMessageCheck(result.enqueue.queueKey);
  }
  return result;
}

const nodeSignatureCrypto = {
  sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  },
  hmacSha256(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  },
  constantTimeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  },
};
