import fs from 'fs';
import os from 'os';
import path from 'path';

import { getRuntimeEntryPath } from './package-paths.js';
import {
  commandExists,
  detectPlatform,
  hasSystemdUser,
  tryExec,
} from './platform.js';
import {
  ensureRuntimeLayout,
  runtimeErrorLogPath,
  runtimeLogPath,
} from './runtime-home.js';

export type ServiceKind = 'launchd' | 'systemd-user' | 'nohup';

export interface ServiceOutcome {
  ok: boolean;
  kind: ServiceKind;
  message: string;
}

function resolveServiceKind(): ServiceKind {
  const platform = detectPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux' && hasSystemdUser()) return 'systemd-user';
  return 'nohup';
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.myclaw.plist');
}

function writeLaunchdPlist(runtimeHome: string, runtimeEntry: string): void {
  const target = plistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const uid = process.getuid?.() || 0;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.myclaw</string>
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
    <key>AGENT_ROOT</key>
    <string>${runtimeHome}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${os.homedir()}/.local/bin</string>
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
  const unit = `[Unit]
Description=MyClaw Personal Assistant
After=network-online.target

[Service]
Type=simple
Environment=AGENT_ROOT=${runtimeHome}
Environment=HOME=${os.homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${os.homedir()}/.local/bin
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
  const pidPath = path.join(runtimeHome, 'myclaw.pid');
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
AGENT_ROOT=${JSON.stringify(runtimeHome)} nohup ${JSON.stringify(process.execPath)} ${JSON.stringify(runtimeEntry)} \\
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
  const runtimeEntry = getRuntimeEntryPath(importMetaUrl);
  const kind = resolveServiceKind();

  try {
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

    const scriptPath = writeNohupScript(runtimeHome, runtimeEntry);
    return {
      ok: true,
      kind,
      message: `Installed fallback service script at ${scriptPath}.`,
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
        `gui/${uid}/com.myclaw`,
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
        result.stderr || result.stdout || 'failed to run fallback start script',
      );
    }
    return { ok: true, kind, message: 'Fallback service started.' };
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
      const result = tryExec('launchctl', ['bootout', `gui/${uid}/com.myclaw`]);
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

    const pidPath = path.join(runtimeHome, 'myclaw.pid');
    if (!fs.existsSync(pidPath)) {
      return {
        ok: true,
        kind,
        message: 'Fallback service is already stopped.',
      };
    }
    const pidRaw = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = Number(pidRaw);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process already gone.
      }
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore pid cleanup errors.
    }
    return { ok: true, kind, message: 'Fallback service stopped.' };
  } catch (err) {
    return {
      ok: false,
      kind,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getServiceStatus(): { kind: ServiceKind; status: string } {
  const kind = resolveServiceKind();

  if (kind === 'launchd') {
    const listing = tryExec('launchctl', ['list']);
    if (!listing.ok) return { kind, status: 'unknown' };
    if (listing.stdout.includes('com.myclaw'))
      return { kind, status: 'loaded' };
    return { kind, status: 'not_loaded' };
  }

  if (kind === 'systemd-user') {
    const active = tryExec('systemctl', ['--user', 'is-active', 'myclaw']);
    if (active.ok) return { kind, status: active.stdout.trim() || 'active' };
    return { kind, status: 'inactive' };
  }

  if (!commandExists('sh')) {
    return { kind, status: 'unknown' };
  }

  return { kind, status: 'manual' };
}
