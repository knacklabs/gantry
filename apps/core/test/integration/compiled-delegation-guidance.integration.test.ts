import { expect, it } from 'vitest';

import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import { PromptProfileService } from '@core/application/agents/prompt-profile-service.js';
import { buildGantryAgentSystemPrompt } from '@core/runner/gantry-agent-system-prompt.js';
import { AGENT_PERSONAS } from '@core/shared/agent-persona.js';
import { renderGantryMcpToolAvailability } from '@core/shared/gantry-mcp-tool-surface.js';

// Fix: agents-refuse-to-start-subagents-because.
// Compilation used to add a refusal to every
// non-developer persona even when the runner exposed delegate_task.
it('compiled personas follow run delegation availability and its actual recovery gate', async () => {
  for (const persona of AGENT_PERSONAS) {
    for (const accessPreset of ['full', 'locked'] as const) {
      for (const mounted of [true, false]) {
        const selectedToolRules = mounted ? ['AgentDelegation'] : [];
        const compiledProfile =
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
        const compiledSystemPrompt = [
          compiledProfile,
          renderGantryMcpToolAvailability(selectedToolRules, {
            accessPreset,
            asyncTaskToolsEnabled: true,
          }),
        ].join('\n\n');
        for (const promptMode of ['full', 'minimal', 'none'] as const) {
          const { prompt } = buildGantryAgentSystemPrompt({
            compiledSystemPrompt,
            persona,
            promptMode,
            runtimeProjection: 'wrapped-tool-projection',
            selectedToolRules,
          });
          expect
            .soft(prompt)
            .toContain('Use Gantry delegate_task for delegation');
          const inventory = prompt.split('## Gantry tools in this run')[1];
          expect.soft(inventory).toBeDefined();
          const available =
            inventory?.match(/^Available: (.+)\.$/m)?.[1].split(', ') ?? [];
          const delegationAvailable = mounted && accessPreset === 'full';
          expect
            .soft(available.includes('delegate_task'))
            .toBe(delegationAvailable);
          if (!delegationAvailable) {
            const gate = inventory
              ?.split('\n')
              .find(
                (line) =>
                  line.startsWith('Unavailable: ') &&
                  line.includes('delegate_task'),
              );
            expect
              .soft(gate)
              .toContain(
                accessPreset === 'locked'
                  ? 'locked access preset'
                  : 'AgentDelegation has not been granted',
              );
            expect.soft(prompt).toContain('grant AgentDelegation');
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
