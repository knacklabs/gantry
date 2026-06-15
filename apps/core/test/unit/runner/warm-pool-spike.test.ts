import { afterEach, describe, expect, it } from 'vitest';

import {
  baseInput,
  createRunnerFixture,
  readRecord,
  registerRunnerFixtureCleanup,
  runRunner,
} from './agent-runner-ipc.test-helpers.js';

registerRunnerFixtureCleanup(afterEach);

const SPIKE_TIMEOUT_MS = 35_000;

describe('warm-pool spike: SDK warm primitive', () => {
  it(
    'boots via startup() and serves one query() with no re-spawn (F10)',
    async () => {
      const fx = createRunnerFixture();
      // GANTRY_WARM_POOL_BOOT=generic makes the runner take the startup() path
      // (Task 1.2). The bind is delivered via GANTRY_SPIKE_BIND (test-only fast
      // path; production uses the IPC bind channel).
      await runRunner(fx, baseInput({ warmGenericBoot: true }), {
        GANTRY_WARM_POOL: '1',
        GANTRY_SPIKE_BIND: JSON.stringify({
          chatJid: 'wa:111',
          firstMessage: 'do you have kaju katli?',
          memoryBlock: '',
        }),
      });
      const rec = readRecord(fx.recordPath);
      expect(rec.startupCalls).toBe(1); // startup() invoked once
      expect(rec.calls.length).toBe(1); // exactly one query() = no re-spawn
      expect(rec.warmQueryDoubleCallThrew).toBe(true); // single-use enforced
    },
    SPIKE_TIMEOUT_MS,
  );
});
