import { describe, expect, it } from 'vitest';

import { evaluateYoloModeDenylist } from '@core/shared/yolo-mode-policy.js';

const settings = {
  enabled: true,
  denylist: ['npm run nuke'],
  denylistPaths: [],
};

describe('YOLO-mode denylist policy', () => {
  it('matches shipped and user command denylist patterns', () => {
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
      }),
    ).toMatchObject({ kind: 'command', pattern: 'rm -rf /' });
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: { command: 'npm run nuke' },
      }),
    ).toMatchObject({ kind: 'command', pattern: 'npm run nuke' });
  });

  it('matches RunCommand with either the command or cmd input field', () => {
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'RunCommand',
        toolInput: { command: 'rm -rf /' },
      }),
    ).toMatchObject({ kind: 'command', pattern: 'rm -rf /' });
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'RunCommand',
        toolInput: { cmd: 'rm -rf /' },
      }),
    ).toMatchObject({ kind: 'command', pattern: 'rm -rf /' });
    // A malformed non-string command must not mask the cmd alias.
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'RunCommand',
        toolInput: { command: 0, cmd: 'rm -rf /' },
      }),
    ).toMatchObject({ kind: 'command', pattern: 'rm -rf /' });
  });

  it('does not pattern-strip model-authored runtime env prefixes', () => {
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: {
          command:
            "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18790/' HTTPS_PROXY='http://127.0.0.1:18790/' npm run nuke",
        },
      }),
    ).toBeUndefined();
  });

  it('matches force-push defaults only for main and master', () => {
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: { command: 'git push --force origin main' },
      }),
    ).toMatchObject({
      kind: 'command',
      pattern: 'git push --force * main|master',
    });
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: { command: 'git push --force origin feature' },
      }),
    ).toBeUndefined();
  });

  it('matches fork bombs even when the normal Bash parser rejects functions', () => {
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: { command: ':(){ :|:& };:' },
      }),
    ).toMatchObject({ kind: 'command', pattern: ':(){ :|:& };:' });
  });

  it('matches path patterns without blocking home paths', () => {
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Write',
        toolInput: { file_path: '/etc', content: 'x' },
      }),
    ).toMatchObject({ kind: 'path', pattern: '/etc/*' });
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Write',
        toolInput: { file_path: '/etc/foo', content: 'x' },
      }),
    ).toMatchObject({ kind: 'path', pattern: '/etc/*' });
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Bash',
        toolInput: { command: 'cat /etc' },
      }),
    ).toMatchObject({ kind: 'path', pattern: '/etc/*' });
    expect(
      evaluateYoloModeDenylist({
        settings,
        toolName: 'Write',
        toolInput: { file_path: '~/x', content: 'x' },
      }),
    ).toBeUndefined();
  });
});
