import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

function registerMainAndTeam(
  harness: Awaited<ReturnType<typeof createHermeticRuntimeHarness>>,
) {
  harness.registerGroup({
    jid: 'tg:main',
    name: 'Main',
    folder: 'main',
    trigger: 'Andy',
    isMain: true,
    requiresTrigger: false,
  });
  harness.registerGroup({
    jid: 'tg:team',
    name: 'Team',
    folder: 'team',
    trigger: 'Bot',
    requiresTrigger: true,
  });
}

describe('runtime interactive IPC integration', () => {
  it('routes permission requests through the host approval surface and writes approval responses', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: (_jid, request) => ({
          approved: true,
          decidedBy: 'admin-user',
          reason: `approved ${request.toolName}`,
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writePermissionRequest('team', {
      requestId: 'perm-001',
      toolName: 'Bash',
      title: 'Run command',
      displayName: 'Bash',
      description: 'Needs command approval',
      decisionReason: 'agent requested a command',
      blockedPath: '/tmp/example',
      toolInput: {
        cmd: 'npm test',
        nested: { keep: true },
        large: 'x'.repeat(10_000),
      },
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson('team', 'permission-responses', 'perm-001.json'),
      ),
    );
    expect(harness.channel.permissionRequests).toHaveLength(1);
    expect(harness.channel.permissionRequests[0]?.request).toEqual(
      expect.objectContaining({
        requestId: 'perm-001',
        sourceGroup: 'team',
        toolName: 'Bash',
        blockedPath: '/tmp/example',
      }),
    );
    const response = harness.readIpcJson<{
      requestId: string;
      approved: boolean;
      decidedBy?: string;
      reason?: string;
    }>('team', 'permission-responses', 'perm-001.json');
    expect(response).toEqual({
      requestId: 'perm-001',
      approved: true,
      decidedBy: 'admin-user',
      reason: 'approved Bash',
    });
  });

  it('fails permission requests closed when payloads are malformed or approval surfaces throw', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: () => {
          throw new Error('surface unavailable');
        },
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writePermissionRequest('team', {
      requestId: 'perm-002',
    });
    harness.writePermissionRequest('team', {
      requestId: 'perm-003',
      toolName: 'Write',
    });

    await harness.waitFor(
      () =>
        harness.listIpcErrorFiles().some((file) => file.startsWith('team-')) &&
        Boolean(
          harness.readIpcJson('team', 'permission-responses', 'perm-003.json'),
        ),
    );

    expect(
      harness.readIpcJson('team', 'permission-responses', 'perm-002.json'),
    ).toBeUndefined();
    expect(
      harness.readIpcJson<{ approved: boolean }>(
        'team',
        'permission-responses',
        'perm-003.json',
      )?.approved,
    ).toBe(false);
  });

  it('routes structured user questions and writes sanitized answer responses', async () => {
    const longAnswer = 'a'.repeat(800);
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        userAnswer: (_jid, request) => ({
          requestId: request.requestId,
          answers: {
            'Choose one?': longAnswer,
            'Choose many?': [
              'Alpha',
              'b'.repeat(500),
              123 as unknown as string,
            ],
          },
          answeredBy: 'admin-user',
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeUserQuestionRequest('team', {
      requestId: 'userq-001',
      questions: [
        {
          question: 'Choose one?',
          header: 'Choice',
          multiSelect: false,
          options: [
            { label: 'Alpha', description: 'Use alpha' },
            { label: 'Beta', description: 'Use beta' },
          ],
        },
        {
          question: 'Choose many?',
          header: 'Modes',
          multiSelect: true,
          options: [
            { label: 'One', description: 'First' },
            { label: 'Two', description: 'Second' },
          ],
        },
      ],
    });

    await harness.waitFor(() =>
      Boolean(harness.readIpcJson('team', 'user-answers', 'userq-001.json')),
    );

    expect(harness.channel.userQuestions).toHaveLength(1);
    expect(harness.channel.userQuestions[0]?.request.questions).toHaveLength(2);
    const response = harness.readIpcJson<{
      requestId: string;
      answers: Record<string, string | string[]>;
      answeredBy?: string;
    }>('team', 'user-answers', 'userq-001.json');
    expect(response?.requestId).toBe('userq-001');
    expect(response?.answeredBy).toBe('admin-user');
    expect((response?.answers['Choose one?'] as string).length).toBe(500);
    expect(response?.answers['Choose many?']).toEqual([
      'Alpha',
      'b'.repeat(200),
    ]);
  });

  it('archives malformed user question requests as IPC errors and skips user-answers output', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeUserQuestionRequest('team', {
      requestId: 'userq-002',
      questions: [
        {
          question: 'Bad question?',
          header: 'Bad',
          multiSelect: false,
          options: [{ label: 'Only', description: 'Not enough options' }],
        },
      ],
    });

    await harness.waitFor(() =>
      harness.listIpcErrorFiles().some((file) => file.startsWith('team-')),
    );
    expect(
      harness.readIpcJson('team', 'user-answers', 'userq-002.json'),
    ).toBeUndefined();
    expect(harness.channel.userQuestions).toHaveLength(0);
  });

  it('archives unauthenticated IPC requests across message, task, memory, permission, and question namespaces', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: () => ({
          approved: true,
          decidedBy: 'should-not-be-called',
        }),
        userAnswer: (request) => ({
          requestId: request.requestId,
          answers: { 'Should not ask?': 'No' },
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcMessageRequest(
      'team',
      {
        chatJid: 'tg:team',
        text: 'unauthenticated message',
      },
      { auth: false },
    );
    harness.writeIpcTaskRequest(
      'team',
      {
        type: 'scheduler_upsert_job',
        jobId: 'unauthenticated-job',
        name: 'Unauthenticated Job',
        prompt: 'should not exist',
        scheduleType: 'once',
        scheduleValue: new Date().toISOString(),
        deliverTo: ['tg:team'],
        groupScope: 'team',
      },
      { auth: false },
    );
    harness.writeMemoryRequest(
      'team',
      {
        requestId: 'memory-unauthenticated',
        action: 'memory_search',
        payload: { query: 'anything' },
      },
      { auth: false },
    );
    harness.writePermissionRequest(
      'team',
      {
        requestId: 'perm-unauthenticated',
        toolName: 'Bash',
      },
      { auth: false },
    );
    harness.writeUserQuestionRequest(
      'team',
      {
        requestId: 'question-unauthenticated',
        questions: [
          {
            question: 'Should not ask?',
            header: 'NoAsk',
            options: [
              { label: 'Yes', description: '' },
              { label: 'No', description: '' },
            ],
          },
        ],
      },
      { auth: false },
    );

    await harness.waitFor(() => harness.listIpcErrorFiles().length >= 5);

    expect(harness.channel.outbound).toHaveLength(0);
    expect(harness.db.getJobById('unauthenticated-job')).toBeUndefined();
    expect(
      harness.readIpcJson(
        'team',
        'memory-responses',
        'memory-unauthenticated.json',
      ),
    ).toBeUndefined();
    expect(
      harness.readIpcJson(
        'team',
        'permission-responses',
        'perm-unauthenticated.json',
      ),
    ).toBeUndefined();
    expect(
      harness.readIpcJson(
        'team',
        'user-answers',
        'question-unauthenticated.json',
      ),
    ).toBeUndefined();
    expect(harness.channel.permissionRequests).toHaveLength(0);
    expect(harness.channel.userQuestions).toHaveLength(0);
  });

  it('fails closed for permission denials and preserves decision metadata', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: (_jid, request) => ({
          approved: false,
          decidedBy: 'security-reviewer',
          reason: `denied ${request.toolName}`,
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writePermissionRequest('team', {
      requestId: 'perm-denied',
      toolName: 'Write',
      toolInput: {
        content: 'x'.repeat(20_000),
      },
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson('team', 'permission-responses', 'perm-denied.json'),
      ),
    );

    expect(harness.channel.permissionRequests[0]?.request.toolInput).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/^x+/),
      }),
    );
    const response = harness.readIpcJson<{
      approved: boolean;
      decidedBy?: string;
      reason?: string;
    }>('team', 'permission-responses', 'perm-denied.json');
    expect(response).toEqual({
      requestId: 'perm-denied',
      approved: false,
      decidedBy: 'security-reviewer',
      reason: 'denied Write',
    });
  });

  it('[BUG-TEST-002-PERM-DUP] does not overwrite a permission decision when a duplicate request id arrives later', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: (_jid, request) => ({
          approved: request.toolName === 'Read',
          decidedBy: 'admin-user',
          reason: request.toolName === 'Read' ? 'first decision' : 'duplicate',
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writePermissionRequest('team', {
      requestId: 'dup-permission',
      toolName: 'Read',
    });
    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson(
          'team',
          'permission-responses',
          'dup-permission.json',
        ),
      ),
    );

    harness.writePermissionRequest('team', {
      requestId: 'dup-permission',
      toolName: 'Write',
    });
    await harness.waitFor(
      () => harness.channel.permissionRequests.length === 2,
    );

    const response = harness.readIpcJson<{
      approved: boolean;
      reason?: string;
    }>('team', 'permission-responses', 'dup-permission.json');
    expect(response).toEqual(
      expect.objectContaining({
        approved: true,
        reason: 'first decision',
      }),
    );
  });

  it('[BUG-TEST-002-QUESTION-DUP] does not overwrite a user answer when a duplicate request id arrives later', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        userAnswer: (_jid, request) => ({
          requestId: request.requestId,
          answers: {
            [request.questions[0]?.question ?? 'unknown']: 'Alpha',
          },
          answeredBy: 'admin-user',
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeUserQuestionRequest('team', {
      requestId: 'dup-question',
      questions: [
        {
          question: 'First question?',
          header: 'First',
          options: [
            { label: 'Alpha', description: 'First option' },
            { label: 'Beta', description: 'Second option' },
          ],
        },
      ],
    });
    await harness.waitFor(() =>
      Boolean(harness.readIpcJson('team', 'user-answers', 'dup-question.json')),
    );

    harness.writeUserQuestionRequest('team', {
      requestId: 'dup-question',
      questions: [
        {
          question: 'Second question?',
          header: 'Second',
          options: [
            { label: 'Gamma', description: 'Third option' },
            { label: 'Delta', description: 'Fourth option' },
          ],
        },
      ],
    });
    await harness.waitFor(() => harness.channel.userQuestions.length === 2);

    const response = harness.readIpcJson<{
      answers: Record<string, string | string[]>;
    }>('team', 'user-answers', 'dup-question.json');
    expect(response?.answers).toEqual({
      'First question?': 'Alpha',
    });
  });
});
