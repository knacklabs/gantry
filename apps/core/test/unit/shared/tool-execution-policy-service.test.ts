import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
  evaluateProtectedCapabilityToolUse,
} from '@core/shared/tool-execution-policy-service.js';
import { isGrantableAutonomousToolRecovery } from '@core/shared/autonomous-tool-denial.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

function capability(
  overrides: Partial<SemanticCapabilityDefinition> &
    Pick<
      SemanticCapabilityDefinition,
      'capabilityId' | 'credentialSource' | 'implementationBindings'
    >,
): SemanticCapabilityDefinition {
  return {
    displayName: overrides.capabilityId,
    category: 'test',
    risk: 'write',
    can: 'do the reviewed thing',
    cannot: 'do anything else',
    ...overrides,
  };
}

function definitionsById(
  ...defs: SemanticCapabilityDefinition[]
): Record<string, SemanticCapabilityDefinition> {
  return Object.fromEntries(defs.map((def) => [def.capabilityId, def]));
}

const classifier = new ToolExecutionClassifier();
const policy = new ToolExecutionPolicyService();
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ToolExecutionPolicyService', () => {
  it('classifies canonical tool requests with target and mutation intent', () => {
    expect(
      classifier.classify({
        origin: 'sdk',
        toolName: 'Write',
        toolInput: { file_path: '/repo/.mcp.json', content: '{}' },
      }),
    ).toMatchObject({
      origin: 'sdk',
      toolKind: 'file',
      toolName: 'Write',
      targetResource: '/repo/.mcp.json',
      mutationIntent: 'write',
      executionMode: 'interactive',
    });
  });

  it('classifies raw agent browser MCP tools as generic MCP tools', () => {
    expect(
      classifier.classify({
        origin: 'mcp',
        toolName: 'mcp__browser' + '_' + 'backend' + '__click',
        toolInput: { selector: '#submit' },
      }),
    ).toMatchObject({
      origin: 'mcp',
      toolKind: 'mcp',
      toolName: 'mcp__browser' + '_' + 'backend' + '__click',
      mutationIntent: 'unknown',
    });
  });

  it('allows projected browser tools for autonomous runs with canonical Browser capability', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'mcp__gantry__browser_status',
      toolInput: {},
      executionMode: 'autonomous',
    });

    expect(
      policy.evaluate({
        request,
        autonomousAllowedToolRules: ['Browser'],
      }),
    ).toMatchObject({
      status: 'allow',
      matchedRule: 'Browser',
    });
  });

  it('recovers projected browser denials through persistent Browser permission', () => {
    const request = classifier.classify({
      origin: 'mcp',
      toolName: 'mcp__gantry__browser_act',
      toolInput: { url: 'https://example.com' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-1' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toEqual(
      expect.objectContaining({
        status: 'deny',
        reason: expect.stringContaining(
          'Tool not on autonomous run allowlist: mcp__gantry__browser_act.',
        ),
        recoveryAction: expect.stringContaining('"id": "browser.use"'),
      }),
    );
    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] })
        .recoveryAction,
    ).not.toContain('scheduler_grant_tool');
  });

  it('recovers admin tool denials through exact persistent tool approval', () => {
    const request = classifier.classify({
      origin: 'mcp',
      toolName: 'mcp__gantry__settings_desired_state',
      toolInput: {},
      executionMode: 'autonomous',
      runContext: { jobId: 'job-1' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toEqual(
      expect.objectContaining({
        status: 'deny',
        recoveryAction: expect.stringContaining(
          '"name": "mcp__gantry__settings_desired_state"',
        ),
      }),
    );
    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] })
        .recoveryAction,
    ).toContain('exact Gantry tool access');
  });

  it('does not auto-allow newly durable-grantable exact Gantry tools', () => {
    const request = classifier.classify({
      origin: 'mcp',
      toolName: 'mcp__gantry__scheduler_resume_job',
      toolInput: { jobId: 'job-1' },
    });

    expect(policy.evaluate({ request })).toMatchObject({
      status: 'not_applicable',
      reason: 'No canonical tool execution policy matched.',
    });
  });

  it('denies protected capability file targets through canonical policy', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Write',
      toolInput: { file_path: '/repo/.mcp.json', content: '{}' },
    });

    expect(policy.evaluate({ request })).toMatchObject({
      status: 'deny',
      reason: expect.stringContaining('MCP capability'),
      audit: {
        category: 'tool_execution',
        origin: 'sdk',
        toolKind: 'file',
        toolName: 'Write',
        mutationIntent: 'write',
        targetResource: '/repo/.mcp.json',
      },
      recoveryAction: expect.stringContaining('request_mcp_server'),
    });
  });

  it('denies auxiliary files under skill capability roots', () => {
    for (const filePath of [
      '/repo/.codex/skills/review/references/checklist.md',
      '/repo/.agents/skills/review/scripts/check.js',
      '/repo/.claude/skills/review/assets/template.md',
      '/tmp/gantry/agents/kai_tg_1/skills/linkedin/context.md',
      '/tmp/gantry/artifacts/skills/default/skill-one/hash/context.md',
    ]) {
      const request = classifier.classify({
        origin: 'sdk',
        toolName: 'Write',
        toolInput: { file_path: filePath, content: 'changed' },
      });

      expect(policy.evaluate({ request }), filePath).toMatchObject({
        status: 'deny',
        reason: expect.stringContaining('skill capability path'),
      });
    }
  });

  it('denies runtime settings file targets through canonical policy', () => {
    for (const toolName of ['Write', 'Edit', 'MultiEdit']) {
      const request = classifier.classify({
        origin: 'sdk',
        toolName,
        toolInput: { file_path: '~/gantry/settings.yaml', content: '{}' },
      });

      expect(policy.evaluate({ request })).toMatchObject({
        status: 'deny',
        reason: expect.stringContaining('runtime settings capability path'),
      });
    }
  });

  it('allows issue bodies that mention protected terms without targeting them', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command:
          'gh issue create --title "docs" --body "Please document .mcp.json and mcpServers behavior"',
      }),
    ).toBeNull();
  });

  it('does not bypass protected-target mutation checks for compound gh commands', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command:
          'gh issue create --title "x" --body "y"; cat > .mcp.json <<\'EOF\'\n{}\nEOF',
      }),
    ).toMatchObject({
      reason: expect.stringContaining('protected capability target'),
    });
  });

  it('denies protected targets referenced in gh command substitutions', () => {
    for (const command of [
      'gh issue create --title "x" --body "$(cat > .mcp.json)"',
      'gh issue create --title "x" --body "$(cat > .claude/settings.json)"',
    ]) {
      expect(
        evaluateProtectedCapabilityToolUse('Bash', {
          command,
        }),
        command,
      ).toMatchObject({
        reason: expect.stringContaining('protected capability target'),
      });
    }
  });

  it('denies gh payload arguments that pass protected file paths', () => {
    for (const command of [
      'gh issue create --title "x" --body-file ~/.claude/settings.local.json',
      'gh issue create --title "x" --body-file ~/gantry/settings.yaml',
      'gh pr create --title "x" --template .mcp.json',
      'gh issue create --title "x" -F body=@.mcp.json',
      'gh issue edit .mcp.json --title "x"',
      'gh issue create --title "x" --body "$(cat ~/.claude/settings.local.json)"',
    ]) {
      const result = evaluateProtectedCapabilityToolUse('Bash', {
        command,
      });
      if (!result) {
        throw new Error(`expected protected-path denial for: ${command}`);
      }
      expect(result).toMatchObject({
        reason: expect.stringContaining('protected capability target'),
      });
    }
  });

  it('does not deny gh payload files for unrelated settings.json paths', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command:
          'gh issue create --title "x" --body-file /repo/config/settings.json',
      }),
    ).toBeNull();
  });

  it('denies shell commands that mutate protected targets', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command: 'cat > .mcp.json',
      }),
    ).toMatchObject({
      reason: expect.stringContaining('protected capability target'),
    });

    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command: 'claude mcp add-json github {"type":"http"}',
      }),
    ).toMatchObject({
      reason: expect.stringContaining('MCP capability'),
    });
  });

  it('denies compound shell commands when a later target is protected', () => {
    for (const command of [
      'echo ok > /tmp/out; cat > .mcp.json',
      'printf ok > /tmp/out && dd if=/tmp/payload of=.claude/settings.json',
      'node build.js --output /tmp/out && tee ~/.claude/settings.json',
    ]) {
      expect(
        evaluateProtectedCapabilityToolUse('Bash', { command }),
      ).toMatchObject({
        reason: expect.stringContaining('protected capability target'),
      });
    }
  });

  it('denies scheduler scripts that write runtime settings even when Bash is granted', () => {
    const request = classifier.classify({
      origin: 'scheduler_script',
      toolName: 'Bash',
      toolInput: { command: 'cat > ~/gantry/settings.yaml' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-settings' },
    });

    expect(
      policy.evaluate({
        request,
        autonomousAllowedToolRules: [
          'RunCommand(cat > ~/gantry/settings.yaml)',
        ],
      }),
    ).toMatchObject({
      status: 'deny',
      reason: expect.stringContaining('protected capability target'),
    });
  });

  it('fails closed for protected paths referenced by shell write forms', () => {
    for (const command of [
      'dd if=/tmp/payload of=.mcp.json',
      'awk 1 /tmp/payload | sponge .mcp.json',
      'rsync /tmp/settings.json ~/.claude/settings.json',
      'ruby -e "File.write(\\".mcp.json\\", \\"{}\\")"',
    ]) {
      expect(
        evaluateProtectedCapabilityToolUse('Bash', { command }),
      ).toMatchObject({
        reason: expect.stringContaining('protected capability target'),
      });
    }
  });

  it('fails closed for shell writes to auxiliary skill files', () => {
    for (const command of [
      'cat > .codex/skills/review/references/checklist.md',
      'tee .agents/skills/review/scripts/check.js',
      'printf ok > /tmp/gantry/artifacts/skills/default/skill-one/hash/context.md',
    ]) {
      expect(
        evaluateProtectedCapabilityToolUse('Bash', { command }),
        command,
      ).toMatchObject({
        reason: expect.stringContaining('protected capability target'),
      });
    }
  });

  it('denies provider settings writes even when payload avoids legacy permission keys', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Write', {
        file_path: '/repo/.claude/settings.json',
        content: JSON.stringify({ hooks: { PreToolUse: [] } }),
      }),
    ).toMatchObject({
      reason: expect.stringContaining('provider settings capability path'),
    });
  });

  it('does not classify arbitrary settings.json files as provider capability settings', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Write', {
        file_path: '/repo/config/settings.json',
        content: '{"safe":true}',
      }),
    ).toBeNull();
  });

  it('denies file mutation targets that resolve through symlinks to protected paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-policy-'));
    tempRoots.push(root);
    const protectedDir = path.join(root, '.claude');
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(protectedDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const protectedSettings = path.join(protectedDir, 'settings.json');
    fs.writeFileSync(protectedSettings, '{}');
    const link = path.join(workspaceDir, 'settings-link.json');
    fs.symlinkSync(protectedSettings, link);

    expect(
      evaluateProtectedCapabilityToolUse('Write', {
        file_path: link,
        content: '{}',
      }),
    ).toMatchObject({
      reason: expect.stringContaining('provider settings capability path'),
    });
  });

  it('fails autonomous runs fast and points to persistent agent tool approval', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-1' },
    });

    const result = policy.evaluate({ request, autonomousAllowedToolRules: [] });
    expect(result).toEqual(
      expect.objectContaining({
        status: 'deny',
        reason: expect.stringContaining(
          'Tool not on autonomous run allowlist: RunCommand.',
        ),
        recoveryAction:
          'request_access { "target": { "kind": "run_command", "argvPattern": "npm test" }, "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }',
      }),
    );
    expect(result.recoveryAction).not.toContain('scheduler_grant_tool');
  });

  it('points autonomous scheduler tool denials to exact persistent tool approval', () => {
    const request = classifier.classify({
      origin: 'mcp',
      toolName: 'mcp__gantry__scheduler_run_now',
      toolInput: { jobId: 'job-1' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-manager' },
    });

    const result = policy.evaluate({ request, autonomousAllowedToolRules: [] });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'deny',
        reason: expect.stringContaining(
          'Tool not on autonomous run allowlist: mcp__gantry__scheduler_run_now.',
        ),
        recoveryAction:
          'request_access { "target": { "kind": "tool", "name": "mcp__gantry__scheduler_run_now" }, "temporaryOnly": false, "reason": "This autonomous run needs exact Gantry tool access." }',
      }),
    );
  });

  it('allows autonomous read-only inspection of generated runtime tool results without durable grants', () => {
    const resultPath =
      '/Users/example/gantry/agents/main_agent/.llm-runtime/claude/projects/-Users-example-gantry-agents-main-agent/run-1/tool-results/result.txt';
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: { command: `tail -20 ${resultPath}` },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-generated-results' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toMatchObject({
      status: 'allow',
      matchedRule: 'runtime:generated-tool-results:read',
      reason: expect.stringContaining('read-only inspection'),
    });
  });

  it('does not allow autonomous mutation or broader generated runtime access through tool-result read allowance', () => {
    const resultPath =
      '/Users/example/gantry/agents/main_agent/.llm-runtime/claude/projects/-Users-example-gantry-agents-main-agent/run-1/tool-results/result.txt';
    const settingsPath =
      '/Users/example/gantry/agents/main_agent/.llm-runtime/claude/settings.json';

    for (const command of [
      `tail -20 ${settingsPath}`,
      `rm ${resultPath}`,
      `cat ${resultPath} > /tmp/copied-result.txt`,
    ]) {
      const request = classifier.classify({
        origin: 'sdk',
        toolName: 'Bash',
        toolInput: { command },
        executionMode: 'autonomous',
        runContext: { jobId: 'job-generated-results' },
      });

      expect(
        policy.evaluate({ request, autonomousAllowedToolRules: [] }),
        command,
      ).toMatchObject({
        status: 'deny',
      });
    }
  });

  it('allows autonomous MCP calls matching a reviewed pattern rule', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'mcp__github__search_repositories',
      toolInput: { q: 'gantry' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-pattern' },
    });

    expect(
      policy.evaluate({
        request,
        autonomousAllowedToolRules: ['mcp__github__search_*'],
      }),
    ).toMatchObject({
      status: 'allow',
      matchedRule: 'mcp__github__search_*',
    });
  });

  it('gives provision-before-run recovery when capability request tools are hidden', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'mcp__github__create_issue',
      toolInput: { title: 'Bug' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-hidden' },
    });

    const visible = policy.evaluate({
      request,
      autonomousAllowedToolRules: [],
    });
    expect(visible.status).toBe('deny');
    expect(visible.recoveryAction).toContain('request_mcp_server');

    const hidden = policy.evaluate({
      request,
      autonomousAllowedToolRules: [],
      capabilityRequestToolsHidden: true,
    });
    expect(hidden.status).toBe('deny');
    expect(hidden.recoveryAction).toContain(
      'provision a reviewed capability covering mcp__github__create_issue before the run',
    );
    expect(hidden.recoveryAction).not.toContain('request_mcp_server');
    expect(hidden.recoveryAction).not.toContain('request_access');
  });

  it('gives provision-before-run recovery for protected capability writes when request tools are hidden', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Write',
      toolInput: { file_path: '/repo/.mcp.json', content: '{}' },
    });

    const hidden = policy.evaluate({
      request,
      capabilityRequestToolsHidden: true,
    });
    expect(hidden.status).toBe('deny');
    expect(hidden.recoveryAction).toContain('provision the reviewed change');
    expect(hidden.recoveryAction).not.toContain('request_mcp_server');
    expect(hidden.recoveryAction).not.toContain('request_skill_install');
  });

  it('does not suggest durable approval for generated runtime paths', () => {
    const resultPath =
      '/Users/example/gantry/agents/main_agent/.llm-runtime/claude/projects/-Users-example-gantry-agents-main-agent/run-1/tool-results/result.txt';
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: { command: `rm ${resultPath}` },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-generated-results' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toMatchObject({
      status: 'deny',
      recoveryAction:
        'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.',
    });
  });

  it('does not suggest durable approval for autonomous host-owned script calls', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command:
          'python3 /Users/example/scripts/dedup-append-lead.py \'[["lead"]]\'',
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-1' },
    });

    const result = policy.evaluate({ request, autonomousAllowedToolRules: [] });
    expect(result).toEqual(
      expect.objectContaining({
        status: 'deny',
        recoveryAction:
          'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.',
      }),
    );
  });

  it('uses the same agent permission flow for mutating autonomous Bash use', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command: 'echo "{}" > /tmp/archive.tgz',
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-2' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toEqual(
      expect.objectContaining({
        status: 'deny',
        recoveryAction:
          'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.',
      }),
    );
  });

  it('does not suggest obsolete whole-command Bash recovery for compound commands', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command: 'cd /tmp/evil && npm test',
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-2' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toEqual(
      expect.objectContaining({
        status: 'deny',
        recoveryAction:
          'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.',
      }),
    );
  });

  it('does not suggest autonomous broad Bash grants', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command: 'node -e "console.log(process.cwd())"',
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-3' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toEqual(
      expect.objectContaining({
        status: 'deny',
        recoveryAction:
          'Update the autonomous run to use a reviewed semantic capability or invoke a scoped RunCommand(...) command directly. This command cannot be durably approved for autonomous runs.',
      }),
    );
  });

  it('allows autonomous reviewed commands despite runtime-owned env aliases', () => {
    const skillRequest = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command:
          'REQUESTS_CA_BUNDLE=$NODE_EXTRA_CA_CERTS /opt/homebrew/bin/python3 "$CLAUDE_PROJECT_DIR/skills/linkedin-posting/post.py" --file /tmp/post.md --json',
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-skill' },
    });

    expect(
      policy.evaluate({
        request: skillRequest,
        autonomousAllowedToolRules: [
          'RunCommand(skills/linkedin-posting/post.py *)',
        ],
      }),
    ).toMatchObject({
      status: 'allow',
      matchedRule: 'RunCommand(skills/linkedin-posting/post.py *)',
    });

    const cliRequest = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command:
          "GODEBUG=netdns=go HTTPS_PROXY='http://127.0.0.1:18080/' NO_PROXY='' REQUESTS_CA_BUNDLE='/tmp/gantry-ca.pem' CURL_CA_BUNDLE='/tmp/gantry-ca.pem' /opt/homebrew/bin/acme records get leads --json",
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-cli' },
    });

    expect(
      policy.evaluate({
        request: cliRequest,
        autonomousAllowedToolRules: [
          'RunCommand(/opt/homebrew/bin/acme records get *)',
        ],
      }),
    ).toMatchObject({
      status: 'allow',
      matchedRule: 'RunCommand(/opt/homebrew/bin/acme records get *)',
    });
  });

  it('recovers autonomous runtime-owned env aliases as plain scoped commands', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command:
          'GODEBUG=netdns=go /opt/homebrew/bin/acme records get leads --json',
      },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-cli' },
    });

    expect(
      policy.evaluate({ request, autonomousAllowedToolRules: [] }),
    ).toMatchObject({
      status: 'deny',
      recoveryAction:
        'request_access { "target": { "kind": "run_command", "argvPattern": "/opt/homebrew/bin/acme records get leads --json" }, "temporaryOnly": false, "reason": "This autonomous run needs scoped command access." }',
    });
  });

  it('preserves closest-rule mismatch details on autonomous denials', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: { command: 'npm test -- --runInBand' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-closest' },
    });

    expect(
      policy.evaluate({
        request,
        autonomousAllowedToolRules: ['RunCommand(npm run build)'],
      }),
    ).toMatchObject({
      status: 'deny',
      reason: expect.stringContaining('npm test -- --runInBand'),
      closestRule: {
        rule: 'RunCommand(npm run build)',
        reason: expect.stringContaining('npm test -- --runInBand'),
      },
    });
  });
});

describe('autonomousGrantRecovery', () => {
  it('canonical facade tool WebSearch is grantable via request_access kind:tool', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'WebSearch',
      toolInput: { query: 'Gantry' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-web-search' },
    });

    const result = policy.evaluate({
      request,
      autonomousAllowedToolRules: [],
    });

    expect(result).toMatchObject({
      status: 'deny',
      recoveryAction:
        'request_access { "target": { "kind": "tool", "name": "WebSearch" }, "temporaryOnly": false, "reason": "This autonomous run needs exact Gantry tool access." }',
    });
    expect(isGrantableAutonomousToolRecovery(result.recoveryAction)).toBe(true);

    const hidden = policy.evaluate({
      request,
      autonomousAllowedToolRules: [],
      capabilityRequestToolsHidden: true,
    });
    expect(hidden.recoveryAction).toContain(
      'provision a reviewed capability covering WebSearch before the run',
    );
    expect(isGrantableAutonomousToolRecovery(hidden.recoveryAction)).toBe(
      false,
    );
  });

  it.each([
    ['WebFetch', 'WebRead', { url: 'https://example.com' }],
    ['Read', 'FileRead', { file_path: '/repo/notes.md' }],
    ['Write', 'FileWrite', { file_path: '/repo/out.md', content: 'done' }],
    ['Edit', 'FileEdit', { file_path: '/repo/out.md' }],
  ])(
    'canonicalizes provider tool %s to facade %s for durable recovery',
    (toolName, canonicalName, toolInput) => {
      const request = classifier.classify({
        origin: 'sdk',
        toolName,
        toolInput,
        executionMode: 'autonomous',
        runContext: { jobId: 'job-facade-alias' },
      });

      expect(
        policy.evaluate({ request, autonomousAllowedToolRules: [] }),
      ).toMatchObject({
        status: 'deny',
        recoveryAction: expect.stringContaining(`"name": "${canonicalName}"`),
      });
    },
  );
});

describe('ToolExecutionPolicyService semantic capability resolution', () => {
  const sheetsCapability = capability({
    capabilityId: 'google.sheets.values.update',
    credentialSource: 'local_cli',
    implementationBindings: [
      {
        kind: 'local_cli',
        commandTemplates: ['/opt/homebrew/bin/gog sheets values update *'],
      },
    ],
  });

  it('resolves a granted local_cli capability rule to its command bundle without a hand-written RunCommand', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: {
        command: '/opt/homebrew/bin/gog sheets values update Sheet1 42',
      },
    });

    expect(
      policy.evaluate({
        request,
        allowedToolRules: ['capability:google.sheets.values.update'],
        semanticCapabilityDefinitions: definitionsById(sheetsCapability),
      }),
    ).toMatchObject({
      status: 'allow',
      reason: 'Allowed by selected capability google.sheets.values.update.',
      matchedRule: 'RunCommand(/opt/homebrew/bin/gog sheets values update *)',
    });
  });

  it('resolves a granted mcp_server capability rule to its reviewed tool names', () => {
    const mcpCapability = capability({
      capabilityId: 'github.issues.create',
      credentialSource: 'configured_access',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: 'github',
          mcpToolPatterns: ['create_issue'],
        },
      ],
    });
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'mcp__github__create_issue',
      toolInput: { title: 'Bug' },
      executionMode: 'autonomous',
      runContext: { jobId: 'job-mcp' },
    });

    expect(
      policy.evaluate({
        request,
        autonomousAllowedToolRules: ['capability:github.issues.create'],
        semanticCapabilityDefinitions: definitionsById(mcpCapability),
      }),
    ).toMatchObject({
      status: 'allow',
      reason: 'Allowed by selected capability github.issues.create.',
      matchedRule: 'mcp__github__create_issue',
    });
  });

  it('resolves a granted builtin_tool capability rule to its runtime tool authority', () => {
    const readCapability = capability({
      capabilityId: 'files.read',
      credentialSource: 'none',
      risk: 'read',
      implementationBindings: [{ kind: 'tool_rule', rule: 'FileRead' }],
    });
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Read',
      toolInput: { file_path: '/repo/notes.md' },
    });

    expect(
      policy.evaluate({
        request,
        allowedToolRules: ['capability:files.read'],
        semanticCapabilityDefinitions: definitionsById(readCapability),
      }),
    ).toMatchObject({
      status: 'allow',
      reason: 'Allowed by selected capability files.read.',
      matchedRule: 'FileRead',
    });
  });

  it('does not authorize a tool outside the resolved capability bundle', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Bash',
      toolInput: { command: 'curl https://evil.example.com' },
    });

    expect(
      policy.evaluate({
        request,
        allowedToolRules: ['capability:google.sheets.values.update'],
        semanticCapabilityDefinitions: definitionsById(sheetsCapability),
      }),
    ).toMatchObject({ status: 'not_applicable' });
  });

  it('skips an unresolvable capability rule without poisoning an unrelated granted tool', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Read',
      toolInput: { file_path: '/repo/notes.md' },
    });

    const result = policy.evaluate({
      request,
      // The granted capability is present but its definition is not available;
      // FileRead must still be decided on its own merits.
      allowedToolRules: ['capability:google.sheets.values.update', 'FileRead'],
      semanticCapabilityDefinitions: {},
    });
    expect(result).toMatchObject({ status: 'allow', matchedRule: 'FileRead' });
    expect(result.reason).not.toContain('Unsupported autonomous tool rule');
  });

  it('skips an inherited prototype capability id while resolving an owned definition', () => {
    const readCapability = capability({
      capabilityId: 'files.read',
      credentialSource: 'none',
      risk: 'read',
      implementationBindings: [{ kind: 'tool_rule', rule: 'FileRead' }],
    });
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'Read',
      toolInput: { file_path: '/repo/notes.md' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = policy.evaluate({
        request,
        allowedToolRules: [
          'capability:constructor',
          'capability:toString',
          'capability:files.read',
        ],
        semanticCapabilityDefinitions: definitionsById(readCapability),
      });

      expect(result).toMatchObject({
        status: 'allow',
        reason: 'Allowed by selected capability files.read.',
        matchedRule: 'FileRead',
      });
      expect(warn).toHaveBeenCalledWith(
        '[tool-execution-policy] skipping unresolved capability rule capability:constructor (no reviewed definition available)',
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not turn an unrelated tool into a capability-mismatch deny when a capability rule is unresolvable', () => {
    const request = classifier.classify({
      origin: 'sdk',
      toolName: 'render_progress',
      toolInput: {},
    });

    const result = policy.evaluate({
      request,
      allowedToolRules: ['capability:google.sheets.values.update'],
      semanticCapabilityDefinitions: {},
    });
    expect(result.status).toBe('not_applicable');
    expect(result.reason).not.toContain('Unsupported autonomous tool rule');
    expect(result.reason).not.toContain('google.sheets.values.update');
  });
});
