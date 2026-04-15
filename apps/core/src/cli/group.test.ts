import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-group-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

let runtimeHome = '';

beforeEach(() => {
  vi.resetModules();
  runtimeHome = createRuntimeHome();
  process.env.AGENT_ROOT = runtimeHome;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('group CLI commands', () => {
  it('adds and reads a non-telegram group', async () => {
    const { runAgentCommand } = await import('./group.js');
    const suffix = Date.now().toString(36);
    const jid = `dc:team-room-${suffix}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Discord Team',
        '--trigger',
        '@Kai',
      ]),
    ).toBe(0);

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Name: Discord Team');
    expect(output).toContain('Trigger: @Kai');
  });

  it('updates and disables trigger mode', async () => {
    const { runAgentCommand } = await import('./group.js');
    const suffix = Date.now().toString(36);
    const jid = `dc:ops-room-${suffix}`;

    await runAgentCommand(runtimeHome, [
      'add',
      jid,
      '--name',
      'Ops',
      '--trigger',
      '@Andy',
    ]);

    expect(await runAgentCommand(runtimeHome, ['trigger', jid, '@Bot'])).toBe(
      0,
    );
    expect(await runAgentCommand(runtimeHome, ['trigger', jid, '--off'])).toBe(
      0,
    );

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Trigger: @Bot');
    expect(output).toContain('Requires Trigger: no');
  });

  it('rejects folder-style selectors in group add', async () => {
    const { runAgentCommand } = await import('./group.js');
    expect(
      await runAgentCommand(runtimeHome, ['add', 'team_ops', '--name', 'Team']),
    ).toBe(1);
  });

  it('resolves numeric selector as folder when it exists', async () => {
    const { runAgentCommand } = await import('./group.js');
    const jid = `dc:numeric-folder-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Numeric Folder',
        '--folder',
        '123',
      ]),
    ).toBe(0);

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', '123'])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain(`JID: ${jid}`);
    expect(output).toContain('Folder: 123');
  });

  it('requires --yes for remove in non-interactive mode', async () => {
    const { runAgentCommand } = await import('./group.js');
    const jid = `dc:remove-confirm-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, ['add', jid, '--name', 'To Remove']),
    ).toBe(0);

    expect(await runAgentCommand(runtimeHome, ['remove', jid])).toBe(1);
    expect(await runAgentCommand(runtimeHome, ['remove', jid, '--yes'])).toBe(
      0,
    );
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(1);
  });
});
