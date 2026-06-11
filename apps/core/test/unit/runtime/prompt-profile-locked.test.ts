import { describe, expect, it, vi } from 'vitest';

import {
  PromptProfileService,
  defaultAgentsPromptMarkdown,
} from '@core/application/agents/prompt-profile-service.js';

// Tool names and flow phrases a locked (public-facing) agent must never see in
// its assembled instructions.
const BANNED_LOCKED_STRINGS = [
  'request_access',
  'request_skill_install',
  'request_skill_proposal',
  'request_skill_dependency_install',
  'request_mcp_server',
  'request_agent_profile_update',
  'request_settings_update',
  'settings_desired_state',
  'admin_permission_list',
  'admin_permission_revoke',
  'service_restart',
  'register_agent',
  'Gantry access flow',
  'reviewed capability',
  'configured approver',
  'conversation approval',
  'Gantry request tools',
];

const LOCKED_FRAGMENT_STRINGS = [
  'Work only with the tools and knowledge currently available in this session.',
  'say so plainly and offer what you can do instead',
  'Never mention internal capability, approval, or permission machinery',
];

function makeService(): PromptProfileService {
  return new PromptProfileService();
}

describe('locked prompt assembly', () => {
  it.each(['developer', 'operations', 'generalist'] as const)(
    'omits all capability/approval machinery for a locked %s agent',
    async (persona) => {
      const prompt = await makeService().compileSystemPrompt({
        agentFolder: 'support_agent',
        persona,
        accessPreset: 'locked',
      });

      for (const banned of BANNED_LOCKED_STRINGS) {
        expect(prompt).not.toContain(banned);
      }
      for (const fragment of LOCKED_FRAGMENT_STRINGS) {
        expect(prompt).toContain(fragment);
      }
      expect(prompt).not.toContain('## Proactive recommendations');
      // Non-machinery guidance still assembles.
      expect(prompt).toContain('## Memory');
      expect(prompt).toContain('## Communication');
      expect(prompt).toContain(
        '- Use send_message for progress updates and ask_user_question for structured choices.',
      );
    },
  );

  it('keeps the full prompt byte-identical with and without an explicit full preset', async () => {
    for (const persona of ['developer', 'operations'] as const) {
      const service = makeService();
      const implicit = await service.compileSystemPrompt({
        agentFolder: 'main_agent',
        persona,
      });
      const explicit = await service.compileSystemPrompt({
        agentFolder: 'main_agent',
        persona,
        accessPreset: 'full',
      });
      expect(explicit).toBe(implicit);
      // Full agents keep the machinery guidance.
      expect(implicit).toContain(
        'request_access target.kind=capability for durable reviewed access',
      );
      expect(implicit).toContain('## Proactive recommendations');
      expect(implicit).toContain('Gantry request tools');
    }
  });

  it('keeps full default AGENTS.md unchanged and strips machinery from the locked default', () => {
    const fullImplicit = defaultAgentsPromptMarkdown('Support', 'personal');
    const fullExplicit = defaultAgentsPromptMarkdown(
      'Support',
      'personal',
      'full',
    );
    expect(fullExplicit).toBe(fullImplicit);
    expect(fullImplicit).toContain('request_access');
    expect(fullImplicit).toContain('request_skill_install');

    const locked = defaultAgentsPromptMarkdown('Support', 'personal', 'locked');
    for (const banned of BANNED_LOCKED_STRINGS) {
      expect(locked).not.toContain(banned);
    }
    // Scheduler tools are not mounted for locked agents, so the locked default
    // profile must not describe them.
    expect(locked).not.toContain('scheduler_');
    expect(locked).toContain(
      'Work only with the tools and knowledge currently available in this session.',
    );
    expect(locked).toContain(
      'say so plainly and offer what you can do instead',
    );
  });

  it('seeds the locked default AGENTS.md through ensureAgentDefaults', async () => {
    const written: Array<{ virtualPath: string; content: string }> = [];
    const store = {
      listFileArtifacts: vi.fn(async () => []),
      writeFileArtifact: vi.fn(
        async (input: { virtualPath: string; content: string }) => {
          written.push({
            virtualPath: input.virtualPath,
            content: input.content,
          });
          return { id: 'artifact-1' };
        },
      ),
    };
    const service = new PromptProfileService({
      fileArtifactStore: () => store as never,
    });

    await service.ensureAgentDefaults({
      agentFolder: 'support_agent',
      agentName: 'Support',
      accessPreset: 'locked',
    });

    const agentsFile = written.find((file) =>
      file.virtualPath.endsWith('AGENTS.md'),
    );
    expect(agentsFile).toBeDefined();
    expect(agentsFile?.content).not.toContain('request_access');
    expect(agentsFile?.content).not.toContain('request_skill_install');
    expect(agentsFile?.content).toContain(
      'Work only with the tools and knowledge currently available in this session.',
    );
  });
});
