import { describe, expect, it } from 'vitest';

import { buildSdkFilesystemSandbox } from '@core/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.js';

describe('Claude SDK filesystem sandbox settings', () => {
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
});
