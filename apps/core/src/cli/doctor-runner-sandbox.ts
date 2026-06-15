import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import {
  commandExists,
  detectPlatform,
} from '../infrastructure/service/platform.js';
import type { DoctorCheck } from './doctor.js';

const RUNNER_SANDBOX_CHECK_ID = 'runner-sandbox';
const RUNNER_SANDBOX_CHECK_TITLE = 'Runner Sandbox';

interface RunnerSandboxSettings {
  runtime: {
    sandbox: {
      provider: 'direct' | 'sandbox_runtime';
    };
  };
}

function runnerSandboxCheck(
  input: Omit<DoctorCheck, 'id' | 'title'>,
): DoctorCheck {
  return {
    id: RUNNER_SANDBOX_CHECK_ID,
    title: RUNNER_SANDBOX_CHECK_TITLE,
    ...input,
  };
}

export function inspectRunnerSandbox(
  settings: RunnerSandboxSettings | undefined,
): DoctorCheck | undefined {
  if (!settings) return undefined;
  const sandbox = settings.runtime.sandbox;
  if (sandbox.provider === 'direct') {
    return runnerSandboxCheck({
      status: 'pass',
      message:
        'direct compatibility mode is configured; no outer OS sandbox is enforced and this is not organisation-safe. Setup required: sandbox_runtime is required for safe-host execution.',
    });
  }

  const platform = detectPlatform();
  if (platform === 'windows') {
    return runnerSandboxCheck({
      status: 'fail',
      message: 'sandbox_runtime is not supported on Windows.',
      nextAction:
        'Set runtime.sandbox.provider to direct or run Gantry on macOS/Linux.',
      action: {
        type: 'run_verification',
        label:
          'Set runtime.sandbox.provider to direct or run Gantry on macOS/Linux.',
      },
    });
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgPath =
      require.resolve('@anthropic-ai/sandbox-runtime/package.json');
    const cliPath = path.join(path.dirname(pkgPath), 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      throw new Error(`missing sandbox runtime CLI at ${cliPath}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return runnerSandboxCheck({
      status: 'fail',
      message: `sandbox_runtime is configured but unavailable: ${message}`,
      nextAction: 'Run `npm install`, rebuild Gantry, then rerun doctor.',
      action: {
        type: 'run_verification',
        label: 'Run `npm install`, rebuild Gantry, then rerun doctor.',
      },
    });
  }

  if (platform === 'macos' && !commandExists('sandbox-exec')) {
    return runnerSandboxCheck({
      status: 'fail',
      message: 'sandbox_runtime needs sandbox-exec on macOS.',
      nextAction: 'Run from a normal macOS user session and rerun doctor.',
      action: {
        type: 'run_verification',
        label: 'Run from a normal macOS user session and rerun doctor.',
      },
    });
  }
  if (platform === 'linux') {
    const linuxFailure = inspectLinuxSandboxRuntimeTools();
    if (linuxFailure) return linuxFailure;
  }

  return runnerSandboxCheck({
    status: 'pass',
    message:
      'sandbox_runtime is configured and OS sandbox support is available. Networked CLI/MCP tools must honor standard proxy env or they fail closed.',
  });
}

function inspectLinuxSandboxRuntimeTools(): DoctorCheck | undefined {
  if (!commandExists('bwrap')) {
    return runnerSandboxCheck({
      status: 'fail',
      message: 'sandbox_runtime needs bubblewrap (`bwrap`) on Linux.',
      nextAction: 'Install bubblewrap, socat, and ripgrep, then rerun doctor.',
      action: {
        type: 'run_verification',
        label: 'Install bubblewrap, socat, and ripgrep, then rerun doctor.',
      },
    });
  }
  if (!commandExists('socat')) {
    return runnerSandboxCheck({
      status: 'fail',
      message: 'sandbox_runtime needs socat on Linux for proxy bridging.',
      nextAction: 'Install bubblewrap, socat, and ripgrep, then rerun doctor.',
      action: {
        type: 'run_verification',
        label: 'Install bubblewrap, socat, and ripgrep, then rerun doctor.',
      },
    });
  }
  if (!commandExists('rg')) {
    return runnerSandboxCheck({
      status: 'fail',
      message: 'sandbox_runtime needs ripgrep (`rg`) for deny path detection.',
      nextAction: 'Install bubblewrap, socat, and ripgrep, then rerun doctor.',
      action: {
        type: 'run_verification',
        label: 'Install bubblewrap, socat, and ripgrep, then rerun doctor.',
      },
    });
  }
  return undefined;
}
