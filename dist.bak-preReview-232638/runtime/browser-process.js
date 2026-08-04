import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
export function isPidAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readPidCommandLine(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return undefined;
    if (process.platform === 'linux') {
        try {
            const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
            const command = raw.replace(/\0/g, ' ').trim();
            if (command)
                return command;
        }
        catch {
            // Fall back to ps below for non-/proc environments and tests.
        }
    }
    try {
        return execFileSync('/bin/ps', ['-p', String(pid), '-ww', '-o', 'command='], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return undefined;
    }
}
function hasHeadlessChromeFlag(commandLine) {
    return /(?:^|\s)--headless(?:=|\s|$)/.test(commandLine);
}
export function browserProcessProfileState(pid, profile) {
    const commandLine = readPidCommandLine(pid);
    if (!commandLine)
        return { owned: false, headless: false };
    const userDataDir = path.resolve(profile.userDataDir);
    return {
        owned: commandLine.includes(`--user-data-dir=${userDataDir}`) ||
            commandLine.includes(`--user-data-dir="${userDataDir}"`) ||
            commandLine.includes(`--user-data-dir='${userDataDir}'`),
        headless: hasHeadlessChromeFlag(commandLine),
    };
}
export function isPidOwnedByBrowserProfile(pid, profile) {
    return browserProcessProfileState(pid, profile).owned;
}
export function isPidOwnedVisibleBrowserProfile(pid, profile) {
    const state = browserProcessProfileState(pid, profile);
    return state.owned && !state.headless;
}
