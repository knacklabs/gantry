import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRuntimeSettingsText } from './runtime-settings.js';
import { settingsFilePath } from './runtime-home.js';

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
  it('seeds SOUL.md when adding an agent', async () => {
    const { runAgentCommand } = await import('./group.js');
    const jid = `dc:soul-seed-${Date.now().toString(36)}`;
    const folder = 'telegram_soul_seed';

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Soul Seed',
        '--folder',
        folder,
      ]),
    ).toBe(0);

    const soulPath = path.join(runtimeHome, 'agents', folder, 'SOUL.md');
    expect(fs.existsSync(soulPath)).toBe(true);
    const soul = fs.readFileSync(soulPath, 'utf-8');
    expect(soul).toContain('# Soul - Who You Are');
    expect(soul).toContain('- **Name:** Soul Seed');
    expect(soul).toContain('## Continuity Boundary');
    expect(soul).toContain(
      'Durable facts, user preferences, task state, and open commitments do not live here.',
    );

    const groupPrompt = fs.readFileSync(
      path.join(runtimeHome, 'agents', folder, 'CLAUDE.md'),
      'utf-8',
    );
    expect(groupPrompt).toContain('## Static Chat Guidance');
    expect(groupPrompt).toContain(
      'Dynamic task state, open commitments, and remembered facts come from the injected memory/continuity brief.',
    );
  });

  it('adds and reads a non-telegram group', async () => {
    const { runAgentCommand } = await import('./group.js');
    const suffix = Date.now().toString(36);
    const jid = `grp:team-room-${suffix}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Channel Team',
        '--trigger',
        '@Kai',
      ]),
    ).toBe(0);

    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    expect(await runAgentCommand(runtimeHome, ['info', jid])).toBe(0);

    const output = infoSpy.mock.calls.at(-1)?.[0] as string;
    expect(output).toContain('Name: Channel Team');
    expect(output).toContain('Trigger: @Kai');
  });

  it('updates and disables trigger mode', async () => {
    const { runAgentCommand } = await import('./group.js');
    const suffix = Date.now().toString(36);
    const jid = `grp:trigger-room-${suffix}`;

    await runAgentCommand(runtimeHome, [
      'add',
      jid,
      '--name',
      'Trigger Group',
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

  it('updates per-agent sender policy using folder keys', async () => {
    const { runAgentCommand } = await import('./group.js');
    const jid = `sl:policy-room-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Policy Group',
        '--folder',
        'slack_policy_group',
      ]),
    ).toBe(0);

    expect(
      await runAgentCommand(runtimeHome, [
        'policy',
        jid,
        '--allow',
        'U123,U456',
        '--mode',
        'drop',
      ]),
    ).toBe(0);

    const settings = parseRuntimeSettingsText(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    expect(
      settings.channels.slack.senderAllowlist.agents.slack_policy_group,
    ).toEqual({
      allow: ['U123', 'U456'],
      mode: 'drop',
    });

    expect(await runAgentCommand(runtimeHome, ['policy', jid, '--clear'])).toBe(
      0,
    );

    const updated = parseRuntimeSettingsText(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    expect(updated.channels.slack.senderAllowlist.agents).toEqual({});
  });

  it('updates default channel sender policy', async () => {
    const { runAgentCommand } = await import('./group.js');

    expect(
      await runAgentCommand(runtimeHome, [
        'policy-default',
        '--channel',
        'slack',
        '--allow',
        'U333',
        '--mode',
        'drop',
      ]),
    ).toBe(0);

    const settings = parseRuntimeSettingsText(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    expect(settings.channels.slack.senderAllowlist.default).toEqual({
      allow: ['U333'],
      mode: 'drop',
    });
  });

  it('prunes per-agent sender policy override when agent is removed', async () => {
    const { runAgentCommand } = await import('./group.js');
    const jid = `sl:remove-policy-${Date.now().toString(36)}`;

    expect(
      await runAgentCommand(runtimeHome, [
        'add',
        jid,
        '--name',
        'Remove Policy',
        '--folder',
        'slack_remove_policy',
      ]),
    ).toBe(0);

    expect(
      await runAgentCommand(runtimeHome, [
        'policy',
        jid,
        '--allow',
        'U777',
        '--mode',
        'trigger',
      ]),
    ).toBe(0);

    expect(await runAgentCommand(runtimeHome, ['remove', jid, '--yes'])).toBe(
      0,
    );

    const settings = parseRuntimeSettingsText(
      fs.readFileSync(settingsFilePath(runtimeHome), 'utf-8'),
    );
    expect(
      settings.channels.slack.senderAllowlist.agents.slack_remove_policy,
    ).toBeUndefined();
  });
});
