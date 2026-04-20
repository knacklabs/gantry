import { afterEach, describe, expect, it } from 'vitest';

import { createHermeticRuntimeHarness } from '../harness/runtime-harness.js';

const activeHarnesses: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.cleanup();
  }
});

describe('runtime IPC recovery integration', () => {
  it('processes stale claimed message IPC files on the next watcher pass', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:main',
      name: 'Main',
      folder: 'main',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });

    harness.writeRawFile(
      'main',
      'messages',
      '.processing-stale-message.json',
      JSON.stringify({
        authToken: harness.authTokenFor('main'),
        type: 'message',
        chatJid: 'tg:main',
        text: 'recovered stale claimed message',
      }),
    );
    harness.startIpcWatcher();

    await harness.waitFor(() =>
      harness.channel.outbound.some(
        (message) => message.text === 'recovered stale claimed message',
      ),
    );
    expect(harness.listIpcFiles('main', 'messages')).toHaveLength(0);
  });

  it('archives malformed runner-adjacent IPC files without blocking valid files in the same namespace', async () => {
    const harness = await createHermeticRuntimeHarness();
    activeHarnesses.push(harness);

    harness.registerGroup({
      jid: 'tg:main',
      name: 'Main',
      folder: 'main',
      trigger: 'Andy',
      isMain: true,
      requiresTrigger: false,
    });

    harness.writeRawFile('main', 'messages', 'bad.json', '{not-json');
    harness.writeRawFile(
      'main',
      'messages',
      'good.json',
      JSON.stringify({
        authToken: harness.authTokenFor('main'),
        type: 'message',
        chatJid: 'tg:main',
        text: 'valid message after malformed file',
      }),
    );
    harness.startIpcWatcher();

    await harness.waitFor(
      () =>
        harness.listIpcErrorFiles().some((file) => file.includes('bad.json')) &&
        harness.channel.outbound.some(
          (message) => message.text === 'valid message after malformed file',
        ),
    );
  });
});
