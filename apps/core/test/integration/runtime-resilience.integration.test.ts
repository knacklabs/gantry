import fs from 'fs';
import path from 'path';

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
    trigger: '@Andy',
    requiresTrigger: true,
  });
}

function authedPayload(
  harness: Awaited<ReturnType<typeof createHermeticRuntimeHarness>>,
  sourceGroup: string,
  payload: Record<string, unknown>,
) {
  return {
    authToken: harness.authTokenFor(sourceGroup),
    ...payload,
  };
}

describe('real-world runtime trust-boundary and resilience integration scenarios', () => {
  it('archives malformed IPC while continuing to process adjacent valid files in the same namespace', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeRawFile('team', 'messages', '000-partial.json', '{"type":');
    harness.writeRawFile(
      'team',
      'messages',
      '001-valid.json',
      JSON.stringify(
        authedPayload(harness, 'team', {
          type: 'message',
          chatJid: 'tg:team',
          text: 'valid message after malformed neighbor',
        }),
      ),
    );

    await harness.waitFor(() =>
      harness.channel.outbound.some(
        (msg) => msg.text === 'valid message after malformed neighbor',
      ),
    );

    expect(
      harness.listIpcErrorFiles().some((file) => file.includes('partial')),
    ).toBe(true);
    expect(harness.listIpcFiles('team', 'messages')).toHaveLength(0);
  });

  it('ignores IPC file churn while processing valid message payloads in the same namespace', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeRawFile('team', 'messages', 'README.txt', 'operator note');
    harness.writeRawFile(
      'team',
      'messages',
      '002-still-writing.json.tmp',
      JSON.stringify(
        authedPayload(harness, 'team', {
          type: 'message',
          chatJid: 'tg:team',
          text: 'temporary payload should not be sent',
        }),
      ),
    );
    harness.writeRawFile(
      'team',
      'messages',
      '003-partial.json',
      '{"authToken":',
    );
    harness.writeRawFile(
      'team',
      'messages',
      '004-valid.json',
      JSON.stringify(
        authedPayload(harness, 'team', {
          type: 'message',
          chatJid: 'tg:team',
          text: 'valid message after IPC file churn',
        }),
      ),
    );

    await harness.waitFor(() =>
      harness.channel.outbound.some(
        (msg) => msg.text === 'valid message after IPC file churn',
      ),
    );

    expect(
      harness.channel.outbound.some((msg) =>
        msg.text.includes('temporary payload should not be sent'),
      ),
    ).toBe(false);
    expect(
      harness.listIpcErrorFiles().some((file) => file.includes('003-partial')),
    ).toBe(true);
    expect(harness.listIpcFiles('team', 'messages')).toEqual([
      '002-still-writing.json.tmp',
      'README.txt',
    ]);
  });

  it('rejects path traversal and unusual folder identifiers before filesystem registration side effects', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'register_agent',
      taskId: 'unsafe-folder-registration',
      jid: 'tg:evil',
      name: 'Evil',
      folder: '../escaped/怪しい',
      trigger: 'Evil',
    });

    await harness.waitFor(() =>
      Boolean(
        harness.readIpcJson(
          'main',
          'task-responses',
          'task-unsafe-folder-registration.json',
        ),
      ),
    );

    expect(harness.app.getRegisteredGroups()['tg:evil']).toBeUndefined();
    expect(fs.existsSync(path.join(harness.runtimeHome, 'escaped'))).toBe(
      false,
    );
    expect(
      harness.readIpcJson<{ ok: boolean; error?: string }>(
        'main',
        'task-responses',
        'task-unsafe-folder-registration.json',
      ),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('Invalid agent folder'),
      }),
    );
  });

  it('keeps raw auth tokens and secret-looking IPC values out of user-visible side effects on auth failure', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    const leakedToken = 'super-secret-auth-token-should-not-surface';
    harness.writeRawFile(
      'team',
      'messages',
      'secret-auth-failure.json',
      JSON.stringify({
        authToken: leakedToken,
        type: 'message',
        chatJid: 'tg:team',
        text: 'token-bearing unauthorized message',
      }),
    );

    await harness.waitFor(() =>
      harness.listIpcErrorFiles().some((file) => file.includes('secret-auth')),
    );

    expect(
      harness.channel.outbound.some((msg) => msg.text.includes(leakedToken)),
    ).toBe(false);
    expect(harness.fakeAgent.invocations).toHaveLength(0);
    expect(harness.listIpcErrorFiles().join('\n')).not.toContain(leakedToken);
  });

  it('archives invalid-auth interaction IPC without calling channel interaction surfaces', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeRawFile(
      'team',
      'permission-requests',
      'unauthorized-permission.json',
      JSON.stringify({
        requestId: 'unauthorized-permission',
        toolName: 'Write',
        toolInput: { file: 'prod.env' },
      }),
    );
    harness.writeRawFile(
      'team',
      'user-questions',
      'unauthorized-question.json',
      JSON.stringify({
        requestId: 'unauthorized-question',
        title: 'Confirm action',
        questions: [
          {
            question: 'Confirm action?',
            header: 'Confirm',
            multiSelect: false,
            options: [
              { label: 'Yes', description: 'Approve' },
              { label: 'No', description: 'Deny' },
            ],
          },
        ],
      }),
    );

    await harness.waitFor(
      () =>
        harness
          .listIpcErrorFiles()
          .some((file) => file.includes('unauthorized-permission')) &&
        harness
          .listIpcErrorFiles()
          .some((file) => file.includes('unauthorized-question')),
    );

    expect(harness.channel.permissionRequests).toHaveLength(0);
    expect(harness.channel.userQuestions).toHaveLength(0);
    expect(harness.listIpcFiles('team', 'permission-responses')).toHaveLength(
      0,
    );
    expect(harness.listIpcFiles('team', 'user-answers')).toHaveLength(0);
  });

  it('rejects unknown IPC task actions with no scheduler, channel, or group side effects', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writeIpcTaskRequest('main', {
      type: 'scheduler_destroy_everything',
      taskId: 'unknown-task-action',
      jobId: 'should-not-exist',
    });

    await harness.waitFor(
      () => harness.listIpcFiles('main', 'tasks').length === 0,
    );

    expect(harness.db.getJobById('should-not-exist')).toBeUndefined();
    expect(harness.channel.outbound).toHaveLength(0);
    expect(harness.app.getRegisteredGroups()['tg:main']).toBeTruthy();
  });

  it('[BUG-TEST-003-IPC-ROOT-LOCK] creates a single-consumer lock when the IPC watcher starts', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    harness.startIpcWatcher();

    expect(
      fs.existsSync(path.join(harness.runtimeHome, 'data', 'ipc', '.lock')),
    ).toBe(true);
  });

  it('reclaims a stale IPC root lock and continues permission/question delivery', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: () => ({
          approved: true,
          decidedBy: 'ops-admin',
          reason: 'stale lock recovered',
        }),
        userAnswer: (request) => ({
          requestId: request.requestId,
          answers: { Confirm: 'Yes' },
          answeredBy: 'ops-admin',
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    const lockPath = path.join(harness.runtimeHome, 'data', 'ipc', '.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        startedAt: '2026-04-17T17:47:47.631Z',
      }),
    );

    harness.startIpcWatcher();
    harness.writePermissionRequest('team', {
      requestId: 'stale-lock-permission',
      toolName: 'Write',
      toolInput: { cmd: 'echo test' },
    });
    harness.writeUserQuestionRequest('team', {
      requestId: 'stale-lock-question',
      questions: [
        {
          header: 'Confirm',
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Cancel' },
          ],
        },
      ],
    });

    await harness.waitFor(
      () =>
        Boolean(
          harness.readIpcJson(
            'team',
            'permission-responses',
            'stale-lock-permission.json',
          ),
        ) &&
        Boolean(
          harness.readIpcJson(
            'team',
            'user-answers',
            'stale-lock-question.json',
          ),
        ),
    );

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(harness.channel.permissionRequests).toHaveLength(1);
    expect(harness.channel.userQuestions).toHaveLength(1);
  });

  it('bounds large permission payloads before channel rendering', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: () => ({
          approved: false,
          decidedBy: 'admin',
          reason: 'bounded input reviewed',
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writePermissionRequest('team', {
      requestId: 'oversized-permission',
      toolName: 'Write',
      toolInput: {
        content: 'x'.repeat(100_000),
        nested: { value: ['y'.repeat(50_000)] },
      },
    });

    await harness.waitFor(
      () => harness.channel.permissionRequests.length === 1,
    );

    const renderedInput = JSON.stringify(
      harness.channel.permissionRequests[0]?.request.toolInput,
    );
    expect(renderedInput.length).toBeLessThanOrEqual(8_192);
  });

  it('[BUG-TEST-003-CORRELATION-TTL] discards stale permission and user-question response replays after a request has completed', async () => {
    const harness = await createHermeticRuntimeHarness({
      fakeChannel: {
        permissionDecision: () => ({
          approved: true,
          decidedBy: 'first-admin',
          reason: 'first decision',
        }),
        userAnswer: (request) => ({
          requestId: request.requestId,
          answers: { 'Proceed?': 'Yes' },
          answeredBy: 'first-admin',
        }),
      },
    });
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);
    harness.startIpcWatcher();

    harness.writePermissionRequest('team', {
      requestId: 'replay-permission',
      toolName: 'Read',
    });
    harness.writeUserQuestionRequest('team', {
      requestId: 'replay-question',
      questions: [
        {
          question: 'Proceed?',
          header: 'Decision',
          options: [
            { label: 'Yes', description: 'Proceed' },
            { label: 'No', description: 'Stop' },
          ],
        },
      ],
    });

    await harness.waitFor(
      () =>
        Boolean(
          harness.readIpcJson(
            'team',
            'permission-responses',
            'replay-permission.json',
          ),
        ) &&
        Boolean(
          harness.readIpcJson('team', 'user-answers', 'replay-question.json'),
        ),
    );

    const permissionResponsePath = path.join(
      harness.groupIpcDir('team', 'permission-responses'),
      'replay-permission.json',
    );
    const questionResponsePath = path.join(
      harness.groupIpcDir('team', 'user-answers'),
      'replay-question.json',
    );
    expect(() =>
      fs.writeFileSync(
        permissionResponsePath,
        JSON.stringify({
          requestId: 'replay-permission',
          approved: false,
          decidedBy: 'replay-attacker',
        }),
      ),
    ).toThrow();
    expect(() =>
      fs.writeFileSync(
        questionResponsePath,
        JSON.stringify({
          requestId: 'replay-question',
          answers: { 'Proceed?': 'No' },
          answeredBy: 'replay-attacker',
        }),
      ),
    ).toThrow();

    expect(
      harness.readIpcJson<{ approved: boolean; decidedBy?: string }>(
        'team',
        'permission-responses',
        'replay-permission.json',
      ),
    ).toEqual(
      expect.objectContaining({
        approved: true,
        decidedBy: 'first-admin',
      }),
    );
    expect(
      harness.readIpcJson<{ answers: Record<string, string> }>(
        'team',
        'user-answers',
        'replay-question.json',
      )?.answers,
    ).toEqual({ 'Proceed?': 'Yes' });
  });

  it('refuses IPC namespace directories replaced by symlinks after validation', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);
    registerMainAndTeam(harness);

    const outside = path.join(harness.runtimeHome, 'outside-ipc-target');
    fs.mkdirSync(outside, { recursive: true });
    const messagesDir = harness.groupIpcDir('team', 'messages');
    fs.mkdirSync(path.dirname(messagesDir), { recursive: true });
    fs.symlinkSync(outside, messagesDir, 'dir');

    harness.startIpcWatcher();
    fs.writeFileSync(
      path.join(outside, 'symlink-message.json'),
      JSON.stringify(
        authedPayload(harness, 'team', {
          type: 'message',
          chatJid: 'tg:team',
          text: 'message through symlinked namespace',
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(harness.channel.outbound).toHaveLength(0);
    expect(harness.listIpcErrorFiles()).toHaveLength(0);
  });
});
