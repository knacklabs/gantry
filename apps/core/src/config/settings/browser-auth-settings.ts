import { GANTRY_HOME } from '../index.js';
import { writeDesiredRuntimeSettings } from './runtime-settings.js';
import type { RuntimeSettings } from './runtime-settings-types.js';

export async function writeBrowserAuthenticationSettings(input: {
  previousSettings: RuntimeSettings;
  settings: RuntimeSettings;
  userId: string;
}): Promise<void> {
  await writeDesiredRuntimeSettings({
    runtimeHome: GANTRY_HOME,
    previousSettings: input.previousSettings,
    settings: input.settings,
    createdBy: `browser:${input.userId}`,
  });
}
