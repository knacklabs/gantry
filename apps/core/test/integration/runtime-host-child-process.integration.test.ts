import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

afterEach(() => {
  vi.doUnmock('@core/core/config.js');
  vi.doUnmock('@core/core/logger.js');
  vi.doUnmock('@core/runtime/agent-spawn-host.js');
  vi.doUnmock('@core/runtime/agent-spawn-layout.js');
  vi.doUnmock('@core/runtime/prompt-profile.js');
  vi.doUnmock('@core/platform/group-folder.js');
  vi.resetModules();

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-host-smoke-'));
  tempRoots.push(root);
  return root;
}

function writeHostRunner(runnerRoot: string, recordPath: string): void {
  const distDir = path.join(runnerRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(runnerRoot, 'package.json'),
    JSON.stringify({ type: 'module' }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `
import fs from 'node:fs';

let stdin = '';
process.stdin.on('data', (chunk) => {
  stdin += chunk.toString();
});
process.stdin.on('end', () => {
  const input = JSON.parse(stdin);
  fs.writeFileSync(
    ${JSON.stringify(recordPath)},
    JSON.stringify({
      input,
      env: {
        groupDir: process.env.MYCLAW_WORKSPACE_GROUP_DIR,
        ipcDir: process.env.MYCLAW_IPC_DIR,
        ipcInputDir: process.env.MYCLAW_IPC_INPUT_DIR,
        authTokenPresent: Boolean(process.env.MYCLAW_IPC_AUTH_TOKEN),
        memoryContextFile: process.env.MYCLAW_IPC_MEMORY_CONTEXT_FILE,
      },
    }, null, 2),
  );
  console.log('---MYCLAW_OUTPUT_START---');
  console.log(JSON.stringify({
    status: 'success',
    result: 'host child saw: ' + input.prompt,
    newSessionId: 'host-child-session',
  }));
  console.log('---MYCLAW_OUTPUT_END---');
});
`,
  );
  fs.writeFileSync(path.join(distDir, 'ipc-mcp-stdio.js'), '');
}

describe('host child-process runtime smoke', () => {
  it('spawns a real runner child process through spawnAgent and exchanges stdin/stdout', async () => {
    const root = makeTempRoot();
    const dataDir = path.join(root, 'data');
    const agentRoot = path.join(root, 'agents');
    const runnerRoot = path.join(root, 'runner');
    const groupDir = path.join(agentRoot, 'main');
    const groupIpcDir = path.join(dataDir, 'ipc', 'main');
    const recordPath = path.join(root, 'child-record.json');
    const memoryContextFile = path.join(groupIpcDir, 'memory_context.run.json');
    writeHostRunner(runnerRoot, recordPath);

    vi.doMock('@core/core/config.js', () => ({
      MEMORY_ROOT: path.join(root, 'memory'),
      AGENT_MAX_OUTPUT_SIZE: 1024 * 1024,
      AGENT_TIMEOUT: 5_000,
      DATA_DIR: dataDir,
      AGENTS_DIR: agentRoot,
      IDLE_TIMEOUT: 5_000,
      AGENT_ROOT: agentRoot,
      ONECLI_URL: '',
      PERMISSION_APPROVAL_TIMEOUT_MS: 5_000,
      TIMEZONE: 'UTC',
      getEffectiveModelConfig: () => ({ source: 'unset' }),
    }));
    vi.doMock('@core/core/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));
    vi.doMock('@core/runtime/agent-spawn-host.js', () => ({
      getHostRuntimeCredentialEnv: async () => ({
        env: {},
        onecliApplied: false,
      }),
      prepareHostRuntimeContext: () => ({
        groupDir,
        groupIpcDir,
        runnerRoot,
      }),
    }));
    vi.doMock('@core/runtime/agent-spawn-layout.js', () => ({
      ensureGroupIpcLayout: (dir: string) => {
        for (const subdir of [
          'messages',
          'tasks',
          'input',
          'permission-requests',
          'permission-responses',
          'user-questions',
          'user-answers',
          'memory-requests',
          'memory-responses',
          'browser-requests',
          'browser-responses',
        ]) {
          fs.mkdirSync(path.join(dir, subdir), { recursive: true });
        }
      },
    }));
    vi.doMock('@core/runtime/prompt-profile.js', () => ({
      getPromptProfileService: () => ({
        compileSystemPrompt: () => 'compiled host smoke prompt',
      }),
    }));
    vi.doMock('@core/platform/group-folder.js', () => ({
      resolveGroupFolderPath: () => groupDir,
    }));

    const { spawnAgent } = await import('@core/runtime/agent-spawn.js');
    const onOutput = vi.fn(async () => {});
    const onProcess = vi.fn();

    const result = await spawnAgent(
      {
        jid: 'tg:main',
        name: 'Main',
        folder: 'main',
        trigger: 'Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      },
      {
        prompt: 'real child smoke prompt',
        groupFolder: 'main',
        chatJid: 'tg:main',
        isMain: true,
        memoryContextFile,
      },
      onProcess,
      onOutput,
      { timeoutMs: 5_000 },
    );

    expect(result).toEqual({
      status: 'success',
      result: null,
      newSessionId: 'host-child-session',
    });
    expect(onProcess).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        result: 'host child saw: real child smoke prompt',
        newSessionId: 'host-child-session',
      }),
    );

    const childRecord = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as {
      input: Record<string, unknown>;
      env: Record<string, unknown>;
    };
    expect(childRecord.input).toEqual(
      expect.objectContaining({
        prompt: 'real child smoke prompt',
        compiledSystemPrompt: 'compiled host smoke prompt',
      }),
    );
    expect(childRecord.env).toEqual(
      expect.objectContaining({
        groupDir,
        ipcDir: groupIpcDir,
        ipcInputDir: path.join(groupIpcDir, 'input'),
        authTokenPresent: true,
        memoryContextFile,
      }),
    );
    expect(fs.existsSync(path.join(groupDir, 'logs'))).toBe(true);
    expect(fs.readdirSync(path.join(groupDir, 'logs')).length).toBeGreaterThan(
      0,
    );
  });
});
