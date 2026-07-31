import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeRunnerMcpConfigFile } from '@core/runtime/agent-spawn-mcp-config.js';

describe('writeRunnerMcpConfigFile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempDirs)
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it('projects a PATH-installed stdio command as an absolute executable', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mcp-config-'),
    );
    tempDirs.push(tempDir);
    const executable = path.join(tempDir, 'path-only-mcp');
    fs.writeFileSync(executable, '');
    vi.stubEnv('PATH', tempDir);

    const configPath = writeRunnerMcpConfigFile(tempDir, [
      {
        name: 'test',
        config: { type: 'stdio', command: 'path-only-mcp' },
      } as never,
    ]);

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      test: { type: 'stdio', command: executable },
    });
  });

  it('resolves a bundled command when the hardened PATH omits npm bins', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-mcp-config-'),
    );
    tempDirs.push(tempDir);
    const binDir = path.join(tempDir, 'node_modules', '.bin');
    const executable = path.join(binDir, 'firecrawl-mcp');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(executable, '');
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    vi.stubEnv('PATH', '');

    const configPath = writeRunnerMcpConfigFile(tempDir, [
      {
        name: 'firecrawl',
        config: { type: 'stdio', command: 'firecrawl-mcp' },
      } as never,
    ]);

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      firecrawl: { type: 'stdio', command: executable },
    });
  });
});
