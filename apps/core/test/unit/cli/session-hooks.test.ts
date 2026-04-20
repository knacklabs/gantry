import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  applySessionHookInstallPlan,
  buildSessionHookInstallPlan,
  formatSessionHookInstallDiff,
} from '@core/cli/session-hooks.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-hooks-test-'));
}

const TEST_CLI_INDEX = '/tmp/myclaw/dist/cli/index.js';

function hookCommand(
  command: 'load' | 'extract-precompact' | 'extract-session-end',
): string {
  if (command === 'load') {
    return `node ${JSON.stringify(TEST_CLI_INDEX)} memory-hook load`;
  }
  if (command === 'extract-precompact') {
    return `node ${JSON.stringify(TEST_CLI_INDEX)} memory-hook extract --trigger=precompact`;
  }
  return `node ${JSON.stringify(TEST_CLI_INDEX)} memory-hook extract --trigger=session-end`;
}

describe('session hook settings merge', () => {
  it('creates hook commands in an empty settings file', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');

    const plan = buildSessionHookInstallPlan(settingsPath, TEST_CLI_INDEX);
    expect(plan.changed).toBe(true);
    expect(plan.added).toHaveLength(3);

    applySessionHookInstallPlan(plan);

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const hooks = parsed.hooks as Record<string, unknown[]>;
    expect(Array.isArray(hooks.SessionStart)).toBe(true);
    expect(Array.isArray(hooks.PreCompact)).toBe(true);
    expect(Array.isArray(hooks.SessionEnd)).toBe(true);
  });

  it('merges hooks without overwriting unrelated fields', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          env: { FOO: 'bar' },
          hooks: {
            SessionStart: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: hookCommand('load'),
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const plan = buildSessionHookInstallPlan(settingsPath, TEST_CLI_INDEX);
    expect(plan.changed).toBe(true);
    expect(plan.added).toHaveLength(3);

    applySessionHookInstallPlan(plan);

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const env = parsed.env as Record<string, unknown>;
    expect(env.FOO).toBe('bar');
  });

  it('reinstalls hook when command exists with wrong matcher/timeout/async', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            PreCompact: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: hookCommand('extract-precompact'),
                    timeout: 30,
                    async: false,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const plan = buildSessionHookInstallPlan(settingsPath, TEST_CLI_INDEX);
    expect(plan.changed).toBe(true);
    expect(plan.added.some((change) => change.event === 'PreCompact')).toBe(
      true,
    );
  });

  it('is idempotent when hooks already exist', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');

    const firstPlan = buildSessionHookInstallPlan(settingsPath, TEST_CLI_INDEX);
    applySessionHookInstallPlan(firstPlan);

    const secondPlan = buildSessionHookInstallPlan(
      settingsPath,
      TEST_CLI_INDEX,
    );
    expect(secondPlan.changed).toBe(false);
    expect(secondPlan.added).toHaveLength(0);
  });

  it('adds hooks into default matcher when only non-default matcher exists', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'workspace/*',
                hooks: [
                  {
                    type: 'command',
                    command: 'echo existing-command',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const plan = buildSessionHookInstallPlan(settingsPath, TEST_CLI_INDEX);
    expect(plan.changed).toBe(true);
    expect(plan.added).toHaveLength(3);

    applySessionHookInstallPlan(plan);

    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const hooks = parsed.hooks as Record<string, unknown>;
    const sessionStart = hooks.SessionStart as Array<Record<string, unknown>>;
    const workspaceMatcher = sessionStart.find(
      (entry) => entry.matcher === 'workspace/*',
    );
    const eventMatcher = sessionStart.find(
      (entry) => entry.matcher === 'startup|resume|compact',
    );

    expect(workspaceMatcher).toBeDefined();
    expect(eventMatcher).toBeDefined();
    const defaultHooks = eventMatcher?.hooks as Array<Record<string, unknown>>;
    expect(
      defaultHooks.some(
        (hook) =>
          hook.type === 'command' && hook.command === hookCommand('load'),
      ),
    ).toBe(true);
  });

  it('formats a helpful diff summary for planned hook changes', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');

    const plan = buildSessionHookInstallPlan(settingsPath, TEST_CLI_INDEX);
    const diff = formatSessionHookInstallDiff(plan);

    expect(diff).toContain(`Planned changes for ${settingsPath}:`);
    expect(diff).toContain(`+ SessionStart: ${hookCommand('load')}`);
    expect(diff).toContain(
      `+ PreCompact: ${hookCommand('extract-precompact')}`,
    );
    expect(diff).toContain(
      `+ SessionEnd: ${hookCommand('extract-session-end')}`,
    );
  });

  it('throws on invalid JSON settings', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, '{ bad-json', 'utf-8');

    expect(() => buildSessionHookInstallPlan(settingsPath)).toThrow();
  });

  it('throws when settings root is not an object', () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, '[]', 'utf-8');

    expect(() => buildSessionHookInstallPlan(settingsPath)).toThrow(
      'Expected JSON object at root.',
    );
  });
});
