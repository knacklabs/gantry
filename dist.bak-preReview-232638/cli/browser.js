import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import * as p from '@clack/prompts';
import { resolveChromeExecutablePath } from '../shared/chrome-executable.js';
function formatDate(value) {
    if (!value)
        return 'never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toISOString();
}
function readJson(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed && typeof parsed === 'object'
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || Number(pid) <= 0)
        return false;
    try {
        process.kill(Number(pid), 0);
        return true;
    }
    catch {
        return false;
    }
}
function readPidCommandLine(pid) {
    if (!Number.isInteger(pid) || Number(pid) <= 0)
        return '';
    try {
        return execFileSync('/bin/ps', ['-p', String(pid), '-ww', '-o', 'command='], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return '';
    }
}
function isPidOwnedByProfile(pid, userDataDir) {
    const commandLine = readPidCommandLine(pid);
    if (!commandLine)
        return false;
    const resolved = path.resolve(userDataDir);
    return (commandLine.includes(`--user-data-dir=${resolved}`) ||
        commandLine.includes(`--user-data-dir="${resolved}"`) ||
        commandLine.includes(`--user-data-dir='${resolved}'`));
}
async function isCdpReady(port) {
    if (!Number.isInteger(port) || Number(port) <= 0 || Number(port) > 65535) {
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: controller.signal,
        });
        return response.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
function hasProfileState(dir) {
    if (fs.existsSync(path.join(dir, 'state.json')))
        return true;
    const userDataDir = path.join(dir, 'user-data');
    try {
        return fs.readdirSync(userDataDir).length > 0;
    }
    catch {
        return false;
    }
}
function chromeExecutable() {
    return resolveChromeExecutablePath();
}
async function listProfiles(runtimeHome) {
    const root = path.join(runtimeHome, 'data', 'browser-profiles');
    if (!fs.existsSync(root))
        return [];
    const profiles = await Promise.all(fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
        const dir = path.join(root, entry.name);
        const userDataDir = path.join(dir, 'user-data');
        const metadata = readJson(path.join(dir, 'profile.json'));
        const session = readJson(path.join(dir, 'browser-session.json'));
        const authMarkers = Array.isArray(metadata.auth_markers)
            ? metadata.auth_markers.filter((item) => typeof item === 'string')
            : [];
        const running = isPidAlive(session.pid) &&
            isPidOwnedByProfile(session.pid, userDataDir);
        return {
            name: entry.name,
            last_used: typeof metadata.last_used === 'string'
                ? metadata.last_used
                : undefined,
            auth_markers: authMarkers,
            has_state: hasProfileState(dir),
            userDataDir,
            profilePersistent: true,
            chromeExecutable: chromeExecutable(),
            headless: session.headless === true,
            running,
            cdpReady: running && (await isCdpReady(session.port)),
        };
    }));
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
}
function formatProfiles(profiles) {
    if (profiles.length === 0)
        return 'No browser profiles found.';
    return profiles
        .map((profile) => {
        const state = profile.running
            ? profile.cdpReady
                ? 'running'
                : 'starting'
            : 'stopped';
        const auth = profile.auth_markers.length > 0
            ? profile.auth_markers.join(', ')
            : 'none detected';
        return [
            `- ${profile.name}`,
            `  status: ${state}`,
            `  persistent profile: ${profile.profilePersistent ? 'yes' : 'no'}`,
            `  profile data: ${profile.has_state ? 'saved' : 'empty'}`,
            `  signed-in sites: ${auth}`,
            `  profile directory: ${profile.userDataDir}`,
            `  chrome: ${profile.chromeExecutable}`,
            `  mode: ${profile.headless ? 'headless' : 'visible browser'}`,
            `  last used: ${formatDate(profile.last_used)}`,
        ].join('\n');
    })
        .join('\n\n');
}
export async function runBrowserCommand(runtimeHome, args) {
    const [command] = args;
    if (!command ||
        command === 'profiles' ||
        command === 'list' ||
        command === 'status') {
        process.env.GANTRY_HOME = runtimeHome;
        const profiles = await listProfiles(runtimeHome);
        p.note(formatProfiles(profiles), 'Browser profiles');
        return 0;
    }
    p.log.error('Usage: gantry browser profiles');
    return 1;
}
