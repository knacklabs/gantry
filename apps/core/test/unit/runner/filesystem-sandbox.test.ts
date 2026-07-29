import { afterEach, describe, expect, it } from 'vitest';

import { readLocalCliCredentialDirectories } from '@core/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.js';

describe('Claude SDK filesystem sandbox settings', () => {
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    delete process.env.GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON;
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
