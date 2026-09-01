import { describe, expect, it, vi } from 'vitest';

import {
  scheduledPermissionSuggestions,
  synthesizePermissionSuggestions,
} from '@core/adapters/llm/anthropic-claude-agent/runner/permission-suggestions.js';
import { synthesizeHostPermissionSuggestions } from '@core/application/permissions/permission-suggestion-synthesis.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { coordinatePermissionDecision } from '@core/runtime/permission-decision-coordinator.js';
import {
  synthesizeFamilyRunCommandRuleContents,
  isFamilyRunCommandRule,
  isFamilyRunCommandRuleContent,
} from '@core/shared/family-rule-synthesis.js';
import { permissionUpdateAllowedToolRules } from '@core/shared/permission-tool-rules.js';
import {
  autonomousToolAuthorityAddition,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '@core/shared/tool-execution-policy-service.js';

describe('family rule synthesis', () => {
  it('family rule allows the same command with different args without asking', async () => {
    expect(synthesizeFamilyRunCommandRuleContents('gh issue view 42')).toEqual([
      'gh *',
    ]);
    expect(
      synthesizeFamilyRunCommandRuleContents(
        'gh issue view 42 && git status --short',
      ),
    ).toEqual(['gh *', 'git *']);

    const policyDecision = new ToolExecutionPolicyService().evaluate({
      request: new ToolExecutionClassifier().classify({
        origin: 'host',
        toolName: 'RunCommand',
        toolInput: { command: 'gh pr list --state open' },
      }),
      allowedToolRules: ['RunCommand(gh *)'],
    });
    expect(policyDecision).toMatchObject({
      status: 'allow',
      matchedRule: 'RunCommand(gh *)',
      isFamilyRule: true,
    });

    const tail = vi.fn();
    await expect(
      coordinatePermissionDecision({
        request: {
          requestId: 'family-later-run',
          sourceAgentFolder: 'main_agent',
          toolName: 'RunCommand',
          toolInput: { command: 'gh pr list --state open' },
        } satisfies PermissionApprovalRequest,
        reviewedRuleDecision: policyDecision,
        deterministicRails: () => undefined,
        tail,
      }),
    ).resolves.toMatchObject({
      approved: true,
      decidedBy: 'reviewed_rule',
    });
    expect(tail).not.toHaveBeenCalled();
  });

  it('pipes and durable exclusions synthesize no family rule in any lane', () => {
    const lanes = {
      host: (command: string) =>
        permissionUpdateAllowedToolRules(
          synthesizeHostPermissionSuggestions('RunCommand', { command }),
        ),
      sdk: (command: string) =>
        permissionUpdateAllowedToolRules(
          synthesizePermissionSuggestions('Bash', {
            toolInput: { command },
          }),
        ),
      autonomous: (command: string) =>
        permissionUpdateAllowedToolRules([
          autonomousToolAuthorityAddition({
            toolName: 'RunCommand',
            toolInput: { command },
          }),
        ]),
    };
    const excludedCommands = [
      'npm test | tee report.txt',
      '/usr/bin/env npm test',
      'cd /tmp',
      'node app.js',
      'cat secrets.env > /tmp/copy',
      'python3 /tmp/check.py',
    ];

    for (const [lane, synthesize] of Object.entries(lanes)) {
      for (const command of excludedCommands) {
        expect(synthesize(command), `${lane}: ${command}`).toEqual([]);
      }
    }
    expect(
      scheduledPermissionSuggestions(
        'Bash',
        [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'Bash',
                ruleContent: 'npm test | tee report.txt',
              },
            ],
          },
        ],
        { toolInput: { command: 'npm test | tee report.txt' } },
      ),
    ).toBeUndefined();
  });

  it('never mints or classifies a family for script-leaf argv0 forms', () => {
    // A host-owned script argv0 must not become an executable-wide family:
    // later arguments were never reviewed (autoreview P1, window Q-0134).
    expect(
      synthesizeFamilyRunCommandRuleContents('/workspace/report.py --daily'),
    ).toEqual([]);
    expect(synthesizeFamilyRunCommandRuleContents('report.py --daily')).toEqual(
      [],
    );
    expect(isFamilyRunCommandRuleContent('/workspace/skills/report.py *')).toBe(
      false,
    );
    expect(isFamilyRunCommandRuleContent('report.py *')).toBe(false);
  });

  it('rejects shell expansions in absolute family executables', () => {
    // `/$TOOL` resolves per-environment: one grant must never cover
    // different resolved binaries (autoreview round 4, window Q-0137).
    expect(synthesizeFamilyRunCommandRuleContents('/$TOOL --status')).toEqual(
      [],
    );
    expect(
      synthesizeFamilyRunCommandRuleContents('/${TOOL}/bin/run --x'),
    ).toEqual([]);
    expect(isFamilyRunCommandRuleContent('/$TOOL *')).toBe(false);
    expect(
      isFamilyRunCommandRuleContent('/usr/local/bin/report-status *'),
    ).toBe(true);
  });

  it('keeps reviewed skill script rules exact rather than family-marked', () => {
    const [ruleContent] = synthesizeFamilyRunCommandRuleContents(
      'python3 skills/linkedin-posting/post.py --file post.md',
    );
    expect(ruleContent).toBe('skills/linkedin-posting/post.py *');
    expect(isFamilyRunCommandRule(`RunCommand(${ruleContent})`)).toBe(false);
  });
});
