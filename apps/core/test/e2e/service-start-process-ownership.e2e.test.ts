import { spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { expect, it } from 'vitest';

// This fix owns the service-start contract. Only host platform selection is
// simulated; CLI dispatch, ownership inspection and process lifecycle are real.
it('starts only an ownership-checked service that survives CLI exit', async () => {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-service-ownership-'),
  );
  const runtimeEntry = path.join(home, 'runtime.js');
  const migratorEntry = path.join(home, 'migrate.js');
  const bootstrap = path.join(home, 'host.mjs');
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(
    bootstrap,
    'import os from "node:os"; os.platform = () => "linux";\n',
  );
  // A host without user systemd is an external platform condition.
  fs.writeFileSync(path.join(home, 'systemctl'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    migratorEntry,
    'require("fs").writeFileSync(require("path").join(process.env.GANTRY_HOME, "migrated"), "yes");\n',
  );
  fs.writeFileSync(
    runtimeEntry,
    'require("fs").readFileSync("migrated"); console.log("ready"); console.error("diagnostic"); setInterval(() => {}, 1000);\n',
  );
  const cli = async (action: string) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        pathToFileURL(bootstrap).href,
        'apps/core/src/cli/index.ts',
        'service',
        action,
      ],
      {
        env: {
          ...process.env,
          GANTRY_HOME: home,
          PATH: `${home}${path.delimiter}${process.env.PATH}`,
        },
        timeout: 60_000,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const [status] = await once(child, 'close');
    return { status, stdout, stderr };
  };
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      stdio: 'ignore',
    },
  );
  await once(unrelated, 'spawn');
  const unrelatedExit = once(unrelated, 'exit');
  let servicePid: number | undefined;
  try {
    const installed = await cli('install');
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    // Installed entries normally come from the package. These executable
    // fixtures expose migration, log redirection and detachment without booting
    // unrelated channels or model providers.
    fs.writeFileSync(
      path.join(home, 'service-meta.json'),
      JSON.stringify({ runtimeEntry, migratorEntry }),
    );
    fs.writeFileSync(path.join(home, 'gantry.pid'), String(unrelated.pid));
    const refused = await cli('start');
    expect(unrelated.signalCode).toBeNull();
    expect(refused.stdout + refused.stderr).toContain('not a Gantry process');
    expect(refused.status).toBe(1);
    expect(unrelated.exitCode).toBeNull();
    expect(fs.existsSync(path.join(home, 'migrated'))).toBe(false);

    fs.unlinkSync(path.join(home, 'gantry.pid'));
    const started = await cli('start');
    expect(started.status, started.stdout + started.stderr).toBe(0);
    servicePid = Number(fs.readFileSync(path.join(home, 'gantry.pid'), 'utf8'));
    await expect
      .poll(() => fs.readFileSync(path.join(home, 'logs/gantry.log'), 'utf8'))
      .toContain('ready');
    await expect
      .poll(() =>
        fs.readFileSync(path.join(home, 'logs/gantry.error.log'), 'utf8'),
      )
      .toContain('diagnostic');
    expect(process.kill(servicePid, 0)).toBe(true);
    const repeated = await cli('start');
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain('already running');
    expect(Number(fs.readFileSync(path.join(home, 'gantry.pid'), 'utf8'))).toBe(
      servicePid,
    );
    const stopped = await cli('stop');
    expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, 'gantry.pid'))).toBe(false);
  } finally {
    await cli('stop');
    unrelated.kill();
    await unrelatedExit;
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 360_000);
