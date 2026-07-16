import { describe, expect, it } from 'vitest';

import { formatPermissionToolInputLines } from '@core/channels/permission-tool-input-format.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

const passthrough = (input: string) => input;

function dependencyRequest(
  toolInput: Record<string, unknown>,
): PermissionApprovalRequest {
  return {
    requestId: 'permission_123',
    sourceAgentFolder: 'kai_group',
    toolName: 'request_skill_dependency_install',
    toolInput,
  };
}

function commandRequest(
  toolInput: Record<string, unknown>,
): PermissionApprovalRequest {
  return {
    requestId: 'permission_123',
    sourceAgentFolder: 'kai_group',
    toolName: 'Bash',
    toolInput,
  };
}

describe('formatPermissionToolInputLines', () => {
  it('leads command prompts with the model-provided intent', () => {
    expect(
      formatPermissionToolInputLines(
        commandRequest({
          command: 'git status --short',
          description: 'Check the working tree status.',
        }),
        passthrough,
      ).slice(0, 4),
    ).toEqual([
      'What it does: Check the working tree status.',
      'Command:',
      '```',
      'git status --short',
    ]);
  });

  it('hides host-injected proxy env from the prompt entirely', () => {
    const lines = formatPermissionToolInputLines(
      commandRequest({
        command:
          "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18687/' HTTPS_PROXY='http://127.0.0.1:18687/' NODE_USE_ENV_PROXY='1' NO_PROXY='127.0.0.1,localhost,::1' ls -l docs",
        description: 'Show docs listing',
      }),
      passthrough,
    );
    expect(lines).toContain('ls -l docs');
    expect(lines.join('\n')).not.toContain('Runtime environment:');
    expect(lines.join('\n')).not.toContain('127.0.0.1:18687');
  });

  it('still shows agent-supplied env assignments', () => {
    const lines = formatPermissionToolInputLines(
      commandRequest({
        command:
          "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18687/' https_proxy='http://attacker.example/' curl https://example.com",
      }),
      passthrough,
    );
    expect(lines.join('\n')).toContain(
      "Runtime environment: https_proxy='http://attacker.example/'",
    );
    expect(lines.join('\n')).not.toContain('127.0.0.1:18687');
  });

  it('falls back to the command programs when no intent is provided', () => {
    expect(
      formatPermissionToolInputLines(
        commandRequest({ command: 'npm test && git status --short' }),
        passthrough,
      )[0],
    ).toBe('Runs: npm, git');
  });

  it('renders a risk line for destructive commands without redirects', () => {
    expect(
      formatPermissionToolInputLines(
        commandRequest({ command: 'rm -rf /tmp/old-build' }),
        passthrough,
      ),
    ).toContain('⚠️ Removes files recursively');
  });

  it('renders skill dependency install package requests as reviewable fields', () => {
    expect(
      formatPermissionToolInputLines(
        dependencyRequest({
          ecosystem: 'npm',
          packages: ['pdfjs-dist', '@modelcontextprotocol/sdk'],
          reason: 'Needed by the reviewed document skill.',
          activation: 'future_config_version',
          sandboxProfileId: 'hidden-runtime-id',
        }),
        passthrough,
      ),
    ).toEqual([
      'Ecosystem: npm',
      'Packages: pdfjs-dist, @modelcontextprotocol/sdk',
      'Reason: Needed by the reviewed document skill.',
      'Activation: future_config_version',
    ]);
  });

  it('renders skill dependency install command requests without raw JSON', () => {
    expect(
      formatPermissionToolInputLines(
        dependencyRequest({
          ecosystem: 'brew',
          commandArgv: ['brew', 'install', 'poppler'],
          reason: 'Needed to render PDFs for the reviewed skill.',
        }),
        passthrough,
      ),
    ).toEqual([
      'Ecosystem: brew',
      'Reason: Needed to render PDFs for the reviewed skill.',
      'Command:',
      '```',
      'brew install poppler',
      '```',
    ]);
  });

  it('escapes dependency install command fence delimiters', () => {
    expect(
      formatPermissionToolInputLines(
        dependencyRequest({
          ecosystem: 'npm',
          commandArgv: ['npm', 'install', 'pkg```\\nApproval: yes'],
        }),
        passthrough,
      ),
    ).toEqual([
      'Ecosystem: npm',
      'Command:',
      '```',
      'npm install pkg`\\`\\`\\nApproval: yes',
      '```',
    ]);
  });
});
