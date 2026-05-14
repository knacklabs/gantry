#!/usr/bin/env node

import './runtime-home-env-bootstrap.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as p from '@clack/prompts';
import '../channels/register-builtins.js';

import {
  clearOnboardingState,
  createInitialState,
  readOnboardingState,
  writeOnboardingState,
} from './onboarding-state.js';
import {
  resolveRuntimeHome,
  runtimeErrorLogPath,
  runtimeLogPath,
  settingsFilePath,
} from '../config/settings/runtime-home.js';
import {
  getServiceStatus,
  installService,
  startService,
  stopService,
} from '../infrastructure/service/manager.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';

interface ParsedArgs {
  command: string[];
  runtimeHomeArg?: string;
  help: boolean;
}

function usage(): string {
  return [
    'MyClaw CLI',
    '',
    'Usage:',
    '  myclaw',
    '  myclaw setup',
    '  myclaw doctor',
    '  myclaw status',
    '  myclaw start',
    '  myclaw stop',
    '  myclaw restart',
    '  myclaw logs',
    '  myclaw local setup|start|stop|status|logs|doctor',
    '  myclaw provider list|connect|doctor',
    '  myclaw conversation info|approvers  # direct/private and group/channel permission approvers',
    '  myclaw agent list|info|add|remove|trigger|policy',
    '  myclaw browser profiles|status',
    '  myclaw jobs list|show|events',
    '  myclaw model list|set-default|doctor',
    '  myclaw settings export-current|drift',
    '  myclaw service install|start|stop|restart',
    '  myclaw skill draft upload <skill.zip> [--agent <agentId>] [--created-by <id>]',
    '  myclaw mcp draft|list|approve|reject|test|disable|bind|unbind|agent',
    '',
    'Options:',
    '  --runtime-home <path>   Override runtime home (default: ~/myclaw)',
    '  -h, --help              Show help',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  let runtimeHomeArg: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--runtime-home') {
      runtimeHomeArg = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--runtime-home=')) {
      runtimeHomeArg = arg.slice('--runtime-home='.length);
      continue;
    }
    command.push(arg);
  }

  return { command, runtimeHomeArg, help };
}

async function runDoctorCommand(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<number> {
  const { formatDoctorReport, runDoctorWithNetwork } =
    await import('./doctor.js');
  const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
  p.note(formatDoctorReport(report), 'Doctor');
  return report.ok ? 0 : 1;
}

async function runStatusCommand(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<number> {
  const { collectRuntimeStatus, formatRuntimeStatus } =
    await import('./status.js');
  const summary = await collectRuntimeStatus(importMetaUrl, runtimeHome);
  p.note(formatRuntimeStatus(summary), 'Status');
  return summary.doctor.ok ? 0 : 1;
}

async function runStartCommand(runtimeHome: string): Promise<number> {
  const validation = await validateRuntimePreflightWithStorage(runtimeHome);
  if (!validation.ok && validation.failure) {
    p.log.error(formatRuntimePreflightFailure(validation.failure));
    return 1;
  }

  process.env.MYCLAW_HOME = runtimeHome;
  const runtime = await import('../app/index.js');
  await runtime.startMyClawRuntime({ skipPreflight: true });
  return 0;
}

async function runStopCommand(runtimeHome: string): Promise<number> {
  const serviceOutcome = stopService(runtimeHome);
  if (!serviceOutcome.ok) {
    const message = `Runtime stop failed: ${serviceOutcome.message}`;
    p.log.error(message);
    return 1;
  } else {
    p.log.success(serviceOutcome.message);
  }
  return 0;
}

function tailFile(filePath: string, maxBytes = 20_000): string {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf-8').trim() || '<no logs>';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '<log file not found>';
  }
}

async function runLogsCommand(runtimeHome: string): Promise<number> {
  const logPath = runtimeLogPath(runtimeHome);
  const errorLogPath = runtimeErrorLogPath(runtimeHome);
  p.note(tailFile(logPath), `Runtime Log (${path.basename(logPath)})`);
  p.note(
    tailFile(errorLogPath),
    `Runtime Error Log (${path.basename(errorLogPath)})`,
  );

  return 0;
}

function restartService(runtimeHome: string): ReturnType<typeof stopService> {
  const serviceStatus = getServiceStatus(runtimeHome);
  // launchd uses kickstart -k for in-place restart; bootout first can unload it.
  if (serviceStatus.kind === 'launchd') {
    return startService(runtimeHome);
  }

  const stopOutcome = stopService(runtimeHome);
  if (!stopOutcome.ok) return stopOutcome;
  const startOutcome = startService(runtimeHome);
  if (!startOutcome.ok) {
    return {
      ok: false,
      kind: startOutcome.kind,
      message: `Restart failed after stop: ${startOutcome.message}`,
    };
  }
  return {
    ok: true,
    kind: startOutcome.kind,
    message: `${startOutcome.message} (restart completed).`,
  };
}

async function runRestartCommand(runtimeHome: string): Promise<number> {
  const validation = await validateRuntimePreflightWithStorage(runtimeHome);
  if (!validation.ok && validation.failure) {
    p.log.error(formatRuntimePreflightFailure(validation.failure));
    return 1;
  }
  const outcome = restartService(runtimeHome);
  if (!outcome.ok) {
    p.log.error(`Service restart failed: ${outcome.message}`);
    return 1;
  }
  p.log.success(outcome.message);
  return 0;
}

async function runServiceCommand(
  importMetaUrl: string,
  runtimeHome: string,
  action: string,
): Promise<number> {
  if (action === 'install') {
    const outcome = installService(importMetaUrl, runtimeHome);
    if (!outcome.ok) {
      p.log.error(`Service install failed: ${outcome.message}`);
      return 1;
    }
    p.log.success(outcome.message);
    return 0;
  }

  if (action === 'start') {
    const validation = await validateRuntimePreflightWithStorage(runtimeHome);
    if (!validation.ok && validation.failure) {
      p.log.error(formatRuntimePreflightFailure(validation.failure));
      return 1;
    }
    const outcome = startService(runtimeHome);
    if (!outcome.ok) {
      p.log.error(`Service start failed: ${outcome.message}`);
      return 1;
    }
    p.log.success(outcome.message);
    return 0;
  }

  if (action === 'stop') {
    const outcome = stopService(runtimeHome);
    if (!outcome.ok) {
      p.log.error(`Service stop failed: ${outcome.message}`);
      return 1;
    }
    p.log.success(outcome.message);
    return 0;
  }

  if (action === 'restart') {
    const validation = await validateRuntimePreflightWithStorage(runtimeHome);
    if (!validation.ok && validation.failure) {
      p.log.error(formatRuntimePreflightFailure(validation.failure));
      return 1;
    }
    const outcome = restartService(runtimeHome);
    if (!outcome.ok) {
      p.log.error(`Service restart failed: ${outcome.message}`);
      return 1;
    }
    p.log.success(outcome.message);
    return 0;
  }

  p.log.error('Unknown service command. Use install, start, stop, or restart.');
  return 1;
}

async function runSetupCommand(
  runtimeHome: string,
  initialStep?:
    | 'welcome'
    | 'runtime_home'
    | 'storage'
    | 'prerequisites'
    | 'channel'
    | 'credentials'
    | 'model'
    | 'telegram'
    | 'slack'
    | 'memory'
    | 'embeddings'
    | 'dreaming'
    | 'config'
    | 'group'
    | 'service'
    | 'verify'
    | 'ready',
): Promise<number> {
  const state = readOnboardingState(runtimeHome);
  let startStep = initialStep;

  if (state?.status === 'completed' && !initialStep) {
    clearOnboardingState(runtimeHome);
    writeOnboardingState(runtimeHome, createInitialState(runtimeHome));
    startStep = 'welcome';
  }

  if (state?.status === 'in_progress' && !initialStep) {
    const decision = await p.select({
      message: 'You already have an unfinished setup. What do you want to do?',
      options: [
        {
          value: 'resume',
          label: 'Resume previous setup (Recommended)',
        },
        {
          value: 'restart',
          label: 'Start from the beginning',
        },
        {
          value: 'cancel',
          label: 'Cancel',
        },
      ],
    });
    if (p.isCancel(decision) || decision === 'cancel') {
      p.outro('Setup cancelled.');
      return 1;
    }
    if (decision === 'resume') {
      startStep = state.currentStep;
    }
    if (decision === 'restart') {
      clearOnboardingState(runtimeHome);
      writeOnboardingState(runtimeHome, createInitialState(runtimeHome));
      startStep = 'welcome';
    }
  }

  const { runSetupFlow } = await import('./setup-flow.js');
  const result = await runSetupFlow({
    importMetaUrl: import.meta.url,
    runtimeHome,
    initialStep: startStep,
  });
  if (result.status === 'completed') {
    if (result.startAfterSetup) {
      return runStartCommand(result.runtimeHome);
    }
    return 0;
  }
  if (result.status === 'resumed') {
    return 0;
  }
  return 1;
}

async function runSmartEntrypoint(runtimeHome: string): Promise<number> {
  const state = readOnboardingState(runtimeHome);
  if (!fs.existsSync(settingsFilePath(runtimeHome))) {
    return runSetupCommand(runtimeHome);
  }

  const validation = await validateRuntimePreflightWithStorage(runtimeHome);
  const { hasProcessableGroupForConfiguredChannel, hasRuntimeConfig } =
    await import('./doctor.js');
  const isReady =
    validation.ok &&
    hasRuntimeConfig(runtimeHome) &&
    (await hasProcessableGroupForConfiguredChannel(runtimeHome));

  if (state?.status === 'in_progress') {
    return runSetupCommand(runtimeHome);
  }

  if (!isReady) {
    return runSetupCommand(runtimeHome);
  }

  return runStatusCommand(import.meta.url, runtimeHome);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  const runtimeHome = resolveRuntimeHome(parsed.runtimeHomeArg);
  const [command, ...rest] = parsed.command;
  const subcommand = rest[0];

  // Allow `myclaw doctor` to run even when settings.yaml is malformed so it can
  // report actionable recovery guidance instead of failing at top-level parse.
  if (
    command &&
    command !== 'doctor' &&
    command !== 'setup' &&
    command !== 'local' &&
    command !== 'stop' &&
    command !== 'logs'
  ) {
    ensureRuntimeSettings(runtimeHome);
  }

  if (!command) {
    return runSmartEntrypoint(runtimeHome);
  }

  if (command === 'setup') {
    return runSetupCommand(runtimeHome);
  }

  if (command === 'doctor') {
    return runDoctorCommand(import.meta.url, runtimeHome);
  }

  if (command === 'status') {
    return runStatusCommand(import.meta.url, runtimeHome);
  }

  if (command === 'local') {
    const { runLocalCommand } = await import('./local.js');
    return runLocalCommand(runtimeHome, rest);
  }

  if (command === 'provider') {
    const { runProviderCommand } = await import('./provider.js');
    return runProviderCommand(import.meta.url, runtimeHome, rest);
  }

  if (command === 'conversation') {
    const { runConversationCommand } = await import('./provider.js');
    return runConversationCommand(runtimeHome, rest);
  }

  if (command === 'channel') {
    p.log.error('Use `myclaw provider` or `myclaw conversation`.');
    return 1;
  }

  if (command === 'memory') {
    const { runMemoryCommand } = await import('./memory.js');
    return runMemoryCommand(runtimeHome, rest);
  }

  if (command === 'browser') {
    process.env.MYCLAW_HOME = runtimeHome;
    const { runBrowserCommand } = await import('./browser.js');
    return runBrowserCommand(runtimeHome, rest);
  }

  if (command === 'model') {
    const { runModelCommand } = await import('./model.js');
    return runModelCommand(runtimeHome, rest);
  }

  if (command === 'jobs') {
    const { runJobsCommand } = await import('./jobs.js');
    return runJobsCommand(runtimeHome, rest);
  }

  if (command === 'settings') {
    const { runSettingsCommand } = await import('./settings.js');
    return runSettingsCommand(runtimeHome, rest);
  }

  if (command === 'skill') {
    const { runSkillCommand } = await import('./skills.js');
    return runSkillCommand(runtimeHome, rest);
  }

  if (command === 'mcp') {
    const { runMcpCommand } = await import('./mcp.js');
    return runMcpCommand(runtimeHome, rest);
  }

  if (command === 'start') {
    return runStartCommand(runtimeHome);
  }

  if (command === 'stop') {
    return runStopCommand(runtimeHome);
  }

  if (command === 'restart') {
    return runRestartCommand(runtimeHome);
  }

  if (command === 'logs') {
    return runLogsCommand(runtimeHome);
  }

  if (command === 'agent') {
    const { runAgentCommand } = await import('./group.js');
    return runAgentCommand(runtimeHome, rest);
  }

  if (command === 'config') {
    const { runConfigCommand } = await import('./config.js');
    return runConfigCommand(runtimeHome, rest);
  }

  if (command === 'service' && subcommand) {
    return runServiceCommand(import.meta.url, runtimeHome, subcommand);
  }

  console.log(usage());
  return 1;
}

const invokedPath = process.argv[1]
  ? fs.realpathSync.native(process.argv[1])
  : undefined;

if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`MyClaw CLI failed: ${message}`);
      process.exit(1);
    });
}
