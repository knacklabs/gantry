import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
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

const TOOL_NETWORK_ENV: Record<string, string> = {
  HTTP_PROXY: 'http://127.0.0.1:18080/',
  HTTPS_PROXY: 'http://127.0.0.1:18080/',
  NODE_USE_ENV_PROXY: '1',
};

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-facade-test-'));
  tempRoots.push(root);
  return root;
}

function makeTools(
  root: string,
  rules: string[] = [],
  toolNetworkEnv?: Record<string, string>,
  filesystemToolsEnabled = true,
  extra: Partial<Parameters<typeof createGantryFacadeTools>[0]> = {},
) {
  return createGantryFacadeTools({
    workspaceFolder: 'main_agent',
    memoryBlock: '',
    configuredAllowedTools: rules,
    toolNetworkEnv,
    gateContext: { conversationId: 'tg:group' },
    permissionEnv: PERMISSION_ENV,
    lockedAccessPreset: false,
    filesystemToolsEnabled,
    cwd: root,
    ...extra,
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

async function startProxyFixture(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('proxy fixture did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readdirEntryName(entry: unknown): string {
  return entry && typeof entry === 'object' && 'name' in entry
    ? String((entry as { name: unknown }).name)
    : String(entry);
}

describe('Gantry DeepAgents facade tools', () => {
  beforeEach(() => {
    requestPermissionApprovalViaIpc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects Gantry public facade names and no raw DeepAgents filesystem tools', () => {
    const root = makeRoot();
    const names = makeTools(root, [], undefined, true, {
      asyncTaskToolsEnabled: true,
      delegateTaskTool: { name: 'delegate_task', invoke: vi.fn() } as never,
    })
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

  it('drops File facades when the host did not enable filesystem projection', () => {
    const root = makeRoot();
    const names = makeTools(root, [], undefined, false)
      .map((item) => item.name)
      .sort();
    expect(names).toEqual(['WebRead', 'WebSearch']);
  });

  it('passes raw JSON schemas to LangChain tools', () => {
    const root = makeRoot();
    const webRead = makeTools(root).find((item) => item.name === 'WebRead');
    expect(webRead?.schema).toMatchObject({
      type: 'object',
      required: ['url'],
    });
    expect(webRead?.schema).not.toHaveProperty('format');
    expect(webRead?.schema).not.toHaveProperty('schema');
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

  it('reads only a bounded prefix of oversized files', async () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, 'big.txt'),
      `${'x'.repeat(1_000_000)}TAIL_MARKER`,
      'utf-8',
    );
    const result = await invoke(makeTools(root, ['FileRead']), 'FileRead', {
      path: 'big.txt',
    });

    expect(result).toContain('x'.repeat(100));
    expect(result).toContain('[truncated 11 bytes before decoding]');
    expect(result).not.toContain('TAIL_MARKER');
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

  it('bridges AgentDelegation to Gantry delegate_task when authorized', async () => {
    const root = makeRoot();
    const delegateTaskTool = {
      name: 'delegate_task',
      invoke: vi.fn(async () => 'task task-1 started'),
    };

    const result = await invoke(
      makeTools(root, ['AgentDelegation'], undefined, true, {
        asyncTaskToolsEnabled: true,
        delegateTaskTool: delegateTaskTool as never,
      }),
      'AgentDelegation',
      { task: 'research accounts', context: 'from lead list' },
    );

    expect(result).toBe('task task-1 started');
    expect(delegateTaskTool.invoke).toHaveBeenCalledWith({
      objective: 'research accounts',
      context: 'from lead list',
    });
  });

  it('does not expose AgentDelegation until the Gantry delegate transport is mounted', () => {
    const root = makeRoot();
    expect(makeTools(root).map((item) => item.name)).not.toContain(
      'AgentDelegation',
    );
  });

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

  it('refuses FileEdit on oversized files before loading content', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(1_000_001));
    const result = await invoke(makeTools(root, ['FileEdit']), 'FileEdit', {
      path: 'big.txt',
      patch: JSON.stringify({ oldText: 'a', newText: 'b' }),
    });

    expect(result).toBe('FileEdit refuses files larger than 1000000 bytes.');
  });

  it('refuses FileWrite through a workspace symlink target', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, 'target.txt'), 'outside', 'utf-8');
    fs.symlinkSync(
      path.join(outside, 'target.txt'),
      path.join(root, 'link.txt'),
    );
    const tools = makeTools(root, ['FileWrite']);

    await expect(
      invoke(tools, 'FileWrite', {
        path: 'link.txt',
        content: 'escape',
      }),
    ).rejects.toThrow('FileWrite refuses to follow symlink targets.');
    expect(fs.readFileSync(path.join(outside, 'target.txt'), 'utf-8')).toBe(
      'outside',
    );
  });

  it('refuses FileEdit through a workspace symlink target', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, 'target.txt'), 'outside', 'utf-8');
    fs.symlinkSync(
      path.join(outside, 'target.txt'),
      path.join(root, 'link.txt'),
    );
    const tools = makeTools(root, ['FileEdit']);

    await expect(
      invoke(tools, 'FileEdit', {
        path: 'link.txt',
        patch: JSON.stringify({ oldText: 'outside', newText: 'edited' }),
      }),
    ).rejects.toThrow('FileEdit refuses to follow symlink targets.');
    expect(fs.readFileSync(path.join(outside, 'target.txt'), 'utf-8')).toBe(
      'outside',
    );
  });

  it('refuses FileWrite through a workspace symlink parent', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.symlinkSync(outside, path.join(root, 'link-dir'), 'dir');
    const tools = makeTools(root, ['FileWrite']);

    await expect(
      invoke(tools, 'FileWrite', {
        path: 'link-dir/newdir/target.txt',
        content: 'escape',
      }),
    ).rejects.toThrow('FileWrite refuses to follow symlink path components.');
    expect(fs.existsSync(path.join(outside, 'newdir'))).toBe(false);
  });

  it('searches paths and content without exposing raw glob/grep tools', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'const needle = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'skip.md'), 'needle\n');
    const tools = makeTools(root, ['FileSearch']);
    await expect(
      invoke(tools, 'FileSearch', {
        mode: 'path',
        query: 'alpha',
        include: '*.ts',
      }),
    ).resolves.toContain('src/alpha.ts');
    const contentResult = await invoke(tools, 'FileSearch', {
      mode: 'content',
      query: 'needle',
      include: '*.ts',
      exclude: '*.md',
    });
    expect(contentResult).toContain('src/alpha.ts:1');
    expect(contentResult).not.toContain('skip.md');
    await expect(
      invoke(tools, 'FileSearch', {
        mode: 'content',
        query: 'needle',
      }),
    ).resolves.toContain('src/alpha.ts:1');
  });

  it('stops FileSearch traversal after the result cap', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a-hit.txt'), 'needle\n');
    fs.mkdirSync(path.join(root, 'z-late'));
    fs.writeFileSync(path.join(root, 'z-late', 'late.txt'), 'needle\n');
    let lateDirectoryReads = 0;
    const originalReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, 'readdir').mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      const directory = String(args[0]);
      if (path.basename(directory) === 'z-late') lateDirectoryReads += 1;
      const entries = await originalReaddir(...args);
      return Array.isArray(entries)
        ? ([...entries].sort((left, right) =>
            readdirEntryName(left).localeCompare(readdirEntryName(right)),
          ) as Awaited<ReturnType<typeof fsPromises.readdir>>)
        : entries;
    }) as typeof fsPromises.readdir);

    const result = await invoke(makeTools(root, ['FileSearch']), 'FileSearch', {
      mode: 'content',
      query: 'needle',
      maxResults: 1,
    });

    expect(result).toContain('a-hit.txt:1');
    expect(lateDirectoryReads).toBe(0);
  });

  it('wraps WebRead and WebSearch behind public facade tools', async () => {
    const proxyRequests: string[] = [];
    const proxy = await startProxyFixture((req, res) => {
      proxyRequests.push(req.url ?? '');
      if ((req.url ?? '').includes('duckduckgo')) {
        res.end(
          '<a class="result__a" href="https://example.com">Example Result</a>',
        );
        return;
      }
      res.end('<html><body><h1>Example</h1></body></html>');
    });
    try {
      const toolNetworkEnv = {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        NODE_USE_ENV_PROXY: '1',
      };
      const root = makeRoot();
      const tools = makeTools(root, ['WebRead', 'WebSearch'], toolNetworkEnv);
      vi.stubEnv('HTTP_PROXY', undefined);
      vi.stubEnv('HTTPS_PROXY', undefined);
      vi.stubEnv('NODE_USE_ENV_PROXY', undefined);
      await expect(
        invoke(tools, 'WebRead', { url: 'https://example.com' }),
      ).resolves.toContain('Example');
      await expect(
        invoke(tools, 'WebSearch', { query: 'example', maxResults: 1 }),
      ).resolves.toContain('Example Result');
      expect(proxyRequests).toEqual(
        expect.arrayContaining([
          'https://example.com/',
          expect.stringContaining('https://duckduckgo.com/html/?q=example'),
        ]),
      );
      expect(requestPermissionApprovalViaIpc).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });

  it('fails WebRead/WebSearch closed when audited egress is unavailable', async () => {
    const root = makeRoot();
    const tools = makeTools(root, ['WebRead', 'WebSearch']);

    await expect(
      invoke(tools, 'WebRead', { url: 'https://example.com' }),
    ).resolves.toContain('audited tool networking was not projected');
    await expect(
      invoke(tools, 'WebSearch', { query: 'example', maxResults: 1 }),
    ).resolves.toContain('audited tool networking was not projected');
  });

  it('rejects oversized WebRead responses before buffering them', async () => {
    const proxy = await startProxyFixture((_req, res) => {
      res.writeHead(200, { 'content-length': '1000001' });
      res.end('too large');
    });
    try {
      const toolNetworkEnv = {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        NODE_USE_ENV_PROXY: '1',
      };
      const root = makeRoot();
      const tools = makeTools(root, ['WebRead'], toolNetworkEnv);
      vi.stubEnv('HTTP_PROXY', undefined);
      vi.stubEnv('HTTPS_PROXY', undefined);
      vi.stubEnv('NODE_USE_ENV_PROXY', undefined);

      await expect(
        invoke(tools, 'WebRead', { url: 'https://example.com' }),
      ).rejects.toThrow('Web response exceeded 1000000 bytes.');
    } finally {
      await proxy.close();
    }
  });

  it('stops streaming WebRead responses past the byte limit', async () => {
    const proxy = await startProxyFixture((_req, res) => {
      res.writeHead(200);
      res.write('x'.repeat(1_000_001));
      res.end();
    });
    try {
      const toolNetworkEnv = {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        NODE_USE_ENV_PROXY: '1',
      };
      const root = makeRoot();
      const tools = makeTools(root, ['WebRead'], toolNetworkEnv);
      vi.stubEnv('HTTP_PROXY', undefined);
      vi.stubEnv('HTTPS_PROXY', undefined);
      vi.stubEnv('NODE_USE_ENV_PROXY', undefined);

      await expect(
        invoke(tools, 'WebRead', { url: 'https://example.com' }),
      ).rejects.toThrow('Web response exceeded 1000000 bytes.');
    } finally {
      await proxy.close();
    }
  });

  it.each([
    'http://127.0.0.1:18080/internal',
    'http://localhost:18080/internal',
    'http://localhost.:18080/internal',
    'http://foo.localhost.:18080/internal',
    'http://10.0.0.1/internal',
    'http://192.168.1.10/internal',
    'http://[::1]/internal',
  ])('refuses WebRead private target %s', async (url) => {
    const root = makeRoot();
    const tools = makeTools(root, ['WebRead'], TOOL_NETWORK_ENV);

    vi.stubEnv('HTTP_PROXY', TOOL_NETWORK_ENV.HTTP_PROXY);
    vi.stubEnv('HTTPS_PROXY', TOOL_NETWORK_ENV.HTTPS_PROXY);
    vi.stubEnv('NODE_USE_ENV_PROXY', TOOL_NETWORK_ENV.NODE_USE_ENV_PROXY);
    await expect(invoke(tools, 'WebRead', { url })).resolves.toContain(
      'loopback or private network URLs',
    );
  });

  it('fails WebRead closed when audited egress env is incomplete', async () => {
    const root = makeRoot();
    const tools = makeTools(root, ['WebRead'], {
      HTTP_PROXY: TOOL_NETWORK_ENV.HTTP_PROXY,
      HTTPS_PROXY: TOOL_NETWORK_ENV.HTTPS_PROXY,
    });

    vi.stubEnv('HTTP_PROXY', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('NODE_USE_ENV_PROXY', '');
    await expect(
      invoke(tools, 'WebRead', { url: 'https://example.com' }),
    ).resolves.toContain('audited tool networking was not projected');
  });
});
