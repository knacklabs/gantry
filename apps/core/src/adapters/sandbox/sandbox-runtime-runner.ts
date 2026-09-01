import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';

export const allowSandboxRuntimeDestination: SandboxAskCallback = async () =>
  true;

export function sandboxRuntimeAskCallback(
  config: Pick<SandboxRuntimeConfig, 'network'>,
): SandboxAskCallback | undefined {
  const parentProxy = config.network.parentProxy;
  return parentProxy?.http || parentProxy?.https
    ? allowSandboxRuntimeDestination
    : undefined;
}

async function main(): Promise<void> {
  const [configPath, command, ...args] = process.argv.slice(2);
  if (!configPath || !command) {
    throw new Error('Sandbox runtime requires config and command arguments.');
  }
  const config = SandboxRuntimeConfigSchema.parse(
    JSON.parse(fs.readFileSync(configPath, 'utf8')),
  );
  await initializeSandboxRuntimeWithRetry(config);
  const sandboxedCommand = await SandboxManager.wrapWithSandbox(
    [command, ...args].map(shellQuote).join(' '),
  );
  const child = spawn(sandboxedCommand, { shell: true, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    process.exit(
      signal
        ? signal === 'SIGINT' || signal === 'SIGTERM'
          ? 0
          : 1
        : (code ?? 0),
    );
  });
  child.on('error', (error) => {
    console.error(`Failed to execute sandboxed command: ${error.message}`);
    process.exit(1);
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

const SANDBOX_INITIALIZATION_MAX_ATTEMPTS = 3;

export async function initializeSandboxRuntimeWithRetry(
  config: SandboxRuntimeConfig,
  dependencies: {
    initialize?: typeof SandboxManager.initialize;
    reset?: typeof SandboxManager.reset;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const initialize =
    dependencies.initialize ?? SandboxManager.initialize.bind(SandboxManager);
  const reset = dependencies.reset ?? SandboxManager.reset.bind(SandboxManager);
  const wait =
    dependencies.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (
    let attempt = 1;
    attempt <= SANDBOX_INITIALIZATION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await initialize(config, sandboxRuntimeAskCallback(config));
      return;
    } catch (error) {
      if (
        !isRetryableSandboxInitializationError(error) ||
        attempt === SANDBOX_INITIALIZATION_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await reset();
      await wait(250 * 2 ** (attempt - 1));
    }
  }
}

export function isRetryableSandboxInitializationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Failed to create bridge sockets') ||
    message.includes('Linux bridge process died unexpectedly')
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(
      `Sandbox runtime failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
