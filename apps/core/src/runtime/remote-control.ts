import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, REMOTE_CONTROL_AUTO_ACCEPT } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

interface PersistedRemoteControlSession {
  pid: number;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;
const STATE_FILE = path.join(DATA_DIR, 'remote-control.json');
const STDOUT_FILE = path.join(DATA_DIR, 'remote-control.stdout');
const STDERR_FILE = path.join(DATA_DIR, 'remote-control.stderr');

function shouldAutoAcceptRemoteControl(): boolean {
  return REMOTE_CONTROL_AUTO_ACCEPT;
}

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const persisted: PersistedRemoteControlSession = {
    pid: session.pid,
    startedBy: session.startedBy,
    startedInChat: session.startedInChat,
    startedAt: session.startedAt,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(persisted));
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRemoteControlUrlFromStdout(): string | null {
  try {
    const content = fs.readFileSync(STDOUT_FILE, 'utf-8');
    const match = content.match(URL_REGEX);
    return match?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise, clean up.
 */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch {
    return;
  }

  try {
    const raw = JSON.parse(data) as Partial<
      PersistedRemoteControlSession & { url: unknown }
    >;
    const pid = typeof raw.pid === 'number' ? raw.pid : 0;
    if (!pid || !isProcessAlive(pid)) {
      clearState();
      return;
    }
    const restoredUrl =
      typeof raw.url === 'string' && raw.url.trim().length > 0
        ? raw.url.trim()
        : readRemoteControlUrlFromStdout();
    if (!restoredUrl) {
      clearState();
      logger.warn(
        { pid },
        'Remote Control process is alive but URL could not be restored',
      );
      return;
    }
    activeSession = {
      pid,
      url: restoredUrl,
      startedBy: typeof raw.startedBy === 'string' ? raw.startedBy : 'unknown',
      startedInChat:
        typeof raw.startedInChat === 'string' ? raw.startedInChat : 'unknown',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : nowIso(),
    };
    logger.info(
      { pid: activeSession.pid },
      'Restored Remote Control session from previous run',
    );
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeSession = null;
}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return STATE_FILE;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    // Verify the process is still alive
    if (isProcessAlive(activeSession.pid)) {
      return { ok: true, url: activeSession.url };
    }
    // Process died — clean up and start a new one
    activeSession = null;
    clearState();
  }

  // Redirect stdout/stderr to files so the process has no pipes to the parent.
  // This prevents SIGPIPE when Gantry restarts.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stdoutFd = fs.openSync(STDOUT_FILE, 'w');
  const stderrFd = fs.openSync(STDERR_FILE, 'w');

  let proc;
  try {
    proc = spawn('claude', ['remote-control', '--name', 'Gantry Remote'], {
      cwd,
      stdio: ['pipe', stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err: any) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return { ok: false, error: `Failed to start: ${err.message}` };
  }

  const autoAccept = shouldAutoAcceptRemoteControl();
  if (proc.stdin && autoAccept) {
    // Optional opt-in for non-interactive environments.
    proc.stdin.write('y\n');
    proc.stdin.end();
  } else if (proc.stdin) {
    proc.stdin.end();
  }

  if (!autoAccept) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(proc.pid, 'SIGTERM');
        } catch {
          // already dead
        }
      }
    }
    return {
      ok: false,
      error:
        'Remote Control auto-confirmation is disabled. Set REMOTE_CONTROL_AUTO_ACCEPT=true to enable non-interactive start.',
    };
  }

  // Close FDs in the parent — the child inherited copies
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Fully detach from parent
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    return { ok: false, error: 'Failed to get process PID' };
  }

  // Poll the stdout file for the URL
  return new Promise((resolve) => {
    const startTime = currentTimeMs();

    const poll = () => {
      // Check if process died
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      // Check for URL in stdout file
      let content = '';
      try {
        content = fs.readFileSync(STDOUT_FILE, 'utf-8');
      } catch {
        // File might not have content yet
      }

      const match = content.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: nowIso(),
        };
        activeSession = session;
        saveState(session);

        logger.info({ pid, sender, chatJid }, 'Remote Control session started');
        resolve({ ok: true, url: match[0] });
        return;
      }

      // Timeout check
      if (currentTimeMs() - startTime >= URL_TIMEOUT_MS) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already dead
          }
        }
        resolve({
          ok: false,
          error: 'Timed out waiting for Remote Control URL',
        });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };

    poll();
  });
}

export function stopRemoteControl():
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { pid } = activeSession;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead
  }
  activeSession = null;
  clearState();
  logger.info({ pid }, 'Remote Control session stopped');
  return { ok: true };
}
