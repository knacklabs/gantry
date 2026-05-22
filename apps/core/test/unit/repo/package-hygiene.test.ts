import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { GANTRY_BUNDLED_CLAUDE_SKILL_IDS } from '@core/adapters/llm/anthropic-claude-agent/claude-skill-materializer.js';

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

  it('ships only Gantry-owned bundled skills', () => {
    const expectedSkillFiles = GANTRY_BUNDLED_CLAUDE_SKILL_IDS.map(
      (skillId) => `.claude/skills/${skillId}/SKILL.md`,
    );
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf-8',
    });
    const [pack] = JSON.parse(raw) as Array<{
      files: Array<{ path: string }>;
    }>;
    const files = pack.files.map((file) => file.path);
    const skillFiles = files
      .filter((file) => file.startsWith('.claude/skills/'))
      .sort();

    expect(skillFiles).toEqual(expectedSkillFiles);

    const sourceSkillsRoot = path.join(process.cwd(), '.claude', 'skills');
    const sourceSkillFiles = fs
      .readdirSync(sourceSkillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const skillFile = path.join(sourceSkillsRoot, entry.name, 'SKILL.md');
        return fs.existsSync(skillFile)
          ? [`.claude/skills/${entry.name}/SKILL.md`]
          : [];
      })
      .sort();
    expect(sourceSkillFiles).toEqual(expectedSkillFiles);
  }, 30_000);

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
