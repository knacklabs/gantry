import { it, expect } from 'vitest';
import { parseRuntimeSettingsObject } from '../../../src/config/settings/runtime-settings-parser.js';
it('validates exact operator Luna aliases through the real canonical settings parser', async () => {
  const { lunaValidationAlias } =
    await import('../../../../../scripts/chat-validation-luna-config.mjs');
  const parsed = parseRuntimeSettingsObject({
    model_aliases: { 'manipal.chat': lunaValidationAlias('manipal.chat') },
  });
  expect(parsed.modelAliases['manipal.chat']).toMatchObject({
    provider: 'openai',
    providerModelId: 'gpt-6-luna',
    source: { label: 'Isolated GPT-6 Luna validation' },
  });
});
