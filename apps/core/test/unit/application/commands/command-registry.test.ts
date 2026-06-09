import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentCommand } from '@core/application/commands/command-registry.js';

const AGENTS_DIR = path.join(process.env.GANTRY_HOME as string, 'agents');

function makeAgent(folder: string): string {
  const dir = path.join(AGENTS_DIR, folder, 'commands');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(AGENTS_DIR, folder);
}

const MODULE_SRC = (name: string): string => `export const command = {
  name: '${name}',
  description: 'test command',
  visibility: 'operator',
  async run(ctx) { return 'ran:' + ctx.conversationId; },
};`;

const created: string[] = [];
afterEach(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

describe('loadAgentCommand', () => {
  it('loads a named command module (.ts) when present', async () => {
    const folder = 'cmd_ok';
    const dir = makeAgent(folder);
    created.push(dir);
    fs.writeFileSync(
      path.join(dir, 'commands', 'do-thing.ts'),
      MODULE_SRC('do-thing'),
      'utf8',
    );

    const mod = await loadAgentCommand(folder, 'do-thing');
    expect(mod?.name).toBe('do-thing');
    expect(mod?.visibility).toBe('operator');
    expect(
      await mod?.run({
        conversationId: 'c1',
        conversationJid: 'wa:1',
        threadId: null,
      }),
    ).toBe('ran:c1');
  });

  it('returns null when the named module is absent', async () => {
    const folder = 'cmd_absent';
    created.push(makeAgent(folder));
    expect(await loadAgentCommand(folder, 'missing')).toBeNull();
  });

  it('returns null when the module export is malformed', async () => {
    const folder = 'cmd_bad';
    const dir = makeAgent(folder);
    created.push(dir);
    fs.writeFileSync(
      path.join(dir, 'commands', 'broken.ts'),
      `export const command = { name: 'broken' };`, // no run()
      'utf8',
    );
    // .ts fails validation, the loader falls through to .js (absent), so it returns null.
    expect(await loadAgentCommand(folder, 'broken')).toBeNull();
  });

  it('refuses a name that escapes the commands folder', async () => {
    const folder = 'cmd_escape';
    created.push(makeAgent(folder));
    expect(await loadAgentCommand(folder, '../guardrail')).toBeNull();
  });

  it('caches the loaded module (second call skips the filesystem)', async () => {
    const folder = 'cmd_cache';
    const dir = makeAgent(folder);
    created.push(dir);
    const file = path.join(dir, 'commands', 'cached.ts');
    fs.writeFileSync(file, MODULE_SRC('cached'), 'utf8');
    const first = await loadAgentCommand(folder, 'cached');
    expect(first?.name).toBe('cached');
    fs.rmSync(file); // a non-cached loader would now return null
    const second = await loadAgentCommand(folder, 'cached');
    expect(second).toBe(first); // served from cache (same reference, file gone)
  });
});
