import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilesystemRunnerControlPort } from '@core/runtime/filesystem-runner-control-port.js';

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe('FilesystemRunnerControlPort', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-runner-port-'));
    roots.push(root);
    return root;
  }

  it('delegates workspace layout creation to the existing IPC layout', () => {
    const ipcBaseDir = makeRoot();
    const port = new FilesystemRunnerControlPort(ipcBaseDir);

    port.ensureWorkspaceLayout('main_agent');

    const workspaceDir = path.join(ipcBaseDir, 'main_agent');
    expect(port.hasCompleteTrustedWorkspaceLayout('main_agent')).toBe(true);
    expect(fileMode(workspaceDir)).toBe(0o700);
    expect(fs.readdirSync(workspaceDir).sort()).toEqual([
      'browser-requests',
      'browser-responses',
      'conversation-history-requests',
      'conversation-history-responses',
      'input',
      'interaction-boundaries',
      'memory-requests',
      'memory-responses',
      'messages',
      'permission-requests',
      'permission-responses',
      'rich-interactions',
      'task-responses',
      'tasks',
      'user-answers',
      'user-questions',
    ]);
  });

  it('wraps trusted workspace, pending request, claim, delete, and archive primitives', () => {
    const ipcBaseDir = makeRoot();
    const port = new FilesystemRunnerControlPort(ipcBaseDir);
    const messagesDir = path.join(ipcBaseDir, 'main_agent', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    const requestPath = path.join(messagesDir, 'request-1.json');
    fs.writeFileSync(requestPath, JSON.stringify({ ok: true }));
    fs.writeFileSync(path.join(messagesDir, '.processing-old.json'), '{}');
    fs.writeFileSync(path.join(messagesDir, 'request-2.json.tmp'), '{}');

    expect(port.isTrustedRegisteredWorkspace('main_agent')).toBe(true);
    expect(port.requestDirExists('main_agent', 'messages')).toBe(true);
    expect(port.isTrustedRequestDir('main_agent', 'messages')).toBe(true);
    expect(port.requestDir('main_agent', 'messages')).toBe(messagesDir);
    expect(port.listPendingRequests('main_agent', 'messages')).toEqual([
      'request-1.json',
    ]);

    const claim = port.claimRequest('main_agent', 'messages', 'request-1.json');
    expect(path.basename(claim.claimedPath)).toContain('.processing-');
    expect(claim.raw).toEqual({ ok: true });

    port.archiveFailedRequest(
      'main_agent',
      'request-1.json',
      claim.claimedPath,
    );
    const archivedPath = path.join(
      ipcBaseDir,
      'errors',
      'main_agent-request-1.json',
    );
    expect(fs.existsSync(archivedPath)).toBe(true);

    fs.writeFileSync(requestPath, '{}');
    const deletedClaim = port.claimRequest(
      'main_agent',
      'messages',
      'request-1.json',
    );
    port.removeClaimedRequest(deletedClaim.claimedPath);
    expect(fs.existsSync(deletedClaim.claimedPath)).toBe(false);
  });

  it('archives malformed claimed requests instead of stranding processing files', () => {
    const ipcBaseDir = makeRoot();
    const port = new FilesystemRunnerControlPort(ipcBaseDir);
    const messagesDir = path.join(ipcBaseDir, 'main_agent', 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(path.join(messagesDir, 'bad.json'), '{');

    expect(() =>
      port.claimRequest('main_agent', 'messages', 'bad.json'),
    ).toThrow();

    expect(fs.readdirSync(messagesDir)).toEqual([]);
    expect(
      fs.existsSync(path.join(ipcBaseDir, 'errors', 'main_agent-bad.json')),
    ).toBe(true);
  });

  it('writes continuation input through the current local IPC path', async () => {
    const dataDir = makeRoot();
    vi.resetModules();
    vi.doMock('@core/config/index.js', () => ({
      DATA_DIR: dataDir,
    }));
    const { FilesystemRunnerControlPort: MockedPort } =
      await import('@core/runtime/filesystem-runner-control-port.js');
    const port = new MockedPort(path.join(dataDir, 'ipc'));

    port.writeContinuationInput({
      workspaceFolder: 'main_agent',
      text: 'continue here',
      sequence: 7,
      threadId: 'thread:a',
    });

    const inputDir = path.join(
      dataDir,
      'ipc',
      'main_agent',
      'input',
      `thread-${encodeURIComponent('thread:a')}`,
    );
    const files = fs.readdirSync(inputDir);
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(inputDir, files[0]), 'utf-8')),
    ).toEqual({
      type: 'message',
      text: 'continue here',
      threadId: 'thread:a',
    });

    port.writeCloseSignal({
      workspaceFolder: 'main_agent',
      threadId: 'thread:a',
    });
    expect(fs.existsSync(path.join(inputDir, '_close'))).toBe(true);
  });
});
