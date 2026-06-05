import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSdkFilesystemSandbox,
  readLocalCliCredentialDirectories,
  readProtectedFilesystemSandboxPaths,
} from '@core/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.js';

describe('Claude SDK filesystem sandbox settings', () => {
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    delete process.env.GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON;
    delete process.env.GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON;
    delete process.env.GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON;
    delete process.env.GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON;
    delete process.env.GANTRY_SANDBOX_RUNTIME_PROXY;
  });

  it('keeps Bash sandboxed and enables macOS trustd lookup for approved CLI TLS', () => {
    const protectedPath = '/tmp/protected';

    expect(
      buildSdkFilesystemSandbox([protectedPath], { platform: 'darwin' }),
    ).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowLocalBinding: true },
      enableWeakerNetworkIsolation: true,
      filesystem: {
        denyRead: expect.arrayContaining([
          expect.stringMatching(/\/tmp\/protected$/),
        ]),
        denyWrite: expect.arrayContaining([
          expect.stringMatching(/\/tmp\/protected$/),
        ]),
      },
    });
  });

  it('does not request the macOS-only trustd exception on non-Darwin platforms', () => {
    expect(
      buildSdkFilesystemSandbox(['/tmp/protected'], { platform: 'linux' }),
    ).not.toHaveProperty('enableWeakerNetworkIsolation');
  });

  it('supports separate read and write sandbox protections', () => {
    const sandbox = buildSdkFilesystemSandbox([], {
      platform: 'linux',
      denyReadPaths: ['/tmp/runtime/settings.json'],
      denyWritePaths: ['/tmp/runtime/skills', '/tmp/credentials'],
    });

    expect(sandbox.filesystem?.denyRead).toEqual([
      expect.stringMatching(/\/tmp\/runtime\/settings\.json$/),
    ]);
    expect(sandbox.filesystem?.denyWrite).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/tmp\/runtime\/skills$/),
        expect.stringMatching(/\/tmp\/credentials$/),
      ]),
    );
    expect(sandbox.filesystem?.denyRead).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/tmp\/credentials$/)]),
    );
  });

  it('reads split protected filesystem path projections from runner env', () => {
    process.env.GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON = JSON.stringify([
      '/tmp/fallback',
    ]);
    process.env.GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON =
      JSON.stringify(['/tmp/settings.json']);
    process.env.GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON =
      JSON.stringify(['/tmp/runtime', '/tmp/credentials']);

    expect(readProtectedFilesystemSandboxPaths()).toEqual({
      denyRead: [expect.stringMatching(/\/tmp\/settings\.json$/)],
      denyWrite: expect.arrayContaining([
        expect.stringMatching(/\/tmp\/runtime$/),
        expect.stringMatching(/\/tmp\/credentials$/),
      ]),
    });
  });

  it('avoids host filesystem probes when the runner is already sandboxed', () => {
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY = '1';
    process.env.GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON = JSON.stringify([
      '/tmp/runtime/settings.yaml',
    ]);

    expect(buildSdkFilesystemSandbox(['/tmp/runtime/settings.yaml'])).toEqual(
      expect.objectContaining({
        filesystem: expect.objectContaining({
          denyRead: ['/tmp/runtime/settings.yaml'],
          denyWrite: ['/tmp/runtime/settings.yaml'],
        }),
      }),
    );
  });

  it('resolves reviewed local CLI credential directories from the host projection', () => {
    process.env.HOME = '/Users/tester';
    process.env.XDG_CONFIG_HOME = '/Users/tester/.config';
    process.env.GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON = JSON.stringify([
      '${XDG_CONFIG_HOME}/acme',
      '~/.config/acme',
      '${GANTRY_MISSING_CLI_CONFIG}/skip',
    ]);

    expect(readLocalCliCredentialDirectories()).toEqual([
      '/Users/tester/.config/acme',
    ]);
  });
});
