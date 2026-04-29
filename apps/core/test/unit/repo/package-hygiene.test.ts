import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('package hygiene', () => {
  function listSourceFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSourceFiles(fullPath);
      return fullPath.endsWith('.ts') ? [fullPath] : [];
    });
  }

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
    expect(helper).toContain('ProxyHandler({})');
    expect(helper).toContain('NO_PROXY');
  });

  it('isolates OneCLI SDK imports to credential adapter and CLI setup adapter', () => {
    const allowed = new Set([
      path.normalize('apps/core/src/adapters/credentials/onecli/broker.ts'),
      path.normalize('apps/core/src/cli/setup-credentials.ts'),
    ]);
    const offenders = listSourceFiles('apps/core/src')
      .filter((file) =>
        fs.readFileSync(file, 'utf-8').includes('@onecli-sh/sdk'),
      )
      .map((file) => path.normalize(file))
      .filter((file) => !allowed.has(file));

    expect(offenders).toEqual([]);
  });
});
