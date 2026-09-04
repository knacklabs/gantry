import { describe, expect, it } from 'vitest';

import {
  formatBashArgv,
  parseBashCommand,
} from '@core/shared/bash-command-parser.js';

describe('bash command parser', () => {
  it('quotes wildcard argv when formatting shell-safe commands', () => {
    expect(formatBashArgv(['acme', 'records', 'get', '*'])).toBe(
      "acme records get '*'",
    );
  });

  it('keeps a heredoc body out of argv and resumes parsing after its terminator', () => {
    const urls = [
      'https://example.com/monaco/1',
      'https://example.com/taktile/2',
      'https://example.com/monaco/3',
      'https://example.com/taktile/4',
      'https://example.com/monaco/5',
      'https://example.com/taktile/6',
    ];
    const parsed = parseBashCommand(
      `grep -i "monaco\\|taktile" /dev/stdin << 'EOF'\n${urls.join('\n')}\nEOF\necho "check done"`,
    );

    expect(parsed).toMatchObject({
      ok: true,
      leaves: [
        {
          argv: ['grep', '-i', 'monaco|taktile', '/dev/stdin'],
          redirects: [
            {
              operator: '<<',
              target: 'EOF',
              heredoc: `${urls.join('\n')}\n`,
            },
          ],
        },
        { argv: ['echo', 'check done'] },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.leaves[0]?.argv.join(' ')).not.toContain(urls[0]!);
  });

  it('strips leading tabs from <<- heredoc bodies', () => {
    const parsed = parseBashCommand('cat <<-EOF\n\tfirst\n\tsecond\n\tEOF');

    expect(parsed).toMatchObject({
      ok: true,
      leaves: [
        {
          redirects: [
            { operator: '<<-', target: 'EOF', heredoc: 'first\nsecond\n' },
          ],
        },
      ],
    });
  });

  it('rejects bare-delimiter heredoc expansions', () => {
    expect(parseBashCommand('cat <<EOF\n$HOME\nEOF')).toEqual({
      ok: false,
      reason: 'Bash heredoc body uses unsupported expansion.',
    });
  });

  it('rejects a carriage return in a heredoc delimiter candidate', () => {
    expect(parseBashCommand("cat <<'EOF'\nEOF\r\necho body\nEOF")).toEqual({
      ok: false,
      reason: 'Bash heredoc uses unsupported line endings.',
    });
  });

  it('rejects a carriage return in a heredoc header', () => {
    expect(parseBashCommand('cat <<EOF\r\nbody\nEOF')).toEqual({
      ok: false,
      reason: 'Bash heredoc uses unsupported line endings.',
    });
  });

  it.each([
    ['two', 'line\\\\', true],
    ['one', 'line\\', false],
    ['three', 'line\\\\\\', false],
  ])(
    'handles %s trailing backslashes in unquoted heredoc bodies like Bash',
    (_count, line, ok) => {
      const parsed = parseBashCommand(`cat <<EOF\n${line}\nEOF`);

      if (ok) {
        expect(parsed).toMatchObject({
          ok: true,
          leaves: [{ redirects: [{ target: 'EOF', heredoc: `${line}\n` }] }],
        });
        return;
      }
      expect(parsed).toEqual({
        ok: false,
        reason: 'Bash heredoc body uses unsupported line continuation.',
      });
    },
  );

  it('rejects bare heredoc body line continuations', () => {
    expect(parseBashCommand('cat <<EOF\nline\\\nEOF\necho body\nEOF')).toEqual({
      ok: false,
      reason: 'Bash heredoc body uses unsupported line continuation.',
    });
  });

  it('keeps quoted heredoc body lines physical', () => {
    const parsed = parseBashCommand("cat <<'EOF'\nline\\\nEOF\necho body\nEOF");

    expect(parsed).toMatchObject({
      ok: true,
      leaves: [
        { redirects: [{ target: 'EOF', heredoc: 'line\\\n' }] },
        { argv: ['echo', 'body'] },
        { argv: ['EOF'] },
      ],
    });
  });

  it.each([
    ['cat <<\'E"OF\'\nx\nE"OF', 'E"OF'],
    ['cat <<"E\'OF"\nx\nE\'OF', "E'OF"],
  ])(
    'allows the other quote in a quoted heredoc delimiter: %s',
    (command, target) => {
      expect(parseBashCommand(command)).toMatchObject({
        ok: true,
        leaves: [{ redirects: [{ target }] }],
      });
    },
  );

  it('rejects an unterminated heredoc', () => {
    expect(parseBashCommand('cat <<EOF\nbody')).toEqual({
      ok: false,
      reason: 'Bash heredoc delimiter not terminated.',
    });
  });

  it('rejects a heredoc header without a body newline', () => {
    expect(parseBashCommand('cat <<EOF')).toEqual({
      ok: false,
      reason: 'Bash heredoc delimiter not terminated.',
    });
  });

  it.each([
    'cat <<\\EOF',
    "cat <<E'OF'",
    "cat <<'E'OF",
    'cat <<"EOF"x',
    "cat <<'E\\OF'",
  ])('rejects unsupported heredoc delimiter quoting: %s', (command) => {
    expect(parseBashCommand(command)).toEqual({
      ok: false,
      reason: 'Bash heredoc delimiter uses unsupported quoting.',
    });
  });

  it('keeps existing redirect operators intact', () => {
    const parsed = parseBashCommand('cat < input > output >> log 2>&1');

    expect(parsed).toMatchObject({
      ok: true,
      leaves: [
        {
          argv: ['cat'],
          redirects: [
            { operator: '<', target: 'input', destructive: false },
            { operator: '>', target: 'output', destructive: true },
            { operator: '>>', target: 'log', destructive: true },
            { operator: '2>', target: '&1', destructive: false },
          ],
        },
      ],
    });
  });

  it('refuses every one of the nine write-capable find actions as a meta-executor', () => {
    for (const command of [
      'find . -delete',
      'find . -exec echo {} +',
      'find . -execdir echo {} +',
      'find . -ok echo {} +',
      'find . -okdir echo {} +',
      'find . -fls results.txt',
      'find . -fprint results.txt',
      'find . -fprint0 results.txt',
      'find . -fprintf results.txt %p',
    ]) {
      expect(parseBashCommand(command), command).toMatchObject({
        ok: false,
        reason: expect.stringContaining('meta-executor find'),
      });
    }
  });
});
