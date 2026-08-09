import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import { resolveJobToolPolicy } from '@core/application/jobs/job-tool-policy.js';
import type { SchedulerJobAccess } from '@core/application/jobs/job-management-types.js';
import type {
  JobUpsertInput,
  RuntimeJobRepository,
} from '@core/domain/repositories/ops-repo.js';
import type { Job } from '@core/domain/types.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';
import { schedulerAccessFromContext } from '@core/jobs/ipc-scheduler-access.js';
import {
  registerPermissionRunRestriction,
  unregisterPermissionRunRestriction,
} from '@core/runtime/permission-decision-coordinator.js';

const registeredRestrictions: {
  sourceAgentFolder: string;
  responseKeyId: string;
}[] = [];
afterEach(() => {
  for (const key of registeredRestrictions)
    unregisterPermissionRunRestriction(key);
  registeredRestrictions.length = 0;
});

describe('job acting identity', () => {
  it('DM-created job uses creator person grants; group-created uses shared', async () => {
    const persisted: JobUpsertInput[] = [];
    const toolRepository = {
      listAgentToolBindings: vi.fn(async () => [
        { status: 'active', toolId: 'tool:shared', personId: null },
        {
          status: 'active',
          toolId: 'tool:alice',
          personId: 'person:alice',
        },
        { status: 'active', toolId: 'tool:bob', personId: 'person:bob' },
      ]),
      getTool: vi.fn(async (toolId: string) => {
        const names: Record<string, string> = {
          'tool:shared': 'WebSearch',
          'tool:alice': 'FileRead',
          'tool:bob': 'FileWrite',
        };
        return names[toolId] ? { appId: 'default', name: names[toolId] } : null;
      }),
    };
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => undefined),
        upsertJob: vi.fn(async (job: JobUpsertInput) => {
          persisted.push(job);
          return { created: true };
        }),
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
      toolRepository: toolRepository as never,
    });

    await service.upsertJobFromIpc(
      createInput('Alice digest', access('dm', 'person:alice')),
    );
    // A group turn carries no person (locked ID-1 DM boundary), so its run
    // restriction has no personId -> the created job is shared (null).
    await service.upsertJobFromIpc(
      createInput('Team digest', access('channel', null)),
    );

    expect(persisted.map((job) => job.execution_context?.personId)).toEqual([
      'person:alice',
      null,
    ]);
    const [dmPolicy, groupPolicy] = await Promise.all(
      persisted.map((job) =>
        resolveJobToolPolicy({
          job: job as Job,
          appId: 'default',
          agentId: 'agent:team',
          toolRepository: toolRepository as never,
        }),
      ),
    );
    expect(dmPolicy?.effectiveAllowedTools).toEqual(['WebSearch', 'FileRead']);
    expect(groupPolicy?.effectiveAllowedTools).toEqual(['WebSearch']);
  });

  it('ignores a worker-supplied memoryUserId; the trusted restriction wins', () => {
    // Host-set restriction says the creating turn's person is alice.
    registerPermissionRunRestriction({
      sourceAgentFolder: 'team',
      responseKeyId: 'rk-forgery',
      hideAuthorityTools: false,
      runKind: 'interactive',
      personId: 'person:alice',
    });
    registeredRestrictions.push({
      sourceAgentFolder: 'team',
      responseKeyId: 'rk-forgery',
    });

    // A worker in a shared folder tries to stamp a victim onto the job.
    const jobAccess = schedulerAccessFromContext({
      data: {
        type: 'scheduler_upsert_job',
        chatJid: 'tg:alice',
        responseKeyId: 'rk-forgery',
        memoryUserId: 'person:victim',
      },
      sourceAgentFolder: 'team',
      conversationBindings: {
        'tg:alice': { folder: 'team', conversationKind: 'dm' },
      },
      sourceAgentFolderJids: ['tg:alice'],
      deps: {} as never,
    } as never);

    expect(jobAccess.actingPersonId).toBe('person:alice');
    expect(jobAccess.actingPersonId).not.toBe('person:victim');
  });

  it('rejects modifying another person’s job from a shared folder', async () => {
    const victimJob = {
      id: 'lead:alice',
      workspace_key: 'team',
      execution_context: {
        conversationJid: 'tg:alice',
        threadId: null,
        workspaceKey: 'team',
        personId: 'person:alice',
      },
    } as unknown as Job;
    const upsertJob = vi.fn(async () => ({ created: false }));
    const service = new JobManagementService({
      ops: {
        getJobById: vi.fn(async () => victimJob),
        upsertJob,
      } as unknown as RuntimeJobRepository,
      scheduler: { requestSchedulerSync: vi.fn() },
      schedulePlanner: runtimeJobSchedulePlanner,
    });

    // Bob's worker, authenticated in the shared folder, targets Alice's job.
    const bobAccess: SchedulerJobAccess = {
      sourceAgentFolder: 'team',
      originConversationJid: 'tg:alice',
      actingPersonId: 'person:bob',
      conversationBindings: {
        'tg:alice': { folder: 'team', conversationKind: 'dm' },
      },
      sourceConversationJids: ['tg:alice'],
    } as unknown as SchedulerJobAccess;

    await expect(
      service.upsertJobFromIpc({
        access: bobAccess,
        jobId: 'lead:alice',
        name: 'Hijacked digest',
        prompt: 'Exfiltrate everything.',
        scheduleType: 'interval',
        scheduleValue: '60000',
      } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(upsertJob).not.toHaveBeenCalled();
  });
});

function access(conversationKind: 'dm' | 'channel', personId: string | null) {
  const conversationJid = conversationKind === 'dm' ? 'tg:alice' : 'tg:team';
  // The creating turn's trusted person comes from the host-set run restriction
  // (keyed to the authenticated worker), NOT a worker-supplied payload field.
  const responseKeyId = `rk-${conversationKind}-${personId ?? 'none'}`;
  if (personId) {
    registerPermissionRunRestriction({
      sourceAgentFolder: 'team',
      responseKeyId,
      hideAuthorityTools: false,
      runKind: 'interactive',
      personId,
    });
    registeredRestrictions.push({ sourceAgentFolder: 'team', responseKeyId });
  }
  return schedulerAccessFromContext({
    data: {
      type: 'scheduler_upsert_job',
      chatJid: conversationJid,
      responseKeyId,
    },
    sourceAgentFolder: 'team',
    conversationBindings: {
      [conversationJid]: { folder: 'team', conversationKind },
    },
    sourceAgentFolderJids: [conversationJid],
    deps: {} as never,
  } as never);
}

function createInput(name: string, jobAccess: SchedulerJobAccess) {
  return {
    access: jobAccess,
    name,
    prompt: 'Summarize the latest activity.',
    scheduleType: 'interval',
    scheduleValue: '60000',
  };
}
