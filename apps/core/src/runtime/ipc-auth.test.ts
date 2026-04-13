import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getJobById,
  getRegisteredGroup,
  setRegisteredGroup,
  updateJob,
} from '../storage/db.js';
import { RegisteredGroup } from '../core/types.js';
import { IpcDeps, processTaskIpc } from './ipc.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onSchedulerChanged: vi.fn(),
  };
});

describe('register_group authorization', () => {
  it('main can register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group?.folder).toBe('new-group');
  });

  it('non-main cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'blocked@g.us',
        name: 'Blocked',
        folder: 'blocked-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    expect(getRegisteredGroup('blocked@g.us')).toBeUndefined();
  });
});

describe('scheduler authorization', () => {
  it('non-main cannot upsert cross-scope jobs', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        name: 'cross-scope',
        prompt: 'do work',
        schedule_type: 'interval',
        schedule_value: '60000',
        groupScope: 'third-group',
      },
      'other-group',
      false,
      deps,
    );

    expect(getJobById('cross-scope')).toBeUndefined();
  });

  it('non-main cannot upsert jobs with foreign linked sessions', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'job-foreign-link',
        name: 'cross-link',
        prompt: 'do work',
        schedule_type: 'interval',
        schedule_value: '60000',
        linkedSessions: ['other@g.us', 'third@g.us'],
      },
      'other-group',
      false,
      deps,
    );

    expect(getJobById('job-foreign-link')).toBeUndefined();
  });

  it('main can upsert cross-group jobs and trigger them', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'job-main-1',
        name: 'main-job',
        prompt: 'do work',
        schedule_type: 'interval',
        schedule_value: '60000',
        groupScope: 'other-group',
        linkedSessions: ['other@g.us'],
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getJobById('job-main-1')?.group_scope).toBe('other-group');

    await processTaskIpc(
      {
        type: 'scheduler_trigger_job',
        jobId: 'job-main-1',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const triggered = getJobById('job-main-1');
    expect(triggered?.status).toBe('active');
    expect(triggered?.next_run).toBeTruthy();
  });

  it('non-main cannot mutate jobs that include foreign linked sessions', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'job-mixed-links',
        name: 'mixed-links',
        prompt: 'do work',
        schedule_type: 'manual',
        schedule_value: '',
        linkedSessions: ['other@g.us', 'third@g.us'],
        groupScope: 'other-group',
      },
      'whatsapp_main',
      true,
      deps,
    );
    updateJob('job-mixed-links', { status: 'paused' });

    await processTaskIpc(
      {
        type: 'scheduler_resume_job',
        jobId: 'job-mixed-links',
      },
      'other-group',
      false,
      deps,
    );

    expect(getJobById('job-mixed-links')?.status).toBe('paused');
  });

  it('non-main cannot change group_scope during scheduler_update_job', async () => {
    await processTaskIpc(
      {
        type: 'scheduler_upsert_job',
        jobId: 'job-own',
        name: 'own-job',
        prompt: 'do work',
        schedule_type: 'manual',
        schedule_value: '',
      },
      'other-group',
      false,
      deps,
    );

    await processTaskIpc(
      {
        type: 'scheduler_update_job',
        jobId: 'job-own',
        groupScope: 'third-group',
      },
      'other-group',
      false,
      deps,
    );

    expect(getJobById('job-own')?.group_scope).toBe('other-group');
  });
});
