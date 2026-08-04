import { describe, expect, it } from 'vitest';

import { applyBashTrustEnvWithProvenance } from '@core/adapters/llm/anthropic-claude-agent/runner/bash-trust-env.js';
import { stripShellCommandEnvPrefix } from '@core/runtime/ipc-shell-command-prefix.js';
import { evaluateAutonomousToolUse } from '@core/shared/tool-rule-matcher.js';

function wrapAtPort(port: number) {
  return applyBashTrustEnvWithProvenance(
    'RunCommand',
    { command: 'pwd' },
    { HTTP_PROXY: `http://127.0.0.1:${port}/` },
  );
}

describe('host-injected shell command prefix', () => {
  it('keeps a saved rule matching across proxy-port rotation', () => {
    for (const port of [18080, 18790]) {
      const wrapped = wrapAtPort(port);
      const decisionInput = stripShellCommandEnvPrefix(
        'RunCommand',
        wrapped.toolInput,
        wrapped.hostInjectedCommandPrefix,
      );

      expect(
        evaluateAutonomousToolUse({
          rules: ['RunCommand(pwd)'],
          toolName: 'RunCommand',
          toolInput: decisionInput,
        }),
      ).toMatchObject({
        allowed: true,
        matchedRule: 'RunCommand(pwd)',
      });
    }
  });

  it('strips only a byte-exact declared prefix', () => {
    const wrapped = wrapAtPort(18080);

    expect(
      stripShellCommandEnvPrefix(
        'RunCommand',
        wrapped.toolInput,
        "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18790/'",
      ),
    ).toBe(wrapped.toolInput);
    expect(
      stripShellCommandEnvPrefix(
        'RunCommand',
        wrapped.toolInput,
        wrapped.hostInjectedCommandPrefix,
      ),
    ).toEqual({ command: 'pwd' });
  });
});
