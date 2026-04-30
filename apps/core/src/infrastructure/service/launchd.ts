import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildServicePath } from '../../platform/service-path.js';
import {
  runtimeErrorLogPath,
  runtimeLogPath,
} from '../../config/settings/runtime-home.js';
import { tryExec } from './platform.js';

const SERVICE_LABEL = 'com.myclaw';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function launchdPlistPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${SERVICE_LABEL}.plist`,
  );
}

export function writeLaunchdPlist(
  runtimeHome: string,
  runtimeEntry: string,
): void {
  const target = launchdPlistPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const uid = process.getuid?.() || 0;
  const servicePath = buildServicePath(os.homedir());
  const command = `${shellQuote(process.execPath)} ${shellQuote(runtimeEntry)}`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${escapeXml(command)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(runtimeHome)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MYCLAW_HOME</key>
    <string>${escapeXml(runtimeHome)}</string>
    <key>HOME</key>
    <string>${escapeXml(os.homedir())}</string>
    <key>PATH</key>
    <string>${escapeXml(servicePath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(runtimeLogPath(runtimeHome))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(runtimeErrorLogPath(runtimeHome))}</string>
  <key>LimitLoadToSessionType</key>
  <array>
    <string>Aqua</string>
  </array>
</dict>
</plist>
`;
  fs.writeFileSync(target, plist, 'utf-8');
}

export function startLaunchdService(): void {
  const uid = process.getuid?.() || 0;
  const target = launchdPlistPath();
  if (!fs.existsSync(target)) {
    throw new Error('launchd plist is missing. Run `myclaw service install`.');
  }
  const serviceTarget = `gui/${uid}/${SERVICE_LABEL}`;
  const status = tryExec('launchctl', ['print', serviceTarget]);
  if (!status.ok) {
    const loaded = tryExec('launchctl', ['bootstrap', `gui/${uid}`, target]);
    if (!loaded.ok && !loaded.stderr.includes('already bootstrapped')) {
      throw new Error(
        loaded.stderr || loaded.stdout || 'launchctl bootstrap failed',
      );
    }
  }
  const result = tryExec('launchctl', ['kickstart', '-k', serviceTarget]);
  if (!result.ok) {
    throw new Error(
      result.stderr || result.stdout || 'launchctl kickstart failed',
    );
  }
}

export function stopLaunchdService(): void {
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
}

export function getLaunchdServiceStatus(): string {
  const uid = process.getuid?.() || 0;
  const printed = tryExec('launchctl', [
    'print',
    `gui/${uid}/${SERVICE_LABEL}`,
  ]);
  if (printed.ok) {
    const state = /^\s*state = (.+)$/m.exec(printed.stdout)?.[1]?.trim();
    const pid = /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1]?.trim();
    if (state === 'running') return pid ? `running(pid:${pid})` : 'running';
    return state || 'loaded';
  }

  const listing = tryExec('launchctl', ['list']);
  if (!listing.ok) return 'unknown';
  return listing.stdout.includes(SERVICE_LABEL) ? 'loaded' : 'not_loaded';
}
