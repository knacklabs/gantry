import { execFileSync, spawnSync } from 'child_process';
import os from 'os';
export function detectPlatform() {
    const platform = os.platform();
    if (platform === 'darwin')
        return 'macos';
    if (platform === 'linux')
        return 'linux';
    if (platform === 'win32')
        return 'windows';
    return 'unknown';
}
export function commandExists(command) {
    try {
        const detector = detectPlatform() === 'windows' ? 'where' : 'which';
        execFileSync(detector, [command], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
export function tryExec(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf-8',
        env: options.env,
        input: options.input,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return {
        ok: result.status === 0,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
    };
}
export function getNodeVersion() {
    return process.version.replace(/^v/, '');
}
export function getNodeMajorVersion() {
    const raw = getNodeVersion().split('.')[0];
    const major = Number(raw);
    return Number.isFinite(major) ? major : 0;
}
export function hasSystemdUser() {
    if (detectPlatform() !== 'linux')
        return false;
    if (!commandExists('systemctl'))
        return false;
    return tryExec('systemctl', ['--user', 'show-environment']).ok;
}
