#!/usr/bin/env node

import * as p from '@clack/prompts';
import { runSessionHook } from '../bin/session-hook.js';

import { formatDoctorReport, runDoctorWithNetwork } from './doctor.js';
import { runConfigCommand } from './config.js';
import { runAgentCommand } from './group.js';
import {
  clearOnboardingState,
  createInitialState,
  readOnboardingState,
  writeOnboardingState,
} from './onboarding-state.js';
import { resolveRuntimeHome } from './runtime-home.js';
import {
  applySessionHookInstallPlan,
  buildSessionHookInstallPlan,
  formatSessionHookInstallDiff,
} from './session-hooks.js';
import {
  getServiceStatus,
  installService,
  startService,
  stopService,
} from './service-manager.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflight,
} from './runtime-preflight.js';
import { runSlackConnectCommand } from './slack.js';
import { runSetupFlow } from './setup-flow.js';
import { collectRuntimeStatus, formatRuntimeStatus } from './status.js';
import { ensureRuntimeSettings } from './runtime-settings.js';
import { runMemoryCommand } from './memory.js';
import { runMemoryHookCommand } from './memory-hook.js';
import { runMemoryReplayCommand } from './memory-replay.js';

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
    '  myclaw memory status',
    '  myclaw memory search <query> [--source=<source>] [--limit=<n>]',
    '  myclaw memory list [--source=<source>] [--kind=<kind>] [--limit=<n>]',
    '  myclaw memory show <id>',
    '  myclaw memory reindex [--full]',
    '  myclaw memory embeddings <off|openai>',
    '  myclaw memory dreaming <on|off>',
    '  myclaw memory health journal-status',
    '  myclaw memory health divergence',
    '  myclaw memory counters',
    '  myclaw memory model set <extractor|dreaming|consolidation|sessionSummary> <model>',
    '  myclaw memory model profile <cheap|balanced|quality>',
    '  myclaw session-hook --cause=<session-start|pre-compact|session-stop>',
    '  myclaw memory-hook load',
    '  myclaw memory-hook extract --trigger=<precompact|session-end>',
    '  myclaw memory-replay --from=<journal-dir> --to=<target.db> [--since=YYYY-MM-DD] [--dry-run] [--overwrite] [--compare-with=<live.db>]',
    '  myclaw start',
    '  myclaw restart',
    '  myclaw config list',
    '  myclaw config get <KEY>',
    '  myclaw config set <KEY> <VALUE>',
    '  myclaw config unset <KEY>',
    '  myclaw agent list',
    '  myclaw agent info <jid|folder>',
    '  myclaw agent add <jid|chat-id>',
    '  myclaw agent remove <jid|folder>',
    '  myclaw agent trigger <jid|folder> <word>',
    '  myclaw telegram connect',
    '  myclaw slack connect',
    '  myclaw service install',
    '  myclaw service start',
    '  myclaw service stop',
    '  myclaw service restart',
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
  const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
  p.note(formatDoctorReport(report), 'Doctor');
  return report.ok ? 0 : 1;
}

async function runStatusCommand(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<number> {
  const summary = collectRuntimeStatus(importMetaUrl, runtimeHome);
  p.note(formatRuntimeStatus(summary), 'Status');
  return summary.doctor.ok ? 0 : 1;
}

async function runStartCommand(runtimeHome: string): Promise<number> {
  const validation = validateRuntimePreflight(runtimeHome);
  if (!validation.ok && validation.failure) {
    p.log.error(formatRuntimePreflightFailure(validation.failure));
    return 1;
  }

  process.env.AGENT_ROOT = runtimeHome;
  const runtime = await import('../index.js');
  await runtime.startMyClawRuntime();
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
  const validation = validateRuntimePreflight(runtimeHome);
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
    const validation = validateRuntimePreflight(runtimeHome);
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
    const validation = validateRuntimePreflight(runtimeHome);
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
    | 'doctor'
    | 'runtime_home'
    | 'prerequisites'
    | 'credentials'
    | 'telegram'
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

  const result = await runSetupFlow({
    importMetaUrl: import.meta.url,
    runtimeHome,
    initialStep: startStep,
  });
  if (result.status === 'completed') {
    await promptSessionHookInstall();
    await runStatusCommand(import.meta.url, result.runtimeHome);
    return 0;
  }
  if (result.status === 'resumed') {
    return 0;
  }
  return 1;
}

async function promptSessionHookInstall(): Promise<void> {
  let plan;
  try {
    plan = buildSessionHookInstallPlan();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.warn(
      `Could not update Claude hooks automatically. Next action: fix your ~/.claude/settings.json JSON and rerun setup.\n${message}`,
    );
    return;
  }

  if (!plan.changed) {
    p.note(
      `Claude hooks already configured in ${plan.settingsPath}.`,
      'Claude Hooks',
    );
    return;
  }

  p.note(formatSessionHookInstallDiff(plan), 'Claude Hooks');
  const decision = await p.select({
    message: 'Install these Claude session hooks now?',
    options: [
      {
        value: 'install',
        label: 'Install Hooks (Recommended)',
      },
      {
        value: 'skip',
        label: 'Skip for now',
      },
    ],
  });

  if (p.isCancel(decision) || decision !== 'install') {
    p.log.info('Skipped Claude hook install.');
    return;
  }

  try {
    applySessionHookInstallPlan(plan);
    p.log.success(`Claude hooks installed at ${plan.settingsPath}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.warn(
      `Could not write Claude hooks. Next action: check file permissions and rerun setup.\n${message}`,
    );
  }
}

async function runSmartEntrypoint(runtimeHome: string): Promise<number> {
  const state = readOnboardingState(runtimeHome);
  const validation = validateRuntimePreflight(runtimeHome);
  const isReady = validation.ok;

  if (!isReady || state?.status === 'in_progress') {
    return runSetupCommand(runtimeHome);
  }

  return runStatusCommand(import.meta.url, runtimeHome);
}

async function runTelegramConnectCommand(runtimeHome: string): Promise<number> {
  return runSetupCommand(runtimeHome, 'telegram');
}

async function runSlackConnect(runtimeHome: string): Promise<number> {
  return runSlackConnectCommand(runtimeHome);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  const runtimeHome = resolveRuntimeHome(parsed.runtimeHomeArg);
  const [command, ...rest] = parsed.command;
  const subcommand = rest[0];

  if (command === 'session-hook') {
    await runSessionHook({ argv: rest });
    return 0;
  }

  if (command === 'memory-hook') {
    return runMemoryHookCommand(rest);
  }

  if (command === 'memory-replay') {
    return runMemoryReplayCommand(rest);
  }

  // Allow `myclaw doctor` to run even when settings.yaml is malformed so it can
  // report actionable recovery guidance instead of failing at top-level parse.
  if (command !== 'doctor') {
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

  if (command === 'memory') {
    return runMemoryCommand(runtimeHome, rest);
  }

  if (command === 'start') {
    return runStartCommand(runtimeHome);
  }

  if (command === 'restart') {
    return runRestartCommand(runtimeHome);
  }

  if (command === 'agent') {
    return runAgentCommand(runtimeHome, rest);
  }

  if (command === 'config') {
    return runConfigCommand(runtimeHome, rest);
  }

  if (command === 'telegram' && subcommand === 'connect') {
    return runTelegramConnectCommand(runtimeHome);
  }

  if (command === 'slack' && subcommand === 'connect') {
    return runSlackConnect(runtimeHome);
  }

  if (command === 'service' && subcommand) {
    return runServiceCommand(import.meta.url, runtimeHome, subcommand);
  }

  console.log(usage());
  return 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`MyClaw CLI failed: ${message}`);
    process.exit(1);
  });
