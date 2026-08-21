import { randomUUID } from 'node:crypto';

import type { SchedulerDependencies } from '../../jobs/types.js';
import { resolveJobNotificationRoutes } from '../../jobs/job-notification-routes.js';
import type { ProgressUpdateOptions } from '../../domain/types.js';
import type { ChannelWiring } from './channel-wiring-types.js';

export function createSchedulerLifecycleNotificationUpdater(input: {
  channelWiring: Pick<ChannelWiring, 'sendProgressUpdate'>;
}): Pick<
  SchedulerDependencies,
  | 'captureLifecycleNotification'
  | 'discardLifecycleNotification'
  | 'updateLifecycleNotification'
> {
  type LifecycleCapture = {
    identities: Map<
      string,
      { progressCardIdentity: string; generation: number } | undefined
    >;
    terminalSummary?: string;
  };
  const capturesByRun = new Map<string, LifecycleCapture>();

  const captureLifecycleNotification: NonNullable<
    SchedulerDependencies['captureLifecycleNotification']
  > = async ({ job, runId }) => {
    if (job.silent) return;
    const identities = new Map<
      string,
      { progressCardIdentity: string; generation: number } | undefined
    >();
    const capture: LifecycleCapture = { identities };
    capturesByRun.set(runId, capture);
    const routes = resolveJobNotificationRoutes(job);
    const cardToken = randomUUID();
    const generation = lifecycleGeneration(cardToken);
    await Promise.all(
      routes.map(async (route, index) => {
        const key = routeKey(route);
        const progressCardIdentity = `scheduler-card:${cardToken}:${index}`;
        try {
          const created = await input.channelWiring.sendProgressUpdate(
            route.conversationJid,
            `Running: ${job.name}.`,
            {
              ...routeOptions(route),
              progressCardIdentity,
              generation,
            },
          );
          if (created !== false) {
            if (capture.terminalSummary === undefined) {
              identities.set(key, { progressCardIdentity, generation });
            } else {
              await input.channelWiring.sendProgressUpdate(
                route.conversationJid,
                capture.terminalSummary,
                {
                  ...routeOptions(route),
                  done: true,
                  replaceOnly: true,
                  progressCardIdentity,
                  generation,
                },
              );
            }
          }
        } catch {
          // A terminal notification will be sent separately when card creation fails.
        }
      }),
    );
  };

  const updateLifecycleNotification: NonNullable<
    SchedulerDependencies['updateLifecycleNotification']
  > = async ({ job, runId, summaryMessage }) => {
    const routes = resolveJobNotificationRoutes(job);
    const capture = capturesByRun.get(runId);
    if (capture) capture.terminalSummary = summaryMessage;
    const outcomes = await Promise.all(
      routes.map(async (route) => {
        const key = routeKey(route);
        const identity = capture?.identities.get(key);
        if (!identity) {
          return { route, status: 'unsupported' } as const;
        }
        try {
          const updated = await input.channelWiring.sendProgressUpdate(
            route.conversationJid,
            summaryMessage,
            {
              ...routeOptions(route),
              done: true,
              replaceOnly: true,
              progressCardIdentity: identity.progressCardIdentity,
              generation: identity.generation,
            },
          );
          const outcome = {
            route,
            status: updated === true ? 'updated' : 'unsupported',
          } as const;
          return outcome;
        } catch {
          return { route, status: 'failed' } as const;
        }
      }),
    );
    if (capture) {
      for (const outcome of outcomes) {
        if (outcome.status === 'updated') {
          capture.identities.delete(routeKey(outcome.route));
        }
      }
      if (capture.identities.size === 0) capturesByRun.delete(runId);
    }
    return outcomes;
  };

  return {
    captureLifecycleNotification,
    discardLifecycleNotification: (runId) => {
      capturesByRun.delete(runId);
    },
    updateLifecycleNotification,
  };
}

function lifecycleGeneration(runId: string): number {
  let hash = 0xcbf29ce484222325n;
  const mask = (1n << 53n) - 1n;
  for (const character of runId) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & mask;
  }
  return Number(hash);
}

function routeOptions(route: {
  threadId: string | null;
  providerAccountId?: string;
}): ProgressUpdateOptions {
  return {
    threadId: route.threadId ?? undefined,
    providerAccountId: route.providerAccountId,
  };
}

function routeKey(route: {
  conversationJid: string;
  threadId: string | null;
  providerAccountId?: string;
}): string {
  return `${route.conversationJid}\u0000${route.threadId ?? ''}\u0000${route.providerAccountId ?? ''}`;
}
