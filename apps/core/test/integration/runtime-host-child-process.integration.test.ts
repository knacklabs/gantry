import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: string }).code)
          : '';
      if (code !== 'ENOTEMPTY' || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

afterEach(async () => {
  vi.doUnmock('@core/config/index.js');
  vi.doUnmock('@core/infrastructure/logging/logger.js');
  vi.doUnmock('@core/runtime/agent-spawn-host.js');
  vi.doUnmock('@core/runtime/agent-spawn-layout.js');
  vi.doUnmock('@core/application/agents/prompt-profile-service.js');
  vi.doUnmock('@core/platform/group-folder.js');
  vi.resetModules();

  for (const root of tempRoots.splice(0)) {
    await removeTempRoot(root);
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-host-smoke-'));
  tempRoots.push(root);
  return root;
}

function writeHostRunner(runnerDistDir: string, recordPath: string): void {
  const claudeRunnerDir = path.join(runnerDistDir, 'claude');
  const mcpRunnerDir = path.join(runnerDistDir, 'mcp');
  fs.mkdirSync(claudeRunnerDir, { recursive: true });
  fs.mkdirSync(mcpRunnerDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeRunnerDir, 'index.js'),
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
        brokerBaseUrlPresent: Boolean(process.env.ANTHROPIC_BASE_URL),
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
  fs.writeFileSync(path.join(mcpRunnerDir, 'stdio.js'), '');
}

describe('host child-process runtime smoke', () => {
  it('spawns a real runner child process through spawnAgent and exchanges stdin/stdout', async () => {
    const root = makeTempRoot();
    const dataDir = path.join(root, 'data');
    const agentRoot = path.join(root, 'agents');
    const runnerDistDir = path.join(root, 'dist', 'runner');
    const groupDir = path.join(agentRoot, 'main');
    const groupIpcDir = path.join(dataDir, 'ipc', 'main');
    const recordPath = path.join(root, 'child-record.json');
    writeHostRunner(runnerDistDir, recordPath);

    vi.doMock('@core/config/index.js', async () => {
      const actual = await vi.importActual<
        typeof import('@core/config/index.js')
      >('@core/config/index.js');
      return {
        ...actual,
        AGENT_MAX_OUTPUT_SIZE: 1024 * 1024,
        AGENT_TIMEOUT: 5_000,
        DATA_DIR: dataDir,
        AGENTS_DIR: agentRoot,
        IDLE_TIMEOUT: 5_000,
        MYCLAW_HOME: agentRoot,
        MYCLAW_HOME: agentRoot,
        ONECLI_URL: '',
        PERMISSION_APPROVAL_TIMEOUT_MS: 5_000,
        TIMEZONE: 'UTC',
        getEffectiveModelConfig: () => ({ source: 'unset' }),
      };
    });
    vi.doMock('@core/infrastructure/logging/logger.js', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      redactString: (value: string) => value,
    }));
    vi.doMock('@core/runtime/agent-spawn-host.js', () => ({
      getHostRuntimeCredentialEnv: async () => ({
        env: { ANTHROPIC_BASE_URL: 'https://broker.example.com/anthropic' },
        credentialProviders: {},
        brokerApplied: true,
        brokerProfile: 'external',
      }),
      prepareHostRuntimeContext: () => ({
        groupDir,
        groupIpcDir,
        runnerDistDir,
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
    vi.doMock('@core/application/agents/prompt-profile-service.js', () => {
      function MockPromptProfileService(this: {
        compileSystemPrompt: () => Promise<string>;
      }) {
        this.compileSystemPrompt = async () => 'compiled host smoke prompt';
      }
      return {
        PromptProfileService: MockPromptProfileService,
        promptProfileAgentIdForFolder: (folder: string) => `agent:${folder}`,
      };
    });
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
      },
      {
        prompt: 'real child smoke prompt',
        groupFolder: 'main',
        chatJid: 'tg:main',
        memoryContextBlock: 'host smoke memory context',
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
        brokerBaseUrlPresent: false,
      }),
    );
    expect(childRecord.input.modelCredentialEnv).toEqual(
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://broker.example.com/anthropic',
      }),
    );
    expect(childRecord.input.memoryContextBlock).toBe(
      'host smoke memory context',
    );
    expect(fs.existsSync(path.join(groupDir, 'logs'))).toBe(true);
    expect(fs.readdirSync(path.join(groupDir, 'logs')).length).toBeGreaterThan(
      0,
    );
  }, 30_000);
});
