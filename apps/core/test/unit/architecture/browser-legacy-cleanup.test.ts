import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOTS = [
  '.claude/skills',
  '.codex/lessons.jsonl',
  '.codex/skills',
  'AGENTS.md',
  'README.md',
  'apps/core/src',
  'apps/core/test',
  'docs',
  'packages/contracts/src',
  'packages/contracts/test',
] as const;

const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.ts', '.tsx']);

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'cache',
  'coverage',
  'dist',
  'node_modules',
]);

function collectFiles(entryPath: string): string[] {
  if (!fs.existsSync(entryPath)) return [];
  const stat = fs.statSync(entryPath);
  if (stat.isFile()) return [entryPath];
  const out: string[] = [];
  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const childPath = path.join(entryPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(childPath));
    } else if (
      entry.isFile() &&
      TEXT_EXTENSIONS.has(path.extname(entry.name))
    ) {
      out.push(childPath);
    }
  }
  return out;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

describe('browser cleanup guard', () => {
  it('keeps legacy browser naming out of tracked source docs and tests', () => {
    const oldPublicBrowserActions = [
      'launch',
      'navigate',
      'navigate_back',
      'tabs',
      'snapshot',
      'take_screenshot',
      'console_messages',
      'network_requests',
      'click',
      'type',
      'press_key',
      'hover',
      'drag',
      'drop',
      'select_option',
      'fill_form',
      'wait_for',
      'evaluate',
      'file_upload',
      'handle_dialog',
      'resize',
    ].map((action) => `browser_${action}`);
    const forbiddenTerms = [
      `agent${'-'}browser`,
      `agent${'_'}browser`,
      `mcp__agent${'_'}browser`,
      `mcp__browser${'_'}backend`,
      `browser${'_'}backend`,
      `mcp__${'play'}wright`,
      `mcp__${'pup'}peteer`,
      `${'Play'}wright MCP`,
      `${'Pup'}peteer MCP`,
      `${'pup'}peteer`,
      `Browser${'Ipc'}Action`,
      `BROWSER_${'PUBLIC'}_TOOL_NAMES`,
      `PUBLIC_BROWSER_TOOL_TO_${'BACKEND'}_ACTION`,
      ...oldPublicBrowserActions,
    ];
    const browserDriverPackage = `${'play'}wright-core`;
    const browserDriverToken = `${'play'}wright`;
    const files = SOURCE_ROOTS.flatMap((root) =>
      collectFiles(path.resolve(root)),
    );
    const violations: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const term of forbiddenTerms) {
        let index = source.indexOf(term);
        while (index >= 0) {
          violations.push(
            `${path.relative(process.cwd(), file)}:${lineNumber(source, index)} ${term}`,
          );
          index = source.indexOf(term, index + term.length);
        }
      }
      let driverIndex = source.indexOf(browserDriverToken);
      while (driverIndex >= 0) {
        const context = source.slice(
          Math.max(0, driverIndex - 16),
          driverIndex + browserDriverPackage.length + 16,
        );
        if (!context.includes(browserDriverPackage)) {
          violations.push(
            `${path.relative(process.cwd(), file)}:${lineNumber(source, driverIndex)} ${browserDriverToken}`,
          );
        }
        driverIndex = source.indexOf(browserDriverToken, driverIndex + 1);
      }
    }

    expect(violations).toEqual([]);
  });
});
