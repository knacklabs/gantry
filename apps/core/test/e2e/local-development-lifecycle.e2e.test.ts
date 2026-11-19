// Fix: windows-local-supervisor. Owns the source-local start/stop contract.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { freeLocalPort } from '../../src/cli/local-doctor.js';

// Requires Docker and exclusive use of the CLI's gantry-postgres container name.
it('npm run dev prints a usable browser link and dev:stop leaves no owned processes', async () => {
  const repo = process.cwd();
  const npm = process.env.npm_execpath!;
  expect(npm).toBeTruthy();
  const existing = execFileSync(
    'docker',
    ['ps', '-aq', '--filter', 'name=^/gantry-postgres$'],
    { encoding: 'utf8' },
  ).trim();
  if (existing) throw new Error('Use an exclusive Docker host for this test.');
  const home = fs.mkdtempSync(path.join(repo, '.tmp-local-development-'));
  // Only terminal presence is supplied; the CLI must issue and print the link.
  const terminal = path.join(home, 'terminal.mjs');
  fs.writeFileSync(
    terminal,
    "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(pathToFileURL(terminal).href)}`,
    GANTRY_HOME: home,
    GANTRY_CONTROL_HOST: '127.0.0.1',
    GANTRY_CONTROL_PORT: String(await freeLocalPort()),
  };
  delete env.GANTRY_DATABASE_URL;
  const children: ChildProcess[] = [];
  let output = '';
  const launch = (script: string, args: string[] = []) => {
    const child = spawn(process.execPath, [npm, 'run', script, ...args], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    children.push(child);
    child.stdout!.on('data', (data) => (output += data.toString()));
    child.stderr!.on('data', (data) => (output += data.toString()));
    return child;
  };
  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const start = launch('dev');
    await expect
      .poll(
        () =>
          output.includes('Gantry local start ready') ||
          start.exitCode !== null,
        { timeout: 180_000 },
      )
      .toBe(true);
    expect(start.exitCode, output).toBeNull();
    expect(output).toContain('Fresh one-time browser authorization link:');
    const link = output.match(
      /http:\/\/[^\s]+\/ui\/auth\/local#token=[^\s]+/,
    )?.[0];
    expect(link, output).toBeTruthy();
    const url = new URL(link!);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const auth = await fetch(new URL('/auth/local/authorize', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url.origin },
      body: JSON.stringify({
        token: new URLSearchParams(url.hash.slice(1)).get('token'),
      }),
    });
    expect(auth.status, await auth.text()).toBe(200);
    expect(auth.headers.get('set-cookie')).toBeTruthy();
    const pids: number[] = JSON.parse(
      fs.readFileSync(path.join(home, '.gantry-local-pids'), 'utf8'),
    );
    expect(pids).toHaveLength(2);
    expect(pids.every(isRunning)).toBe(true);
    // Inspect descendants before stopping, so orphaned tsx workers are checked too.
    const descendants: number[] =
      process.platform === 'win32'
        ? JSON.parse(
            execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress`,
              ],
              { encoding: 'utf8' },
            ),
          )
            .filter((entry: { ParentProcessId: number }) =>
              pids.includes(entry.ParentProcessId),
            )
            .map((entry: { ProcessId: number }) => entry.ProcessId)
        : execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], {
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .flatMap((line) => {
              const [pid, parent] = line.trim().split(/\s+/).map(Number);
              return pids.includes(parent) ? [pid] : [];
            });
    const exited = once(start, 'exit');
    const stop = launch('dev:stop');
    expect((await once(stop, 'exit'))[0], output).toBe(0);
    expect((await exited)[0], output).toBe(0);
    await expect
      .poll(() => [...pids, ...descendants].some(isRunning))
      .toBe(false);
    expect(
      execFileSync(
        'docker',
        ['inspect', '-f', '{{.State.Running}}', 'gantry-postgres'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('false');
    // An already stopped endpoint must be harmless on every platform.
    expect((await once(launch('dev:stop'), 'exit'))[0], output).toBe(0);
  } finally {
    const active = children.some(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    if (active) await once(launch('dev:stop'), 'exit');
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      } else process.kill(-child.pid!, 'SIGKILL');
      await once(child, 'exit');
    }
    // Only remove the container when its bind mount belongs to this test.
    const inspect = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', 'name=^/gantry-postgres$'],
      { encoding: 'utf8' },
    ).trim();
    const containers = inspect
      ? JSON.parse(
          execFileSync('docker', ['inspect', inspect], { encoding: 'utf8' }),
        )
      : [];
    if (
      containers[0]?.Mounts.some((mount: { Source: string }) =>
        mount.Source.includes(path.basename(home)),
      )
    ) {
      // Linux bind mounts retain the database user's 0700 ownership on the host.
      if (process.platform === 'linux') {
        execFileSync('docker', ['stop', inspect]);
        execFileSync('docker', [
          'run',
          '--rm',
          '--user',
          '0',
          '--volumes-from',
          inspect,
          '--entrypoint',
          'chown',
          containers[0].Config.Image,
          '-R',
          `${process.getuid!()}:${process.getgid!()}`,
          '/var/lib/postgresql/data',
        ]);
      }
      execFileSync('docker', ['rm', '-f', 'gantry-postgres']);
    }
    fs.rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}, 240_000);
