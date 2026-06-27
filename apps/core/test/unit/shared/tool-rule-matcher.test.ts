import { describe, expect, it } from 'vitest';

import {
  anyToolRuleMatches,
  evaluateAutonomousToolUse,
  validateAutonomousToolRule,
} from '@core/shared/tool-rule-matcher.js';

describe('autonomous tool rule matcher', () => {
  it('supports exact Gantry tool names and mcp server wildcards', () => {
    expect(anyToolRuleMatches(['FileRead'], 'Read')).toBe(true);
    expect(anyToolRuleMatches(['Read'], 'Read')).toBe(false);
    expect(anyToolRuleMatches(['FileRead'], 'Bash')).toBe(false);
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

  it('rejects provider-native exact names as durable autonomous rules', () => {
    for (const rule of [
      'Agent',
      'Task',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'TodoWrite',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebFetch',
    ]) {
      expect(validateAutonomousToolRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Provider-native SDK tools'),
      });
    }
  });

  it('allows scoped non-script RunCommand rules and denies unrelated Bash commands', () => {
    expect(validateAutonomousToolRule('RunCommand(npm test *)')).toEqual({
      ok: true,
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(npm test *)'],
        toolName: 'Bash',
        toolInput: { command: 'npm test -- --runInBand' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(npm test *)'],
        toolName: 'Bash',
        toolInput: { command: 'pnpm test' },
      }),
    ).toMatchObject({
      allowed: false,
      closestRule: {
        rule: 'RunCommand(npm test *)',
        reason: expect.stringContaining('pnpm test'),
      },
      reason: expect.stringContaining('did not match'),
    });
  });

  it('rejects host-owned Python script rules as durable autonomous rules', () => {
    for (const rule of [
      'RunCommand(dedup-append-lead.py *)',
      'RunCommand(/tmp/dedup-append-lead.py *)',
      'RunCommand(python3 /Users/example/scripts/dedup-append-lead.py)',
      'RunCommand(python3 /Users/example/scripts/dedup-append-lead.py *)',
    ]) {
      expect(validateAutonomousToolRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/host-owned Python scripts|too broad/),
      });
    }

    expect(
      evaluateAutonomousToolUse({
        rules: [
          'RunCommand(python3 /Users/example/scripts/dedup-append-lead.py)',
        ],
        toolName: 'Bash',
        toolInput: {
          command:
            'python3 /Users/example/scripts/dedup-append-lead.py \'[["lead"]]\'',
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('did not match'),
    });
  });

  it('does not let wildcard scoped RunCommand rules cover extra shell segments', () => {
    expect(validateAutonomousToolRule('RunCommand(acme records *)')).toEqual({
      ok: true,
    });
    expect(
      validateAutonomousToolRule('RunCommand(acme records * | python3 *)'),
    ).toEqual({
      ok: false,
      reason: expect.stringContaining('exactly one simple command leaf'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(acme records *)'],
        toolName: 'Bash',
        toolInput: { command: 'acme records get budget' },
      }),
    ).toMatchObject({ allowed: true });

    for (const command of [
      'acme records get budget | python3 -c "print(1)"',
      'acme records get budget; rm -rf /tmp/unsafe',
      'acme records get "$(python3 -c \'print(1)\')"',
    ]) {
      expect(
        evaluateAutonomousToolUse({
          rules: ['RunCommand(acme records *)'],
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
        rules: ['RunCommand(git status)', 'RunCommand(head)'],
        toolName: 'Bash',
        toolInput: { command: 'git status | head' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(git status)'],
        toolName: 'Bash',
        toolInput: { command: 'git status | head' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('head'),
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(git status)'],
        toolName: 'Bash',
        toolInput: { command: 'git status && rm -rf /' },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('rm -rf /'),
    });
  });

  it('rejects stateful Bash leaves as durable scopes', () => {
    expect(validateAutonomousToolRule('RunCommand(cd *)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('changes shell state'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(cd *)', 'RunCommand(npm test)'],
        toolName: 'Bash',
        toolInput: { command: 'cd /tmp/evil && npm test' },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('keeps scoped RunCommand matching positional and argv-explicit', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(echo "hello world")'],
        toolName: 'Bash',
        toolInput: { command: 'echo "hello world"' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: [
          'RunCommand(curl -H "Accept: application/json" https://api.example.com/*)',
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
        rules: ['RunCommand(echo "hello world")'],
        toolName: 'Bash',
        toolInput: { command: 'echo hello world' },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(curl https://api.example.com/*)'],
        toolName: 'Bash',
        toolInput: { command: 'curl -sSf https://api.example.com/x' },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(curl * https://api.example.com/*)'],
        toolName: 'Bash',
        toolInput: { command: 'curl -sSf https://api.example.com/x' },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(npm test *)'],
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
          rules: [
            'RunCommand(npm test *)',
            'RunCommand(echo *)',
            'RunCommand(cat *)',
          ],
          toolName: 'Bash',
          toolInput: { command },
        }),
      ).toMatchObject({ allowed: false });
    }

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(cat *)'],
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
        rules: ['RunCommand(acme records get *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'acme records get fixture_sheet_001 "\'Fixture Leads\'!A1:G5000" --json --account operator@example.test 2>&1',
        },
      }),
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(acme records get *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'acme records get fixture_sheet_001 "\'Fixture Leads\'!A1:G5000" --json --account operator@example.test 2>&1 | head -20',
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('head -20'),
    });
  });

  it('rejects absolute-path Bash meta executors in persistent scopes', () => {
    for (const rule of [
      'RunCommand(/bin/sh -c npm)',
      'RunCommand(/usr/bin/env npm test)',
      'RunCommand(/usr/bin/sudo npm test)',
      'RunCommand(/usr/bin/xargs npm)',
      'RunCommand(/usr/bin/find . -exec cat)',
      'RunCommand(command *)',
      'RunCommand(builtin *)',
      'RunCommand(timeout *)',
      'RunCommand(nohup *)',
    ]) {
      expect(validateAutonomousToolRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/meta-executor|not supported/),
      });
    }
  });

  it('does not widen interpreter script paths to wildcard durable scopes', () => {
    expect(validateAutonomousToolRule('RunCommand(python3 *)')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('too broad'),
    });
    expect(
      validateAutonomousToolRule('RunCommand(python3 /tmp/check.py)'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('host-owned Python scripts'),
    });
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(python3 /tmp/check.py)'],
        toolName: 'Bash',
        toolInput: { command: 'python3 /tmp/check.py' },
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(python3 /tmp/check.py)'],
        toolName: 'Bash',
        toolInput: { command: 'python3 -c "print(1)"' },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('denies host-owned script wildcard rules even when invoked through an interpreter', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(/tmp/dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: {
          command: 'python3 -c "print(1)" /tmp/dedup-append-lead.py',
        },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(/tmp/dedup-append-lead.py *)'],
        toolName: 'Bash',
        toolInput: {
          command: 'python3 /tmp/dedup-append-lead.py \'[["lead"]]\'',
        },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('matches generated runtime skill executions through stable skill paths', () => {
    for (const command of [
      'python3 /Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py --file /tmp/post.md',
      '/Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py --file /tmp/post.md',
    ]) {
      expect(
        evaluateAutonomousToolUse({
          rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
          toolName: 'Bash',
          toolInput: { command },
        }),
      ).toMatchObject({
        allowed: true,
        matchedRule: 'RunCommand(skills/linkedin-posting/post.py *)',
      });
    }

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'python3 /Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/other/post.py --file /tmp/post.md',
        },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateAutonomousToolUse({
        rules: [
          'RunCommand(/Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py *)',
        ],
        toolName: 'Bash',
        toolInput: {
          command:
            'python3 /Users/tester/gantry/agents/main_agent/.llm-runtime/claude/skills/linkedin-posting/post.py --file /tmp/post.md',
        },
      }),
    ).toMatchObject({ allowed: false });
  });

  it('matches reviewed skill commands with runtime-owned env and project aliases', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(date *)'],
        toolName: 'Bash',
        toolInput: {
          command: 'TZ=Asia/Kolkata date +"%Y-%m-%d %H:%M"',
        },
      }),
    ).toMatchObject({
      allowed: true,
      matchedRule: 'RunCommand(date *)',
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'REQUESTS_CA_BUNDLE=$NODE_EXTRA_CA_CERTS /opt/homebrew/bin/python3 "$CLAUDE_PROJECT_DIR/skills/linkedin-posting/post.py" --file /tmp/post.md --json',
        },
      }),
    ).toMatchObject({
      allowed: true,
      matchedRule: 'RunCommand(skills/linkedin-posting/post.py *)',
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'GODEBUG=netdns=go REQUESTS_CA_BUNDLE=${NODE_EXTRA_CA_CERTS} python3 ${CLAUDE_PROJECT_DIR}/skills/linkedin-posting/post.py --file /tmp/post.md',
        },
      }),
    ).toMatchObject({
      allowed: true,
      matchedRule: 'RunCommand(skills/linkedin-posting/post.py *)',
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            "GODEBUG=netdns=go NODE_EXTRA_CA_CERTS='/tmp/ca.pem' python3 skills/linkedin-posting/post.py --file /tmp/post.md",
        },
      }),
    ).toMatchObject({
      allowed: true,
      matchedRule: 'RunCommand(skills/linkedin-posting/post.py *)',
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            "GODEBUG=netdns=go SOME_PATH='/tmp/gantry'\\''s-ca.pem' python3 skills/linkedin-posting/post.py --file /tmp/post.md",
        },
      }),
    ).toMatchObject({
      allowed: true,
      matchedRule: 'RunCommand(skills/linkedin-posting/post.py *)',
    });
  });

  it('does not treat arbitrary environment assignments as reviewed command authority', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'ACCESS_TOKEN=$ACCESS_TOKEN python3 skills/linkedin-posting/post.py --file /tmp/post.md',
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('shell expansion'),
    });

    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(skills/linkedin-posting/post.py *)'],
        toolName: 'Bash',
        toolInput: {
          command:
            'REQUESTS_CA_BUNDLE=/tmp/other-ca.pem python3 skills/linkedin-posting/post.py --file /tmp/post.md',
        },
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('environment assignments'),
    });
  });

  it('rejects exact bare Bash as too broad', () => {
    expect(validateAutonomousToolRule('Bash')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('provider-native'),
    });
    expect(validateAutonomousToolRule('RunCommand')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('too broad'),
    });
    for (const rule of [
      'RunCommand(*)',
      'RunCommand(**)',
      'RunCommand(* npm test)',
    ]) {
      expect(validateAutonomousToolRule(rule)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('too broad'),
      });
    }
    expect(
      evaluateAutonomousToolUse({
        rules: ['RunCommand(*)'],
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

  it('maps exact Gantry file, web, and delegation facades to runtime SDK names', () => {
    expect(
      evaluateAutonomousToolUse({
        rules: ['FileRead'],
        toolName: 'Read',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['FileSearch'],
        toolName: 'Glob',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['FileSearch'],
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
        rules: ['WebRead'],
        toolName: 'WebFetch',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['FileEdit'],
        toolName: 'MultiEdit',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['FileWrite'],
        toolName: 'Write',
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutonomousToolUse({
        rules: ['AgentDelegation'],
        toolName: 'Agent',
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluateAutonomousToolUse({
        rules: ['AgentDelegation'],
        toolName: 'Task',
      }),
    ).toMatchObject({ allowed: false });
  });

  it('allows exact MCP tool names without extra scopes', () => {
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

  it('rejects browser and Gantry wildcard rules at the shared matcher boundary', () => {
    for (const rule of [
      'mcp__browser' + '_' + 'backend' + '__*',
      'mcp__browser' + '_' + 'backend' + '__navigate',
      'mcp__browser' + '_' + 'backend' + '__click',
      'mcp__browser' + '_' + 'backend' + '__screenshot',
      `${'mcp__agent'}_${'browser'}__*`,
      `mcp__${'play'}${'wright'}__click`,
      `mcp__${'pup'}${'peteer'}__screenshot`,
      'mcp__gantry__browser_act',
      'mcp__gantry__*',
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
        toolName: 'mcp__gantry__browser_act',
      }),
    ).toMatchObject({ allowed: true, matchedRule: 'Browser' });

    expect(
      evaluateAutonomousToolUse({
        rules: ['Browser'],
        toolName: 'mcp__gantry__browser_fake',
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('No autonomous tool rule matched'),
    });
  });

  it('validates malformed scoped and wildcard rules', () => {
    expect(validateAutonomousToolRule('Agent(worker)').ok).toBe(false);
    expect(validateAutonomousToolRule('Read(/repo/**)').ok).toBe(false);
    expect(validateAutonomousToolRule('RunCommand()').ok).toBe(false);
    expect(validateAutonomousToolRule('RunCommand(npm test').ok).toBe(false);
    expect(validateAutonomousToolRule('RunCommand(npm test) extra').ok).toBe(
      false,
    );
    expect(
      validateAutonomousToolRule('mcp__gantry__*(service_restart)').ok,
    ).toBe(false);
  });
});
