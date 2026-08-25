import { randomUUID } from 'node:crypto';

import type { SchedulerDependencies } from '../../jobs/types.js';
import { resolveJobNotificationRoutes } from '../../jobs/job-notification-routes.js';
import type { ProgressUpdateOptions } from '../../domain/types.js';
import type { ChannelWiring } from './channel-wiring-types.js';

let lastLifecycleGeneration = 0;

// Sinks seal the last done generation per route key and accept only greater values,
// so this must be monotonic, not a hash; Date.now() keeps it monotonic across restarts
// (sealed maps are in-memory) and the max(+1) keeps it strict within one process.
function nextLifecycleGeneration(): number {
  const next = Math.max(Date.now(), lastLifecycleGeneration + 1);
  lastLifecycleGeneration = next;
  return next;
}

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
    fallbackSent: Set<string>;
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
    const capture: LifecycleCapture = { identities, fallbackSent: new Set() };
    capturesByRun.set(runId, capture);
    const routes = resolveJobNotificationRoutes(job);
    const cardToken = randomUUID();
    const generation = nextLifecycleGeneration();
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
                capture.fallbackSent.has(key)
                  ? 'Done.'
                  : capture.terminalSummary,
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
          // The terminal update falls back to a fresh done message when no card lands.
        }
      }),
    );
  };

  const updateLifecycleNotification: NonNullable<
    SchedulerDependencies['updateLifecycleNotification']
  > = async ({ job, runId, summaryMessage }) => {
    const routes = resolveJobNotificationRoutes(job);
    const capture: LifecycleCapture = capturesByRun.get(runId) ?? {
      identities: new Map(),
      fallbackSent: new Set(),
      terminalSummary: summaryMessage,
    };
    capturesByRun.set(runId, capture);
    capture.terminalSummary = summaryMessage;
    const outcomes = await Promise.all(
      routes.map(async (route, index) => {
        const key = routeKey(route);
        const identity = capture.identities.get(key);
        if (!identity) {
          if (capture.fallbackSent.has(key)) {
            return { route, status: 'updated' } as const;
          }
          try {
            const sent = await input.channelWiring.sendProgressUpdate(
              route.conversationJid,
              summaryMessage,
              {
                ...routeOptions(route),
                done: true,
                progressCardIdentity: `scheduler-card:${randomUUID()}:${index}`,
                generation: nextLifecycleGeneration(),
              },
            );
            if (sent === true) capture.fallbackSent.add(key);
            return {
              route,
              status: sent === true ? 'updated' : 'unsupported',
            } as const;
          } catch {
            return { route, status: 'failed' } as const;
          }
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
    for (const outcome of outcomes) {
      if (outcome.status === 'updated') {
        capture.identities.delete(routeKey(outcome.route));
      }
    }
    if (capture.identities.size === 0 && capture.fallbackSent.size === 0) {
      capturesByRun.delete(runId);
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
