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
    const ops = {
      upsertJob: vi.fn(async (input: JobUpsertInput) => {
        persistedJob = persistedJobFrom(input);
        return { created: true };
      }),
      getJobById: vi.fn(async () => persistedJob),
      markJobSetupNotified: vi.fn(
        async (_jobId: string, expectedFingerprint: string) => {
          if (!persistedJob?.setup_state) return false;
          persistedJob = {
            ...persistedJob,
            setup_state: {
              ...persistedJob.setup_state,
              notified_fingerprint: expectedFingerprint,
            },
          };
          return true;
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
        payload: {
          setup_fingerprint: persistedJob!.setup_state!.fingerprint,
          blockers: [
            expect.objectContaining({
              id: 'Browser',
              action: expect.objectContaining({ kind: 'approve_grant' }),
            }),
          ],
        },
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

  it('publishes the durable setup event even when the card send throws', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('provider send failed');
    });
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const markJobSetupNotified = vi.fn(async () => true);
    const job: Job = persistedJobFrom({
      id: 'job-throw',
      name: 'Digest',
      prompt: 'x',
      model: 'gpt-5.6-sol',
      schedule_type: 'interval',
      schedule_value: '60000',
      workspace_key: 'team',
      notification_routes: [
        { conversationJid: 'tg:team', threadId: null, label: 'Owner' },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-08-09T00:00:00.000Z',
        fingerprint: 'fp-throw',
        notified_fingerprint: null,
        blockers: [
          {
            state: 'missing_capability',
            type: 'browser',
            id: 'Browser',
            summary: 'Needs Browser',
            action: {
              kind: 'approve_grant',
              grant: {
                type: 'addRules',
                behavior: 'allow',
                rules: [{ toolName: 'Browser' }],
              },
            },
          },
        ],
      },
    } as JobUpsertInput);

    const notified = await notifyJobSetupRequired({
      currentJob: job,
      deps: { sendMessage, opsRepository: { markJobSetupNotified } },
      runtimeAppId: 'app-1',
      setupState: job.setup_state!,
      publishRuntimeEvent,
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(notified).toBe(false);
    expect(markJobSetupNotified).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          setup_fingerprint: 'fp-throw',
          blockers: [
            expect.objectContaining({
              id: 'Browser',
              action: expect.objectContaining({ kind: 'approve_grant' }),
            }),
          ],
        },
      }),
    );
  });
});

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
