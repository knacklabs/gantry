import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import { configureSetupPausePermissionPrompt } from '@core/application/jobs/setup-pause-permission-prompt.js';
import type {
  JobSetupRequiredNotificationInput,
  JobSetupRequiredNotificationPort,
} from '@core/application/jobs/job-management-types.js';
import type {
  JobUpsertInput,
  RuntimeJobRepository,
} from '@core/domain/repositories/ops-repo.js';
import type { Job, MessageSendOptions } from '@core/domain/types.js';
import {
  notifyCreatedJobSetupRequired,
  notifyJobSetupRequired,
} from '@core/jobs/execution-readiness.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';

afterEach(() => {
  configureSetupPausePermissionPrompt(null);
});

describe('job creation', () => {
  it('blocked job fires exactly one actionable setup card and one event', async () => {
    let persistedJob: Job | undefined;
    let finishCardDelivery: (() => void) | undefined;
    const cardDelivery = new Promise<void>((resolve) => {
      finishCardDelivery = resolve;
    });
    const sendMessage = vi.fn(
      async (_jid: string, _text: string, _options?: MessageSendOptions) =>
        cardDelivery,
    );
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const notificationTasks: Promise<boolean>[] = [];
    const claimAt = '2026-08-09T00:00:00.000Z';
    const ops = {
      upsertJob: vi.fn(async (input: JobUpsertInput) => {
        persistedJob = persistedJobFrom(input);
        return { created: true };
      }),
      getJobById: vi.fn(async () => persistedJob),
      markJobSetupNotified: vi.fn(
        async (_jobId: string, expectedFingerprint: string) => {
          if (!persistedJob?.setup_state) return null;
          if (
            persistedJob.setup_state.notified_fingerprint ===
            expectedFingerprint
          ) {
            return null;
          }
          persistedJob = {
            ...persistedJob,
            setup_state: {
              ...persistedJob.setup_state,
              notified_fingerprint: expectedFingerprint,
              notify_claim_at: claimAt,
            },
          };
          return claimAt;
        },
      ),
      confirmJobSetupNotified: vi.fn(
        async (_jobId: string, expectedFingerprint: string, token: string) => {
          if (
            persistedJob?.setup_state?.notified_fingerprint ===
              expectedFingerprint &&
            persistedJob.setup_state.notify_claim_at === token
          ) {
            persistedJob.setup_state.notify_claim_at = null;
          }
        },
      ),
      clearJobSetupNotified: vi.fn(
        async (_jobId: string, expectedFingerprint: string, token: string) => {
          if (
            persistedJob?.setup_state?.notified_fingerprint ===
              expectedFingerprint &&
            persistedJob.setup_state.notify_claim_at === token
          ) {
            persistedJob.setup_state.notified_fingerprint = null;
            persistedJob.setup_state.notify_claim_at = null;
          }
        },
      ),
    };
    const setupRequiredNotifications: JobSetupRequiredNotificationPort = {
      notify: (input: JobSetupRequiredNotificationInput) => {
        notificationTasks.push(
          notifyCreatedJobSetupRequired({
            jobId: input.jobId,
            deps: { sendMessage, opsRepository: ops },
            runtimeAppId: input.appId,
            appSession: input.appSession
              ? {
                  ...input.appSession,
                  defaultResponseMode:
                    input.appSession.defaultResponseMode ?? null,
                }
              : undefined,
            publishRuntimeEvent,
          }),
        );
      },
    };
    const service = new JobManagementService({
      ops: ops as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      control: {
        getAppSessionById: vi.fn(async () => ({
          sessionId: 'session-1',
          appId: 'app-1',
          conversationJid: 'tg:team',
          workspaceKey: 'team',
          defaultResponseMode: 'immediate',
          defaultWebhookId: null,
        })),
        getAppSessionsByIds: vi.fn(async () => []),
        getAppSessionByChatJid: vi.fn(async () => undefined),
        createJobTrigger: vi.fn(),
        markTriggerCompleted: vi.fn(),
        getTriggerById: vi.fn(),
      },
      toolRepository: {
        listAgentToolBindings: vi.fn(async () => []),
      } as never,
      setupRequiredNotifications,
      runtimeEvents: { publish: vi.fn(async () => undefined) },
      clock: { now: () => '2026-08-09T00:00:00.000Z' },
    });

    await expect(
      service.createJob({
        appId: 'app-1',
        name: 'Research digest',
        prompt: 'Research the latest changes.',
        sessionId: 'session-1',
        accessRequirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
        kind: 'recurring',
        schedule: { type: 'interval', value: '60000' },
      }),
    ).resolves.toMatchObject({ created: true });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      expect.stringContaining('Approve Browser access, then resume the job.'),
    );

    finishCardDelivery?.();
    await Promise.all(notificationTasks);

    expect(publishRuntimeEvent).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'job.setup_required',
        payload: expect.objectContaining({ notified: true }),
      }),
    );

    await notifyJobSetupRequired({
      currentJob: persistedJob!,
      deps: { sendMessage, opsRepository: ops },
      runtimeAppId: 'app-1',
      setupState: persistedJob!.setup_state!,
      publishRuntimeEvent,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledTimes(2);
  });
});

describe('notifyJobSetupRequired', () => {
  it('routes a detached creation notification by the reloaded job session', async () => {
    const job = setupBlockedJob('session-2');
    const sendMessage = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const opsRepository = {
      getJobById: vi.fn(async () => job),
      markJobSetupNotified: vi.fn(async () => '2026-08-09T00:00:00.000Z'),
      confirmJobSetupNotified: vi.fn(async () => undefined),
      clearJobSetupNotified: vi.fn(async () => undefined),
    };
    const control = {
      getAppSessionById: vi.fn(async () => ({
        sessionId: 'session-2',
        appId: 'app-2',
        defaultResponseMode: 'immediate' as const,
        defaultWebhookId: null,
      })),
    };

    await notifyCreatedJobSetupRequired({
      jobId: job.id,
      deps: { sendMessage, opsRepository, control },
      runtimeAppId: 'app-1',
      appSession: {
        sessionId: 'session-1',
        appId: 'app-1',
        defaultResponseMode: null,
        defaultWebhookId: null,
      },
      publishRuntimeEvent,
    });

    expect(control.getAppSessionById).toHaveBeenCalledWith('session-2');
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-2', sessionId: 'session-2' }),
    );
  });
});

function setupBlockedJob(sessionId: string | null = 'session-1'): Job {
  return {
    ...persistedJobFrom({
      id: 'job-setup',
      name: 'Setup blocked',
      prompt: 'Use the customer records server.',
      schedule_type: 'interval',
      schedule_value: '60000',
      workspace_key: 'team',
      session_id: sessionId,
      notification_routes: [
        {
          conversationJid: 'tg:team',
          threadId: null,
          label: 'Team',
        },
      ],
    }),
    status: 'paused',
    pause_reason: 'Setup required',
    setup_state: {
      state: 'missing_capability',
      checked_at: '2026-08-09T00:00:00.000Z',
      fingerprint: 'mcp:customer-records',
      blockers: [
        {
          state: 'missing_capability',
          requirementType: 'mcp_server',
          requirementId: 'customer-records',
          message: 'Server missing.',
          nextAction: 'Connect the server.',
        },
      ],
    },
  };
}

function persistedJobFrom(input: JobUpsertInput): Job {
  return {
    ...input,
    status: input.status ?? 'active',
    session_id: input.session_id ?? null,
    thread_id: input.thread_id ?? null,
    created_by: input.created_by ?? 'human',
    created_at: input.created_at ?? '2026-08-09T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-08-09T00:00:00.000Z',
    next_run: input.next_run ?? null,
    last_run: input.last_run ?? null,
    silent: input.silent ?? false,
    cleanup_after_ms: input.cleanup_after_ms ?? 0,
    timeout_ms: input.timeout_ms ?? 300_000,
    max_retries: input.max_retries ?? 0,
    retry_backoff_ms: input.retry_backoff_ms ?? 0,
    max_consecutive_failures: input.max_consecutive_failures ?? 3,
    consecutive_failures: input.consecutive_failures ?? 0,
    lease_run_id: input.lease_run_id ?? null,
    lease_expires_at: input.lease_expires_at ?? null,
    pause_reason: input.pause_reason ?? null,
  };
}
