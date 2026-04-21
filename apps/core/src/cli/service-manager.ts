import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import path from 'path';

import { getRuntimeEntryPath } from './package-paths.js';
import { detectPlatform, hasSystemdUser, tryExec } from './platform.js';
import { buildServicePath } from '../platform/service-path.js';
import {
  ensureRuntimeLayout,
  runtimeErrorLogPath,
  runtimeLogPath,
} from './runtime-home.js';
import { ensureRuntimeSettings } from './runtime-settings.js';

export type ServiceKind = 'launchd' | 'systemd-user' | 'nohup' | 'background';

export interface ServiceOutcome {
  ok: boolean;
  kind: ServiceKind;
  message: string;
}

const SERVICE_LABEL = 'com.myclaw';
const FALLBACK_SERVICE_META = 'service-meta.json';
const PID_FILE = 'myclaw.pid';

function resolveServiceKind(): ServiceKind {
  const platform = detectPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux' && hasSystemdUser()) return 'systemd-user';
  if (platform === 'linux') return 'nohup';
  return 'background';
}

interface FallbackServiceMetadata {
  runtimeEntry: string;
}

function serviceMetaPath(runtimeHome: string): string {
  return path.join(runtimeHome, FALLBACK_SERVICE_META);
}

function writeFallbackServiceMetadata(
  runtimeHome: string,
  runtimeEntry: string,
): void {
  const metadata: FallbackServiceMetadata = { runtimeEntry };
  fs.writeFileSync(
    serviceMetaPath(runtimeHome),
    JSON.stringify(metadata, null, 2),
    'utf-8',
  );
}

function readFallbackServiceMetadata(
  runtimeHome: string,
): FallbackServiceMetadata | null {
  try {
    const raw = fs.readFileSync(serviceMetaPath(runtimeHome), 'utf-8');
    const parsed = JSON.parse(raw) as { runtimeEntry?: unknown };
    if (typeof parsed.runtimeEntry !== 'string') return null;
    const runtimeEntry = path.resolve(parsed.runtimeEntry);
    if (!fs.existsSync(runtimeEntry)) return null;
    return { runtimeEntry };
  } catch {
    return null;
  }
}

function fallbackPidPath(runtimeHome: string): string {
  return path.join(runtimeHome, PID_FILE);
}

function readFallbackPid(runtimeHome: string): number | null {
  try {
    const raw = fs.readFileSync(fallbackPidPath(runtimeHome), 'utf-8').trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function clearFallbackPid(runtimeHome: string): void {
  try {
    fs.unlinkSync(fallbackPidPath(runtimeHome));
  } catch {
    // Ignore pid cleanup errors.
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'EPERM'
    ) {
      return true;
    }
    return false;
  }
}

function stopFallbackPid(pid: number): void {
  if (process.platform === 'win32') {
    const result = tryExec('taskkill', ['/PID', String(pid), '/T', '/F']);
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const notFound =
      output.includes('not found') ||
      output.includes('no running instance') ||
      output.includes('cannot find');
    if (!result.ok && !notFound) {
      throw new Error(result.stderr || result.stdout || 'taskkill failed');
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ESRCH'
    ) {
      return;
    }
    throw err;
  }
}

function readProcessCommand(pid: number): string | null {
  if (process.platform === 'win32') {
    const query = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
    const result = tryExec('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      query,
    ]);
    if (!result.ok) return null;
    const output = result.stdout.trim();
    return output || null;
  }

  const result = tryExec('ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  if (!result.ok) return null;
  const output = result.stdout.trim();
  return output || null;
}

function isManagedFallbackProcess(
  pid: number,
  runtimeEntry: string,
): boolean | null {
  const command = readProcessCommand(pid);
  if (!command) return null;
  const normalizedCommand = command.replace(/\\/g, '/');
  const normalizedRuntimeEntry = path.resolve(runtimeEntry).replace(/\\/g, '/');
  return normalizedCommand.includes(normalizedRuntimeEntry);
}

function plistPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${SERVICE_LABEL}.plist`,
  );
}

function writeLaunchdPlist(runtimeHome: string, runtimeEntry: string): void {
  const target = plistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const uid = process.getuid?.() || 0;
  const servicePath = buildServicePath(os.homedir());
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${runtimeEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${runtimeHome}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MYCLAW_HOME</key>
    <string>${runtimeHome}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
    <key>PATH</key>
    <string>${servicePath}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${runtimeLogPath(runtimeHome)}</string>
  <key>StandardErrorPath</key>
  <string>${runtimeErrorLogPath(runtimeHome)}</string>
  <key>LimitLoadToSessionType</key>
  <array>
    <string>Aqua</string>
  </array>
</dict>
</plist>
`;
  fs.writeFileSync(target, plist, 'utf-8');

  tryExec('launchctl', ['bootout', `gui/${uid}`, target]);
  const loaded = tryExec('launchctl', ['bootstrap', `gui/${uid}`, target]);
  if (!loaded.ok && !loaded.stderr.includes('already bootstrapped')) {
    throw new Error(
      loaded.stderr || loaded.stdout || 'launchctl bootstrap failed',
    );
  }
}

function writeSystemdUnit(runtimeHome: string, runtimeEntry: string): string {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'myclaw.service');
  fs.mkdirSync(unitDir, { recursive: true });
  const servicePath = buildServicePath(os.homedir());
  const unit = `[Unit]
Description=MyClaw Personal Assistant
After=network-online.target

[Service]
Type=simple
Environment=MYCLAW_HOME=${runtimeHome}
Environment=HOME=${os.homedir()}
Environment=PATH=${servicePath}
ExecStart=${process.execPath} ${runtimeEntry}
WorkingDirectory=${runtimeHome}
Restart=always
RestartSec=5
StandardOutput=append:${runtimeLogPath(runtimeHome)}
StandardError=append:${runtimeErrorLogPath(runtimeHome)}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, 'utf-8');
  return unitPath;
}

function writeNohupScript(runtimeHome: string, runtimeEntry: string): string {
  const scriptPath = path.join(runtimeHome, 'start-myclaw.sh');
  const pidPath = fallbackPidPath(runtimeHome);
  const script = `#!/bin/sh
set -eu
cd ${JSON.stringify(runtimeHome)}
if [ -f ${JSON.stringify(pidPath)} ]; then
  OLD_PID=$(cat ${JSON.stringify(pidPath)} 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" || true
    sleep 1
  fi
fi
MYCLAW_HOME=${JSON.stringify(runtimeHome)} nohup ${JSON.stringify(process.execPath)} ${JSON.stringify(runtimeEntry)} \\
  >> ${JSON.stringify(runtimeLogPath(runtimeHome))} \\
  2>> ${JSON.stringify(runtimeErrorLogPath(runtimeHome))} &
echo $! > ${JSON.stringify(pidPath)}
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

export function installService(
  importMetaUrl: string,
  runtimeHome: string,
): ServiceOutcome {
  ensureRuntimeLayout(runtimeHome);
  ensureRuntimeSettings(runtimeHome);
  const runtimeEntry = getRuntimeEntryPath(importMetaUrl);
  const kind = resolveServiceKind();

  try {
    writeFallbackServiceMetadata(runtimeHome, runtimeEntry);

    if (kind === 'launchd') {
      writeLaunchdPlist(runtimeHome, runtimeEntry);
      return {
        ok: true,
        kind,
        message: `Installed launchd service at ${plistPath()}.`,
      };
    }

    if (kind === 'systemd-user') {
      const unitPath = writeSystemdUnit(runtimeHome, runtimeEntry);
      const reload = tryExec('systemctl', ['--user', 'daemon-reload']);
      if (!reload.ok) {
        throw new Error(
          reload.stderr || reload.stdout || 'systemctl daemon-reload failed',
        );
      }
      const enable = tryExec('systemctl', ['--user', 'enable', 'myclaw']);
      if (!enable.ok) {
        throw new Error(
          enable.stderr || enable.stdout || 'systemctl enable failed',
        );
      }
      return {
        ok: true,
        kind,
        message: `Installed systemd user service at ${unitPath}.`,
      };
    }

    if (kind === 'nohup') {
      const scriptPath = writeNohupScript(runtimeHome, runtimeEntry);
      return {
        ok: true,
        kind,
        message: `Installed fallback service script at ${scriptPath}.`,
      };
    }

    return {
      ok: true,
      kind,
      message: 'Installed background service metadata.',
    };
  } catch (err) {
    return {
      ok: false,
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startService(runtimeHome: string): ServiceOutcome {
  const kind = resolveServiceKind();
  try {
    if (kind === 'launchd') {
      const uid = process.getuid?.() || 0;
      const result = tryExec('launchctl', [
        'kickstart',
        '-k',
        `gui/${uid}/${SERVICE_LABEL}`,
      ]);
      if (!result.ok) {
        throw new Error(
          result.stderr || result.stdout || 'launchctl kickstart failed',
        );
      }
      return { ok: true, kind, message: 'launchd service started.' };
    }

    if (kind === 'systemd-user') {
      const result = tryExec('systemctl', ['--user', 'start', 'myclaw']);
      if (!result.ok) {
        throw new Error(
          result.stderr || result.stdout || 'systemctl start failed',
        );
      }
      return { ok: true, kind, message: 'systemd user service started.' };
    }

    if (kind === 'nohup') {
      const scriptPath = path.join(runtimeHome, 'start-myclaw.sh');
      if (!fs.existsSync(scriptPath)) {
        return {
          ok: false,
          kind,
          message:
            'Fallback service script is missing. Run `myclaw service install` first.',
        };
      }
      const result = tryExec('sh', [scriptPath]);
      if (!result.ok) {
        throw new Error(
          result.stderr ||
            result.stdout ||
            'failed to run fallback start script',
        );
      }
      return { ok: true, kind, message: 'Fallback service started.' };
    }

    const metadata = readFallbackServiceMetadata(runtimeHome);
    if (!metadata) {
      return {
        ok: false,
        kind,
        message:
          'Background service metadata is missing or invalid. Run `myclaw service install` first.',
      };
    }

    const currentPid = readFallbackPid(runtimeHome);
    if (currentPid && isProcessRunning(currentPid)) {
      const owned = isManagedFallbackProcess(currentPid, metadata.runtimeEntry);
      if (owned === false) {
        return {
          ok: false,
          kind,
          message: `Refusing to use PID file because pid ${currentPid} is not a MyClaw process. Fix ${fallbackPidPath(runtimeHome)} manually.`,
        };
      }
      if (owned === null) {
        return {
          ok: false,
          kind,
          message: `Could not verify ownership for running pid ${currentPid}. Resolve manually before restarting service.`,
        };
      }
      return {
        ok: true,
        kind,
        message: `Background service is already running (pid ${currentPid}).`,
      };
    }
    clearFallbackPid(runtimeHome);

    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    try {
      stdoutFd = fs.openSync(runtimeLogPath(runtimeHome), 'a');
      stderrFd = fs.openSync(runtimeErrorLogPath(runtimeHome), 'a');
      const child = spawn(process.execPath, [metadata.runtimeEntry], {
        cwd: runtimeHome,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
        env: {
          ...process.env,
          MYCLAW_HOME: runtimeHome,
          HOME: os.homedir(),
          PATH: buildServicePath(os.homedir()),
        },
      });
      if (!child.pid) {
        throw new Error('failed to spawn background process');
      }
      try {
        fs.writeFileSync(
          fallbackPidPath(runtimeHome),
          `${child.pid}\n`,
          'utf-8',
        );
      } catch (err) {
        try {
          stopFallbackPid(child.pid);
        } catch {
          // Best effort cleanup; preserve original write error.
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to persist service pid: ${reason}`);
      }
      child.unref();
    } finally {
      if (stdoutFd !== null) {
        try {
          fs.closeSync(stdoutFd);
        } catch {
          // Ignore fd cleanup errors.
        }
      }
      if (stderrFd !== null) {
        try {
          fs.closeSync(stderrFd);
        } catch {
          // Ignore fd cleanup errors.
        }
      }
    }
    return { ok: true, kind, message: 'Background service started.' };
  } catch (err) {
    return {
      ok: false,
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function stopService(runtimeHome: string): ServiceOutcome {
  const kind = resolveServiceKind();
  try {
    if (kind === 'launchd') {
      const uid = process.getuid?.() || 0;
      const result = tryExec('launchctl', [
        'bootout',
        `gui/${uid}/${SERVICE_LABEL}`,
      ]);
      if (!result.ok && !result.stderr.includes('Could not find service')) {
        throw new Error(
          result.stderr || result.stdout || 'launchctl bootout failed',
        );
      }
      return { ok: true, kind, message: 'launchd service stopped.' };
    }

    if (kind === 'systemd-user') {
      const result = tryExec('systemctl', ['--user', 'stop', 'myclaw']);
      if (!result.ok) {
        throw new Error(
          result.stderr || result.stdout || 'systemctl stop failed',
        );
      }
      return { ok: true, kind, message: 'systemd user service stopped.' };
    }

    const pid = readFallbackPid(runtimeHome);
    if (!pid) {
      return {
        ok: true,
        kind,
        message: 'Fallback service is already stopped.',
      };
    }

    if (!isProcessRunning(pid)) {
      clearFallbackPid(runtimeHome);
      return {
        ok: true,
        kind,
        message:
          'Fallback service was already stopped (stale PID file removed).',
      };
    }

    const metadata = readFallbackServiceMetadata(runtimeHome);
    if (!metadata) {
      return {
        ok: false,
        kind,
        message:
          'Cannot verify fallback process ownership because service metadata is missing. Refusing to kill PID from file.',
      };
    }

    const owned = isManagedFallbackProcess(pid, metadata.runtimeEntry);
    if (owned === false) {
      return {
        ok: false,
        kind,
        message: `Refusing to stop pid ${pid} because it is not a MyClaw process.`,
      };
    }
    if (owned === null) {
      return {
        ok: false,
        kind,
        message: `Could not verify ownership for pid ${pid}; refusing to stop an unverified process.`,
      };
    }

    stopFallbackPid(pid);
    clearFallbackPid(runtimeHome);
    return { ok: true, kind, message: 'Fallback service stopped.' };
  } catch (err) {
    return {
      ok: false,
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getServiceStatus(runtimeHome: string): {
  kind: ServiceKind;
  status: string;
} {
  const kind = resolveServiceKind();

  if (kind === 'launchd') {
    const listing = tryExec('launchctl', ['list']);
    if (!listing.ok) return { kind, status: 'unknown' };
    if (listing.stdout.includes(SERVICE_LABEL))
      return { kind, status: 'loaded' };
    return { kind, status: 'not_loaded' };
  }

  if (kind === 'systemd-user') {
    const active = tryExec('systemctl', ['--user', 'is-active', 'myclaw']);
    if (active.ok) return { kind, status: active.stdout.trim() || 'active' };
    return { kind, status: 'inactive' };
  }

  const pid = readFallbackPid(runtimeHome);
  if (!pid) return { kind, status: 'not_running' };
  return {
    kind,
    status: isProcessRunning(pid) ? `running(pid:${pid})` : 'stale_pid',
  };
}
