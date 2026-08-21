import { describe, expect, it, vi } from 'vitest';

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
    // A group turn resolves no memory person (locked ID-1 DM boundary), so its
    // created job is shared (null).
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
});

function access(conversationKind: 'dm' | 'channel', personId: string | null) {
  const conversationJid = conversationKind === 'dm' ? 'tg:alice' : 'tg:team';
  // The acting person is the creating turn's resolved memory identity — the
  // same source personal memory trusts, and null for a non-DM/ineligible turn.
  return schedulerAccessFromContext({
    data: {
      type: 'scheduler_upsert_job',
      chatJid: conversationJid,
      ...(personId ? { memoryUserId: personId } : {}),
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
