import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionIpcRuntimeEnv } from '@core/runner/permission-ipc-client.js';

const requestPermissionApprovalViaIpc = vi.fn();
vi.mock('@core/runner/permission-ipc-client.js', () => ({
  requestPermissionApprovalViaIpc: (...args: unknown[]) =>
    requestPermissionApprovalViaIpc(...args),
}));

import {
  createGantryFacadeTools,
  DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES,
} from '@core/adapters/llm/deepagents-langchain/runner/gantry-facade-tools.js';

const tempRoots: string[] = [];

const PERMISSION_ENV: PermissionIpcRuntimeEnv = {
  appId: 'default',
  agentId: 'agent:main',
  chatJid: 'tg:group',
  jobId: '',
  jobName: '',
  jobRunId: '',
  jobRunLeaseToken: '',
  jobRunLeaseFencingVersion: '',
  ipcAuthToken: 'tok',
  ipcResponseVerifyKey: '',
  ipcResponseKeyId: 'kid',
  permissionRequestTimeoutMs: 1000,
  resolveWorkspaceIpcDir: (folder: string) => `/tmp/ipc/${folder}`,
};

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-facade-test-'));
  tempRoots.push(root);
  return root;
}

function makeTools(root: string, rules: string[] = []) {
  return createGantryFacadeTools({
    workspaceFolder: 'main_agent',
    memoryBlock: '',
    configuredAllowedTools: rules,
    gateContext: { conversationId: 'tg:group' },
    permissionEnv: PERMISSION_ENV,
    lockedAccessPreset: false,
    cwd: root,
  });
}

async function invoke(
  tools: ReturnType<typeof createGantryFacadeTools>,
  name: string,
  input: unknown,
): Promise<string> {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  const result = await found.invoke(input as never);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('Gantry DeepAgents facade tools', () => {
  beforeEach(() => {
    requestPermissionApprovalViaIpc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects Gantry public facade names and no raw DeepAgents filesystem tools', () => {
    const root = makeRoot();
    const names = makeTools(root)
      .map((item) => item.name)
      .sort();
    expect(names).toEqual([...DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES].sort());
    for (const raw of [
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
    ]) {
      expect(names).not.toContain(raw);
    }
  });

  it('reads files when FileRead authority is selected without prompting', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hello facade', 'utf-8');
    const result = await invoke(makeTools(root, ['FileRead']), 'FileRead', {
      path: 'notes.txt',
    });
    expect(result).toBe('hello facade');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
  });

  it('uses the public facade name in permission IPC when approval is required', async () => {
    requestPermissionApprovalViaIpc.mockResolvedValue({ approved: true });
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'approved read', 'utf-8');
    const result = await invoke(makeTools(root), 'FileRead', {
      path: 'notes.txt',
    });
    expect(result).toBe('approved read');
    expect(requestPermissionApprovalViaIpc).toHaveBeenCalledTimes(1);
    expect(requestPermissionApprovalViaIpc.mock.calls[0]?.[1]).toMatchObject({
      toolName: 'FileRead',
      agentFolder: 'main_agent',
      toolInput: { path: 'notes.txt' },
    });
  });

  it.each([
    ['WebSearch', { query: 'gantry runtime' }],
    ['WebRead', { url: 'https://example.com' }],
    ['FileSearch', { mode: 'path', query: 'notes' }],
    ['FileRead', { path: 'notes.txt' }],
    [
      'FileEdit',
      {
        path: 'notes.txt',
        patch: JSON.stringify({ oldText: 'a', newText: 'b' }),
      },
    ],
    ['FileWrite', { path: 'notes.txt', content: 'next' }],
  ])(
    'uses public facade name %s in permission IPC',
    async (toolName, input) => {
      requestPermissionApprovalViaIpc.mockResolvedValue({
        approved: false,
        reason: 'test denial',
      });
      const root = makeRoot();
      fs.writeFileSync(path.join(root, 'notes.txt'), 'approved read', 'utf-8');

      await expect(invoke(makeTools(root), toolName, input)).resolves.toContain(
        'Permission denied: test denial',
      );

      expect(requestPermissionApprovalViaIpc).toHaveBeenCalledTimes(1);
      expect(requestPermissionApprovalViaIpc.mock.calls[0]?.[1]).toMatchObject({
        toolName,
        agentFolder: 'main_agent',
        toolInput: input,
      });
    },
  );

  it('writes and edits files through Gantry facade authority', async () => {
    const root = makeRoot();
    const tools = makeTools(root, ['FileWrite', 'FileEdit', 'FileRead']);
    await invoke(tools, 'FileWrite', {
      path: 'todo.txt',
      content: 'alpha\n',
    });
    await invoke(tools, 'FileEdit', {
      path: 'todo.txt',
      patch: JSON.stringify({ oldText: 'alpha', newText: 'beta' }),
    });
    const result = await invoke(tools, 'FileRead', { path: 'todo.txt' });
    expect(result).toBe('beta\n');
  });

  it('searches paths and content without exposing raw glob/grep tools', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'const needle = 1;\n');
    const tools = makeTools(root, ['FileSearch']);
    await expect(
      invoke(tools, 'FileSearch', {
        mode: 'path',
        query: 'alpha',
      }),
    ).resolves.toContain('src/alpha.ts');
    await expect(
      invoke(tools, 'FileSearch', {
        mode: 'content',
        query: 'needle',
      }),
    ).resolves.toContain('src/alpha.ts:1');
  });

  it('wraps WebRead and WebSearch behind public facade tools', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('duckduckgo')) {
        return new Response(
          '<a class="result__a" href="https://example.com">Example Result</a>',
          { status: 200 },
        );
      }
      return new Response('<html><body><h1>Example</h1></body></html>', {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const root = makeRoot();
    const tools = makeTools(root, ['WebRead', 'WebSearch']);
    await expect(
      invoke(tools, 'WebRead', { url: 'https://example.com' }),
    ).resolves.toContain('Example');
    await expect(
      invoke(tools, 'WebSearch', { query: 'example', maxResults: 1 }),
    ).resolves.toContain('Example Result');
    expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
  });
});
