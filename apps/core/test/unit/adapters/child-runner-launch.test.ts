import { describe, expect, it } from 'vitest';

import {
  buildChildRunnerLaunch,
  type BuildChildRunnerLaunchInput,
} from '@core/adapters/llm/anthropic-claude-agent/child-runner-launch.js';

const DIST = '/root/dist/adapters/llm/anthropic-claude-agent/runner/index.js';
const SRC =
  '/root/apps/core/src/adapters/llm/anthropic-claude-agent/runner/index.ts';

function input(
  patch: Partial<BuildChildRunnerLaunchInput> = {},
): BuildChildRunnerLaunchInput {
  return {
    distRunnerPath: DIST,
    sourceRunnerPath: SRC,
    sourceExists: true,
    fromSourceFlag: undefined,
    inspectPortRaw: undefined,
    ...patch,
  };
}

describe('buildChildRunnerLaunch', () => {
  it('defaults to dist when the flag is unset', () => {
    const launch = buildChildRunnerLaunch(input());
    expect(launch.mode).toBe('dist');
    expect(launch.runnerArgs).toEqual([DIST]);
    expect(launch.inspectPort).toBeUndefined();
  });

  it('runs dist for falsy/explicitly-off flag values', () => {
    for (const flag of ['', '0', 'false', 'no', 'off', 'random']) {
      const launch = buildChildRunnerLaunch(input({ fromSourceFlag: flag }));
      expect(launch.mode, `flag=${flag}`).toBe('dist');
    }
  });

  it('launches from source via tsx with inspector on the default port when enabled', () => {
    const launch = buildChildRunnerLaunch(input({ fromSourceFlag: '1' }));
    expect(launch.mode).toBe('source');
    expect(launch.inspectPort).toBe(9230);
    expect(launch.runnerArgs).toEqual([
      '--import',
      'tsx',
      '--inspect-brk=127.0.0.1:9230',
      SRC,
    ]);
  });

  it('accepts the common truthy spellings of the flag', () => {
    for (const flag of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const launch = buildChildRunnerLaunch(input({ fromSourceFlag: flag }));
      expect(launch.mode, `flag=${flag}`).toBe('source');
    }
  });

  it('honors a custom inspector port override', () => {
    const launch = buildChildRunnerLaunch(
      input({ fromSourceFlag: 'true', inspectPortRaw: '9777' }),
    );
    expect(launch.inspectPort).toBe(9777);
    expect(launch.runnerArgs).toContain('--inspect-brk=127.0.0.1:9777');
  });

  it('runs from source WITHOUT an inspector when the port is disabled', () => {
    const launch = buildChildRunnerLaunch(
      input({ fromSourceFlag: 'true', inspectPortRaw: 'none' }),
    );
    expect(launch.mode).toBe('source');
    expect(launch.inspectPort).toBeUndefined();
    expect(launch.runnerArgs).toEqual(['--import', 'tsx', SRC]);
    expect(launch.runnerArgs.some((a) => a.includes('--inspect'))).toBe(false);
  });

  it('falls back to the default port when the override is invalid', () => {
    const launch = buildChildRunnerLaunch(
      input({ fromSourceFlag: 'true', inspectPortRaw: 'not-a-port' }),
    );
    expect(launch.inspectPort).toBe(9230);
  });

  it('fails safe to dist when the flag is on but source does not exist', () => {
    const launch = buildChildRunnerLaunch(
      input({ fromSourceFlag: '1', sourceExists: false }),
    );
    expect(launch.mode).toBe('dist');
    expect(launch.runnerArgs).toEqual([DIST]);
  });

  it('fails safe to dist when the flag is on but no source path is known', () => {
    const launch = buildChildRunnerLaunch(
      input({
        fromSourceFlag: '1',
        sourceRunnerPath: undefined,
        sourceExists: false,
      }),
    );
    expect(launch.mode).toBe('dist');
    expect(launch.runnerArgs).toEqual([DIST]);
  });
});
