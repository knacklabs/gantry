import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskContext, TaskIpcData } from '@core/jobs/ipc-types.js';

const mocks = vi.hoisted(() => ({
  responder: {
    accept: vi.fn(),
    acceptData: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock('@core/jobs/ipc-shared.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/jobs/ipc-shared.js')
  >('@core/jobs/ipc-shared.js');
  return {
    ...actual,
    createTaskResponder: vi.fn(() => mocks.responder),
  };
});

import {
  configureProactiveSurfacingConsentIpcHandlers,
  proactiveSurfacingConsentHandler,
} from '@core/jobs/proactive-surfacing-consent-ipc-handlers.js';

function makeRepo() {
  return {
    getBySubject: vi.fn(async () => null),
    setEnabled: vi.fn(async (input: unknown) => ({
      id: 'ps_row',
      ...(input as object),
    })),
    setOptedOut: vi.fn(async () => null),
  };
}

function makeContext(data: Partial<TaskIpcData> = {}): TaskContext {
  return {
    data: {
      type: 'proactive_surfacing_consent',
      taskId: 'task-1',
      appId: 'app:test',
      chatJid: 'sl:C123',
      targetJid: 'sl:C123',
      memoryUserId: 'U123',
      payload: {
        choice: 'enable',
        conversationKind: 'channel',
      },
      ...data,
    },
    sourceAgentFolder: 'main_agent',
    conversationBindings: {},
    sourceAgentFolderJids: ['sl:C123'],
    deps: {} as never,
  };
}

beforeEach(() => {
  mocks.responder.accept.mockReset();
  mocks.responder.acceptData.mockReset();
  mocks.responder.reject.mockReset();
});

describe('proactiveSurfacingConsentHandler', () => {
  it('records an enable decision only when a real user reply is present', async () => {
    const repo = makeRepo();
    configureProactiveSurfacingConsentIpcHandlers({
      getStorage: () => ({ repositories: { proactiveSurfacing: repo } }),
    });

    await proactiveSurfacingConsentHandler(makeContext());

    expect(repo.setEnabled).toHaveBeenCalledTimes(1);
    expect(repo.setEnabled.mock.calls[0]?.[0]).toMatchObject({
      subject: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        subjectType: 'channel',
        subjectId: 'conversation:sl:C123',
      },
      id: expect.stringMatching(/^ps_[a-f0-9]{64}$/),
      actorId: 'U123',
      nowIso: expect.any(String),
    });
    expect(repo.setOptedOut).not.toHaveBeenCalled();
    expect(mocks.responder.accept).toHaveBeenCalledWith(
      'Proactive surfacing enabled.',
      'proactive_surfacing_enabled',
    );
  });

  it('records opt-out with the latest turn user id as actor', async () => {
    const repo = makeRepo();
    configureProactiveSurfacingConsentIpcHandlers({
      getStorage: () => ({ repositories: { proactiveSurfacing: repo } }),
    });

    await proactiveSurfacingConsentHandler(
      makeContext({
        payload: {
          choice: 'opt_out',
          conversationKind: 'dm',
        },
      }),
    );

    expect(repo.setOptedOut).toHaveBeenCalledTimes(1);
    expect(repo.setOptedOut.mock.calls[0]?.[0]).toMatchObject({
      subject: {
        appId: 'app:test',
        agentId: 'agent:main_agent',
        subjectType: 'user',
        subjectId: 'U123',
      },
      actorId: 'U123',
      nowIso: expect.any(String),
    });
    expect(repo.setEnabled).not.toHaveBeenCalled();
    expect(mocks.responder.accept).toHaveBeenCalledWith(
      'Proactive surfacing opted out.',
      'proactive_surfacing_opted_out',
    );
  });

  it('rejects hallucinated consent without a real latest-turn user id', async () => {
    const repo = makeRepo();
    configureProactiveSurfacingConsentIpcHandlers({
      getStorage: () => ({ repositories: { proactiveSurfacing: repo } }),
    });

    await proactiveSurfacingConsentHandler(
      makeContext({
        memoryUserId: undefined,
      }),
    );

    expect(mocks.responder.reject).toHaveBeenCalledWith(
      'Proactive surfacing consent change requires a real user reply this turn.',
      'forbidden',
    );
    expect(repo.setEnabled).not.toHaveBeenCalled();
    expect(repo.setOptedOut).not.toHaveBeenCalled();
  });
});
