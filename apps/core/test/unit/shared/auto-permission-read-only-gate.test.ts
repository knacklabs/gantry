import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { evaluateAutoPermissionReadOnlyGate } from '@core/shared/auto-permission-read-only-gate.js';

const tempRoots: string[] = [];

function makeTempRoot(label = 'workspace'): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `gantry-auto-permission-${label}-`),
  );
  tempRoots.push(root);
  return root;
}

function shell(
  command: string,
  approvedCapabilityIds: string[],
  workspaceRoot?: string,
) {
  return evaluateAutoPermissionReadOnlyGate({
    canonicalToolName: 'Bash',
    toolInput: { command },
    approvedCapabilityIds,
    workspaceRoot,
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('auto-permission deterministic read-only gate', () => {
  it('proves simple reviewed reads inside a real workspace', () => {
    const workspaceRoot = makeTempRoot();
    fs.mkdirSync(path.join(workspaceRoot, 'docs'));
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'Gantry');

    for (const [command, capabilityIds] of [
      ['ls', ['filesystem.list']],
      ['ls docs', ['workspace.read']],
      ['cat README.md', ['filesystem.read']],
    ] as const) {
      expect(shell(command, [...capabilityIds], workspaceRoot)).toMatchObject({
        allowed: true,
      });
    }
  });

  it('requires a matching selected capability boundary', () => {
    const workspaceRoot = makeTempRoot();
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'Gantry');
    expect(shell('cat README.md', [], workspaceRoot)).toMatchObject({
      allowed: false,
    });
    expect(
      shell('cat README.md', ['google.drive.files.read'], workspaceRoot),
    ).toMatchObject({ allowed: false });
  });

  it('keeps git out of the silent set (fsmonitor hooks run on status)', () => {
    const workspaceRoot = makeTempRoot();
    for (const command of [
      'git status',
      'git --no-optional-locks status',
      'git log',
    ]) {
      expect(shell(command, ['git.status'], workspaceRoot)).toMatchObject({
        allowed: false,
      });
    }
  });

  it('blocks a symlink target that escapes the workspace', () => {
    const workspaceRoot = makeTempRoot();
    const outsideRoot = makeTempRoot('outside');
    fs.writeFileSync(path.join(outsideRoot, 'report.txt'), 'outside');
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'reports'), 'dir');

    expect(
      shell('ls -R reports', ['filesystem.read'], workspaceRoot),
    ).toMatchObject({ allowed: false });
  });

  it('blocks a symlink to an in-workspace hidden file', () => {
    const workspaceRoot = makeTempRoot();
    fs.writeFileSync(path.join(workspaceRoot, '.private'), 'hidden');
    fs.symlinkSync('.private', path.join(workspaceRoot, 'visible'));

    expect(
      shell('cat visible', ['filesystem.read'], workspaceRoot),
    ).toMatchObject({ allowed: false });
  });

  it('blocks file reads without a workspace root', () => {
    expect(shell('cat report.txt', ['filesystem.read'])).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('workspace root'),
    });
  });

  it('allows reads when the host-provisioned workspace root itself is dotted', () => {
    const base = makeTempRoot('dotted');
    const workspaceRoot = path.join(base, '.gantry', 'agents', 'main');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'Gantry');
    expect(
      shell('cat README.md', ['filesystem.read'], workspaceRoot),
    ).toMatchObject({ allowed: true });
    expect(
      shell('cat .npmrc', ['filesystem.read'], workspaceRoot),
    ).toMatchObject({ allowed: false });
  });

  it('allows a genuine regular file inside the workspace', () => {
    const workspaceRoot = makeTempRoot();
    fs.writeFileSync(path.join(workspaceRoot, 'report.txt'), 'safe');

    expect(
      shell('cat report.txt', ['filesystem.read'], workspaceRoot),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    'cat $(whoami)',
    'cat README.md > /tmp/copy',
    'cat README.md | tee /tmp/copy',
    'cat README.md && rm README.md',
    'cat README.md # inspect',
    'cat *.md',
    'unknown-tool status',
    'printenv',
    'env',
    'export NAME=value',
    'sudo cat README.md',
    'xargs cat README.md',
    'cat .env',
    'cat .env.local',
    'cat ~/.ssh/id_rsa',
    'cat config/private-key.pem',
    'cat credentials.json',
    'cat config/application_default_credentials.json',
    'cat auth-token.txt',
    'cat /proc/self/environ',
    'cat /etc/environment',
    'cat /etc/shadow',
    'cat ../README.md',
    'cat docs/../../README.md',
    'ls /tmp',
    'ls ~/work',
    'cat .mcp.json',
    '/tmp/git status',
    'cat -n',
    'cat .npmrc',
    'cat .netrc',
    'cat .pypirc',
    'cat .aws/credentials',
    'ls .github',
    'cat src/.hidden/config.yaml',
    'cat api-key.txt',
    'cat apikey.txt',
    'cat config/keys.json',
    'cat ssh-key.txt',
    'ls -a',
    'ls -A docs',
    'ls -la',
    'ls -L docs',
    'ls -H docs',
    'ls -f',
  ])('blocks non-provable or secret shell input: %s', (command) => {
    expect(
      shell(command, ['filesystem.read', 'git.status'], makeTempRoot()),
    ).toMatchObject({ allowed: false });
  });

  it('accepts cmd as the RunCommand command field', () => {
    const workspaceRoot = makeTempRoot();
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'Gantry');
    expect(
      evaluateAutoPermissionReadOnlyGate({
        canonicalToolName: 'RunCommand',
        toolInput: { cmd: 'cat README.md' },
        approvedCapabilityIds: ['filesystem.read'],
        workspaceRoot,
      }),
    ).toMatchObject({ allowed: true });
  });

  it('uses reviewed semantic capability bindings for third-party MCP', () => {
    const read = (
      approvedCapabilityIds: string[],
      toolInput: unknown = {},
      reviewedMcpReadBindings = [
        {
          capabilityId: 'mcp.google-drive.files.access',
          toolPattern: 'mcp__google_drive__files_list',
        },
      ],
    ) =>
      evaluateAutoPermissionReadOnlyGate({
        canonicalToolName: 'mcp__google_drive__files_list',
        toolInput,
        approvedCapabilityIds,
        reviewedMcpReadBindings,
      });

    expect(read(['mcp.google-drive.files.access'])).toMatchObject({
      allowed: true,
    });
    expect(read([])).toMatchObject({ allowed: false });
    expect(read(['google.drive.files.list'])).toMatchObject({ allowed: false });
    expect(read(['mcp.google-drive.files.access'], {}, [])).toMatchObject({
      allowed: false,
    });
    expect(
      read(['mcp.google-drive.files.access'], { path: '.env' }),
    ).toMatchObject({ allowed: false });
    expect(
      read(['mcp.google-drive.files.access'], { access_token: 'value' }),
    ).toMatchObject({ allowed: false });
    expect(
      read(['mcp.google-drive.files.access'], {
        credentialProfileRef: 'work',
      }),
    ).toMatchObject({ allowed: true });
    for (const secretSelector of [
      { secretId: 'db-master' },
      { tokenRef: 'deploy' },
      { credentialId: 'prod' },
      { privateKeyName: 'signing' },
      { apiKey: 'sk-value' },
      { api_key: 'sk-value' },
      { API_KEY: 'sk-value' },
    ]) {
      expect(
        read(['mcp.google-drive.files.access'], secretSelector),
      ).toMatchObject({ allowed: false });
    }
    expect(
      read(['mcp.google-drive.files.access'], {
        query: 'Bearer actual-secret-value',
      }),
    ).toMatchObject({ allowed: false });
  });

  it('blocks MCP actions without reviewed read semantics', () => {
    for (const [canonicalToolName, capabilityId] of [
      ['mcp__google_drive__files_delete', 'google.drive.files.delete'],
      ['mcp__vault__secrets_get', 'vault.secrets.get'],
    ]) {
      expect(
        evaluateAutoPermissionReadOnlyGate({
          canonicalToolName,
          toolInput: {},
          approvedCapabilityIds: [capabilityId],
          reviewedMcpReadBindings: [],
        }),
      ).toMatchObject({ allowed: false });
    }
  });
});
