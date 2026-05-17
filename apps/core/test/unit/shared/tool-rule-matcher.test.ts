import { describe, expect, it } from 'vitest';

import {
  anyToolRuleMatches,
  evaluateAutonomousToolUse,
  validateAutonomousToolRule,
} from '@core/shared/tool-rule-matcher.js';

describe('autonomous tool rule matcher', () => {
  it('supports exact non-Bash tool names and mcp server wildcards', () => {
    expect(anyToolRuleMatches(['Read'], 'Read')).toBe(true);
    expect(anyToolRuleMatches(['Read'], 'Bash')).toBe(false);
    expect(anyToolRuleMatches(['mcp__github__*'], 'mcp__github__search')).toBe(
      true,
    );
    expect(anyToolRuleMatches(['mcp__github__*'], 'mcp__linear__search')).toBe(
      false,
    );
  });

  it('rejects empty, global, and unsupported wildcard rules', () => {
    expect(validateAutonomousToolRule('').ok).toBe(false);
    expect(validateAutonomousToolRule('*').ok).toBe(false);
    expect(validateAutonomousToolRule('mcp__github__search*').ok).toBe(false);
    expect(validateAutonomousToolRule('mcp__github__*').ok).toBe(true);
  });

  it('allows scoped Bash commands and denies unrelated Bash commands', () => {
    expect(validateAutonomousToolRule('Bash(dedup-append-lead.py *)')).toEqual({
      ok: true,
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: { command: 'dedup-append-lead.py --dry-run' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      }),
    ).toMatchObject({
      allowed: false,
      closestRule: {
        rule: 'Bash(dedup-append-lead.py *)',
        reason: expect.stringContaining('npm test'),
      },
      reason: expect.stringContaining('did not match'),
    });
  });

  it('canonicalizes legacy interpreter script Bash rules while matching', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(python3 /Users/example/scripts/dedup-append-lead.py)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'python3 /Users/example/scripts/dedup-append-lead.py \'[["lead"]]\'',
        },
      }),
    ).toMatchObject({
      allowed: true,
      matchedRule: 'Bash(python3 /Users/example/scripts/dedup-append-lead.py)',
    });
  });

  it('does not let wildcard scoped Bash rules cover extra shell segments', () => {
    expect(validateAutonomousToolRule('Bash(gog sheets *)')).toEqual({
      ok: true,
    });
    expect(
      validateAutonomousToolRule('Bash(gog sheets * | python3 *)'),
    ).toEqual({
      ok: false,
      reason: expect.stringContaining('exactly one simple command leaf'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(gog sheets *)'],
        toolName: 'Bash',
        toolInput: { command: 'gog sheets get budget' },
      }),
    ).toMatchObject({ allowed: true });

    for (const command of [
      'gog sheets get budget | python3 -c "print(1)"',
      'gog sheets get budget; rm -rf /tmp/unsafe',
      'gog sheets get "$(python3 -c \'print(1)\')"',
    ]) {
      expect(
        evaluateAutonomousToolUse({
          rules: ['Bash(gog sheets *)'],
          toolName: 'Bash',
          toolInput: { command },
        }),
      ).toMatchObject({
        allowed: false,
        reason: expect.stringMatching(
          /did not match|could not be parsed safely/,
        ),
      });
    }
  });

  it('matches Bash rules per parsed argv leaf without shell state changes', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(git status)', 'Bash(head)'],
        toolName: 'Bash',
        toolInput: { command: 'git status | head' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(git status)'],
        toolName: 'Bash',
        toolInput: { command: 'git status | head' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('head'),
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(git status)'],
        toolName: 'Bash',
        toolInput: { command: 'git status && rm -rf /' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('rm -rf /'),
    });
  });

  it('rejects stateful Bash leaves as durable scopes', () => {
    expect(validateAutonomousToolRule('Bash(cd *)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('changes shell state'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(cd *)', 'Bash(npm test)'],
        toolName: 'Bash',
        toolInput: { command: 'cd /tmp/evil && npm test' },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('keeps scoped Bash matching positional and argv-explicit', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(echo "hello world")'],
        toolName: 'Bash',
        toolInput: { command: 'echo "hello world"' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: [
          'Bash(curl -H "Accept: application/json" https://api.example.com/*)',
        ],
        toolName: 'Bash',
        toolInput: {
          command:
            'curl -H "Accept: application/json" https://api.example.com/leads',
        },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(echo "hello world")'],
        toolName: 'Bash',
        toolInput: { command: 'echo hello world' },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(curl https://api.example.com/*)'],
        toolName: 'Bash',
        toolInput: { command: 'curl -sSf https://api.example.com/x' },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(curl * https://api.example.com/*)'],
        toolName: 'Bash',
        toolInput: { command: 'curl -sSf https://api.example.com/x' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(npm test *)'],
        toolName: 'Bash',
        toolInput: { command: 'npm testevil -- --runInBand' },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('fails closed for unsupported Bash grammar and destructive redirects', () => {
    for (const command of [
      'FOO=bar npm test',
      'echo $(date)',
      'npm test &',
      'if true; then echo ok; fi',
      'sh -c "npm test"',
      '/bin/sh -c "npm test"',
      '/usr/bin/env npm test',
      '/usr/bin/find . -name package.json -exec cat {} ;',
      'command sh -c "npm test"',
      'builtin eval "npm test"',
      'timeout 10 sh -c "npm test"',
      'cat <(echo ok)',
      'echo "unterminated',
    ]) {
      expect(
        evaluateAutonomousToolUse({
          rules: ['Bash(npm test *)', 'Bash(echo *)', 'Bash(cat *)'],
          toolName: 'Bash',
          toolInput: { command },
        }),
      ).toMatchObject({ allowed: false });
    }

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(cat *)'],
        toolName: 'Bash',
        toolInput: { command: 'cat secrets.env > /etc/passwd' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'Redirect: > /etc/passwd',
    });
  });

  it('allows non-destructive stderr redirection used by common CLI probes', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(gog sheets get *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'gog sheets get 12s6uzwLDLV-DVcTH6XBa5vV3FZJUo04fLm0npfgACb4 "\'Bot Recommendation\'!A1:G5000" --json --account ravi@knacklabs.ai 2>&1',
        },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(gog sheets get *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'gog sheets get 12s6uzwLDLV-DVcTH6XBa5vV3FZJUo04fLm0npfgACb4 "\'Bot Recommendation\'!A1:G5000" --json --account ravi@knacklabs.ai 2>&1 | head -20',
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('head -20'),
    });
  });

  it('rejects absolute-path Bash meta executors in persistent scopes', () => {
    for (const rule of [
      'Bash(/bin/sh -c npm)',
      'Bash(/usr/bin/env npm test)',
      'Bash(/usr/bin/sudo npm test)',
      'Bash(/usr/bin/xargs npm)',
      'Bash(/usr/bin/find . -exec cat)',
      'Bash(command *)',
      'Bash(builtin *)',
      'Bash(timeout *)',
      'Bash(nohup *)',
    ]) {
      expect(validateAutonomousToolRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/meta-executor|not supported/),
      });
    }
  });

  it('does not widen interpreter script paths to wildcard durable scopes', () => {
    expect(validateAutonomousToolRule('Bash(python3 *)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('too broad'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(python3 /tmp/check.py)'],
        toolName: 'Bash',
        toolInput: { command: 'python3 /tmp/check.py' },
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(python3 /tmp/check.py)'],
        toolName: 'Bash',
        toolInput: { command: 'python3 -c "print(1)"' },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('allows safe interpreter invocation of an approved script path', () => {
    for (const command of [
      'python3 /tmp/dedup-append-lead.py \'[["lead"]]\'',
      '/usr/bin/python3 /tmp/dedup-append-lead.py \'[["lead"]]\'',
      'python /tmp/dedup-append-lead.py \'[["lead"]]\'',
    ]) {
      expect(
        evaluateAutonomousToolUse({
          rules: ['Bash(/tmp/dedup-append-lead.py *)'],
          toolName: 'Bash',
          toolInput: { command },
        }),
      ).toMatchObject({
        allowed: true,
        matchedRule: 'Bash(/tmp/dedup-append-lead.py *)',
      });
    }

    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(/tmp/dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: {
          command: 'python3 -c "print(1)" /tmp/dedup-append-lead.py',
        },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('rejects exact bare Bash as too broad', () => {
    expect(validateAutonomousToolRule('Bash')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('too broad'),
    });
    for (const rule of ['Bash(*)', 'Bash(**)', 'Bash(* npm test)']) {
      expect(validateAutonomousToolRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('too broad'),
      });
    }
    expect(
      evaluateAutonomousToolUse({
        rules: ['Bash(*)'],
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Read'],
        toolName: 'Bash',
      }),
    ).toMatchObject({ allowed: false });
  });

  it('allows exact file, search, web, and MCP tool names without extra scopes', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Read'],
        toolName: 'Read',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['Grep'],
        toolName: 'Grep',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['WebSearch'],
        toolName: 'WebSearch',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['WebFetch'],
        toolName: 'WebFetch',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['mcp__github__search'],
        toolName: 'mcp__github__search',
      }),
    ).toMatchObject({ allowed: true });
  });

  it('keeps non-browser MCP wildcard behavior available', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['mcp__github__*'],
        toolName: 'mcp__github__search',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['mcp__github__*'],
        toolName: 'mcp__linear__search',
      }),
    ).toMatchObject({ allowed: false });
  });

  it('rejects browser and MyClaw wildcard rules at the shared matcher boundary', () => {
    for (const rule of [
      'mcp__browser' + '_' + 'backend' + '__*',
      'mcp__browser' + '_' + 'backend' + '__navigate',
      'mcp__browser' + '_' + 'backend' + '__click',
      'mcp__browser' + '_' + 'backend' + '__screenshot',
      `${'mcp__agent'}_${'browser'}__*`,
      `mcp__${'play'}${'wright'}__click`,
      `mcp__${'pup'}${'peteer'}__screenshot`,
      'mcp__myclaw__browser_act',
      'mcp__myclaw__*',
    ]) {
      expect(validateAutonomousToolRule(rule).ok).toBe(false);
    }

    expect(
      evaluateAutonomousToolUse({
        rules: ['mcp__browser' + '_' + 'backend' + '__*'],
        toolName: 'mcp__browser' + '_' + 'backend' + '__open',
      }),
    ).toMatchObject({ allowed: false });
  });

  it('allows canonical Browser only for known projected browser tools', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['Browser'],
        toolName: 'mcp__myclaw__browser_act',
      }),
    ).toMatchObject({ allowed: true, matchedRule: 'Browser' });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Browser'],
        toolName: 'mcp__myclaw__browser_fake',
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('No autonomous tool rule matched'),
    });
  });

  it('validates malformed scoped and wildcard rules', () => {
    expect(validateAutonomousToolRule('Agent(worker)').ok).toBe(false);
    expect(validateAutonomousToolRule('Read(/repo/**)').ok).toBe(false);
    expect(validateAutonomousToolRule('Bash()').ok).toBe(false);
    expect(validateAutonomousToolRule('Bash(npm test').ok).toBe(false);
    expect(validateAutonomousToolRule('Bash(npm test) extra').ok).toBe(false);
    expect(
      validateAutonomousToolRule('mcp__myclaw__*(service_restart)').ok,
    ).toBe(false);
  });
});
