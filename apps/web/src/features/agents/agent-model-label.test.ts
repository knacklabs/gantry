import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { agentModelLabel } from './agent-model-label';

it('uses the proper Claude family name and avoids repeating provider names', () => {
  expect(agentModelLabel('Opus 5', 'anthropic', 'Anthropic')).toBe(
    'Claude Opus 5',
  );
  expect(
    agentModelLabel('Bedrock Kimi K2.5', 'bedrock', 'Amazon Bedrock'),
  ).toBe('Kimi K2.5');
  expect(agentModelLabel('GPT-5.5', 'openai', 'OpenAI')).toBe('GPT-5.5');
});

it('shows AI provider and friendly model name separately from the channel in Roster', () => {
  const roster = readFileSync(
    'src/features/agents/routes/agents-route.tsx',
    'utf8',
  );
  expect(roster).toContain('AI provider / model');
  expect(roster).toContain('agent.modelProviderLabel');
  expect(roster).toContain('agentModelLabel(');
});
