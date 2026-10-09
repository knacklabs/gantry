import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Fix owner: the-two-agent-engines-use-different-diag.
describe('Runner diagnostics', () => {
  it.each(['anthropic-claude-agent', 'deepagents-langchain'])(
    '%s emits sanitized diagnostics on stderr without a runner switch',
    async (engine) => {
      const workspace = fs.mkdtempSync(
        path.join(os.tmpdir(), 'runner-diagnostics-'),
      );
      const entry = path.resolve(
        __dirname,
        `../../src/adapters/llm/${engine}/runner/index.ts`,
      );
      const child = spawn(process.execPath, ['--import', 'tsx', entry], {
        // No inherited credentials or runner-specific diagnostic configuration.
        env: {
          PATH: process.env.PATH,
          LOG_LEVEL: 'info',
          GANTRY_WORKSPACE_GROUP_DIR: workspace,
          GANTRY_WORKSPACE_EXTRA_DIR: workspace,
          GANTRY_IPC_DIR: workspace,
          GANTRY_IPC_INPUT_DIR: path.join(workspace, 'input'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
      try {
        // Startup diagnostics precede provider work. Invalid configuration stops
        // Claude before its SDK query; missing checkpointer stops DeepAgents.
        child.stdin.end(
          JSON.stringify({
            workspaceFolder:
              'diagnostic-group sessionId=sensitive-session api_key=sensitive-key',
            prompt: 'hello',
            compiledSystemPrompt: 42,
          }),
        );
        await exited;
        expect(
          child.signalCode,
          `stdout: ${stdout}\nstderr: ${stderr}`,
        ).toBeNull();
        expect(stderr).toContain('Received input for group: diagnostic-group');
        expect(stderr).toContain('sessionId=[REDACTED]');
        expect(stderr).toContain('api_key=[REDACTED]');
        expect(stderr).not.toContain('sensitive-session');
        expect(stderr).not.toContain('sensitive-key');
        expect(stdout).not.toContain('Received input for group');
        // Any stdout belongs exclusively to the runner frame protocol.
        expect(
          stdout.replace(
            /---GANTRY_OUTPUT_START---\n[\s\S]*?\n---GANTRY_OUTPUT_END---\n/g,
            '',
          ),
        ).toBe('');
      } finally {
        clearTimeout(timeout);
        child.kill('SIGKILL');
        await exited;
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
