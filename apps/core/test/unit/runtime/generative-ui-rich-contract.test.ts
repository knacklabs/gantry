import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

const richToolNames = [
  'render_status',
  'render_facts',
  'render_list',
  'render_table',
  'render_form',
  'render_media',
  'render_progress',
];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function listSourceFiles(relativeDir: string): string[] {
  const root = path.join(repoRoot, relativeDir);
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(relativePath));
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relativePath);
  }
  return files;
}

function richSources(): string {
  return listSourceFiles('apps/core/src')
    .filter((file) => {
      const lower = file.toLowerCase();
      return (
        lower.includes('rich') ||
        lower.includes('interaction') ||
        lower.includes('gantry-mcp') ||
        lower.includes('messaging') ||
        lower.includes('app.ts')
      );
    })
    .map(read)
    .join('\n');
}

describe('generative UI rich interaction contract', () => {
  it('extends InteractionDescriptor with validated v1 rich kinds and fallback text', () => {
    const domainTypes = read('apps/core/src/domain/types.ts');

    expect(domainTypes).toContain('InteractionDescriptor');
    expect(domainTypes).toContain('fallbackText');
    for (const kind of [
      'status',
      'facts',
      'list',
      'table',
      'form',
      'media',
      'progress',
    ]) {
      expect(domainTypes).toContain(`'${kind}'`);
    }
  });

  it('registers rich render tools separately from send_message', () => {
    const toolSurface = read('apps/core/src/runner/gantry-mcp-tool-surface.ts');
    const messagingTools = read('apps/core/src/runner/mcp/tools/messaging.ts');

    for (const toolName of richToolNames) {
      expect(toolSurface).toContain(`'${toolName}'`);
      expect(messagingTools).toContain(`'${toolName}'`);
    }

    for (const toolName of richToolNames) {
      const toolIndex = messagingTools.indexOf(`'${toolName}'`);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      const nextToolIndex = messagingTools.indexOf(
        'server.tool(',
        toolIndex + 1,
      );
      const toolBody = messagingTools.slice(
        toolIndex,
        nextToolIndex === -1 ? undefined : nextToolIndex,
      );
      expect(toolBody).toContain('rich');
      expect(toolBody).not.toContain('MESSAGES_DIR');
      expect(toolBody).not.toContain("type: 'message'");
    }
  });

  it('has signed rich IPC handling for accepted and rejected requests', () => {
    const runtimeSources = [
      ...listSourceFiles('apps/core/src/runtime'),
      'apps/core/src/domain/types.ts',
    ]
      .map(read)
      .join('\n');

    expect(runtimeSources).toContain('rich');
    expect(runtimeSources).toContain('validateIpcAuthRequest');
    expect(runtimeSources).toContain(
      'Rich view unavailable in this conversation. Showing text version.',
    );
    expect(runtimeSources).toMatch(/requested|delivered|fallback|failed/);
    expect(runtimeSources).toMatch(/reject|forged|signature|auth/i);
  });

  it('keeps app clients on structured rich events instead of flattened text only', () => {
    const sources = richSources();

    expect(sources).toContain('session');
    expect(sources).toContain('rich');
    expect(sources).toContain('fallbackText');
    expect(sources).toContain('orderedEnvelope');
    expect(sources).toContain('descriptor');
  });
});
