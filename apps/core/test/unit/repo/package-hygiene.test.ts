import { execFileSync } from 'child_process';
import fs from 'fs';

import { describe, expect, it } from 'vitest';

describe('package hygiene', () => {
  it('keeps tests, factory artifacts, coverage, pycache, and validation reports out of npm pack output', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf-8',
    });
    const [pack] = JSON.parse(raw) as Array<{
      files: Array<{ path: string }>;
    }>;
    const files = pack.files.map((file) => file.path);

    expect(
      files.filter(
        (file) =>
          file.includes('/test/') ||
          file.startsWith('test/') ||
          file.startsWith('.factory/') ||
          file.startsWith('coverage/') ||
          file.includes('__pycache__') ||
          file.endsWith('.pyc') ||
          /validation.*\.(json|md|txt)$/i.test(file),
      ),
    ).toEqual([]);
  }, 30_000);

  it('ships bundled skills with their required helper files', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf-8',
    });
    const [pack] = JSON.parse(raw) as Array<{
      files: Array<{ path: string }>;
    }>;
    const files = pack.files.map((file) => file.path);

    expect(files).toContain('.claude/skills/agent-browser/SKILL.md');
    expect(files).toContain('.claude/skills/agent-browser/browser_cdp.py');
    expect(files).toContain('.claude/skills/commands/SKILL.md');
    expect(files).toContain('.claude/skills/myclaw-admin/SKILL.md');
  }, 30_000);

  it('keeps packaged browser helper constrained to explicit CDP ports and fixed actions', () => {
    const helper = fs.readFileSync(
      '.claude/skills/agent-browser/browser_cdp.py',
      'utf-8',
    );

    expect(helper).not.toContain('range(50000, 60000)');
    expect(helper).not.toContain('"eval"');
    expect(helper).not.toContain('cmd_eval');
    expect(helper).toContain('MYCLAW_CDP_PORT');
  });
});
