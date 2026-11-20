import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { captureSourceOutputDiagnostic } from '../../../src/shared/source-output-diagnostic.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});
async function directory() {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), 'gantry-private-diagnostic-'),
  );
  dirs.push(dir);
  return dir;
}
it('retains complete invalid JSON, source identity and validator paths privately', async () => {
  const dir = await directory();
  expect(
    await captureSourceOutputDiagnostic(
      {
        appId: 'app',
        runId: 'run',
        sourceIds: ['M1'],
        output: '{"wrong":true}',
        errors: ['/answerUnits required missing'],
      },
      dir,
    ),
  ).toBe(true);
  const [name] = await readdir(dir);
  const row = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  expect(row).toMatchObject({
    appId: 'app',
    runId: 'run',
    sourceIds: ['M1'],
    outputStatus: 'complete',
    output: '{"wrong":true}',
    errors: ['/answerUnits required missing'],
  });
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
});
it('marks oversized output without retaining a clipped version', async () => {
  const dir = await directory();
  await captureSourceOutputDiagnostic(
    { output: 'é'.repeat(32769), errors: ['invalid'] },
    dir,
  );
  const [name] = await readdir(dir);
  const row = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  expect(row.outputStatus).toBe('oversized_not_saved');
  expect(row).not.toHaveProperty('output');
  expect(row.outputBytes).toBe(65538);
  expect(row.outputHash).toMatch(/^[a-f0-9]{64}$/);
});
it('bounds retained diagnostics and redacts credentials', async () => {
  const dir = await directory();
  for (let i = 0; i < 24; i++)
    await captureSourceOutputDiagnostic(
      {
        output: '{"api_key":"sk-abcdefghijklmnopqrstuvwxyz1234567890"}',
        errors: ['invalid'],
      },
      dir,
    );
  const files = await readdir(dir);
  expect(files).toHaveLength(20);
  for (const name of files) {
    const row = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    expect(row.output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(row.outputStatus).toBe('credential_redacted');
  }
});

it('imports and captures inside a clean runner process without runtime settings', async () => {
  const dir = await directory();
  const moduleUrl = new URL(
    '../../../src/shared/source-output-diagnostic.ts',
    import.meta.url,
  ).href;
  const script = `const {captureSourceOutputDiagnostic} = await import(${JSON.stringify(moduleUrl)}); if (!await captureSourceOutputDiagnostic({runId:'clean-runner', output:'{}', errors:['required']})) process.exit(2);`;
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      env: {
        PATH: process.env.PATH,
        HOME: path.join(dir, 'empty-home'),
        GANTRY_IPC_DIR: dir,
      },
      timeout: 15000,
    },
  );
  await expect(stat(path.join(dir, 'empty-home'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const [name] = await readdir(path.join(dir, 'private-source-diagnostics'));
  const row = JSON.parse(
    await readFile(path.join(dir, 'private-source-diagnostics', name), 'utf8'),
  );
  expect(row).toMatchObject({
    runId: 'clean-runner',
    output: '{}',
    outputStatus: 'complete',
  });
});
