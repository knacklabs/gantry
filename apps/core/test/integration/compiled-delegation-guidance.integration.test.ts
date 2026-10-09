import { expect, it } from 'vitest';

import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import { PromptProfileService } from '@core/application/agents/prompt-profile-service.js';
import { buildGantryAgentSystemPrompt } from '@core/runner/gantry-agent-system-prompt.js';
import { AGENT_PERSONAS } from '@core/shared/agent-persona.js';

// Fix: agents-refuse-to-start-subagents-because.
// Compilation used to add a refusal to every
// non-developer persona even when the runner exposed delegate_task.
it('compiled personas permit mounted delegation and explain owner recovery when it is missing', async () => {
  for (const persona of AGENT_PERSONAS) {
    for (const accessPreset of ['full', 'locked'] as const) {
      for (const mounted of [true, false]) {
        const selectedToolRules = mounted ? ['AgentDelegation'] : [];
        const compiledSystemPrompt =
          await new PromptProfileService().compileSystemPrompt({
            agentFolder: `delegation-guidance-${persona}`,
            persona,
            accessPreset,
            capabilityCatalog: resolveAgentPromptCapabilityCatalog({
              appId: 'delegation-guidance',
              agentId: persona,
              readyToolRules: selectedToolRules,
            }),
          });
        for (const promptMode of ['full', 'minimal', 'none'] as const) {
          const { prompt } = buildGantryAgentSystemPrompt({
            compiledSystemPrompt,
            persona,
            promptMode,
            runtimeProjection: 'wrapped-tool-projection',
            selectedToolRules,
          });
          expect.soft(prompt).not.toMatch(/delegation is unavailable/i);
          expect
            .soft(prompt)
            .toContain(
              'Delegation is available through Gantry delegate_task when mounted',
            );
          if (!mounted) {
            expect
              .soft(prompt)
              .toContain('AgentDelegation has not been granted');
            expect.soft(prompt).toContain('locked access preset');
            expect.soft(prompt).toContain('delegation tools are hidden');
            expect
              .soft(prompt)
              .toContain('grant AgentDelegation to this agent');
            expect.soft(prompt).toContain('use the full access preset');
            expect.soft(prompt).toContain('enable the hidden tools');
            expect.soft(prompt).toContain('start a fresh run');
            expect.soft(prompt).toContain('Do not guess which gate applies');
          }
        }
      }
    }
  }
});
