import type { ModelCatalogEntry } from './model-catalog.js';
/** Explicit operator-only exception for isolated validation. No automatic provider fallback. */
export function sourceChatLunaValidationEnabled(appId: string): boolean {
  return (
    process.env.GANTRY_FLEET_REHEARSAL_AUTO_SECRETS === '1' &&
    process.env.GANTRY_CHAT_VALIDATION_MODEL === 'gpt-6-luna' &&
    process.env.GANTRY_APP_ID === appId
  );
}
export function sourceChatModelAllowed(
  entry: Pick<ModelCatalogEntry, 'runnerModel' | 'modelRoute'>,
  appId: string,
): boolean {
  return (
    /^claude-haiku-4-5(?:-|$)/.test(entry.runnerModel) ||
    (sourceChatLunaValidationEnabled(appId) &&
      entry.modelRoute.id === 'openai' &&
      entry.runnerModel === 'gpt-6-luna')
  );
}
