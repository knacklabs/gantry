import fs from 'fs';
import os from 'os';
import path from 'path';

interface RuntimeHomeOptions {
  configureSettings?: (settings: any) => void;
}

export interface RuntimeHomeHandle {
  runtimeHome: string;
  settings: any;
  cleanup: () => void;
}

export async function createTempRuntimeHome(
  options: RuntimeHomeOptions = {},
): Promise<RuntimeHomeHandle> {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-hermetic-runtime-'),
  );

  const previousAgentRoot = process.env.AGENT_ROOT;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const previousHome = process.env.HOME;
  process.env.AGENT_ROOT = runtimeHome;
  process.env.HOME = runtimeHome;
  delete process.env.OPENAI_API_KEY;

  const runtimeSettings = await import('@core/cli/runtime-settings.js');
  const sessionHooks = await import('@core/cli/session-hooks.js');
  const settings = runtimeSettings.createDefaultRuntimeSettingsForTest();
  settings.memory.enabled = true;
  settings.memory.root = 'memory';
  settings.memory.embeddings.enabled = false;
  settings.memory.embeddings.provider = 'disabled';
  settings.memory.dreaming.enabled = false;
  options.configureSettings?.(settings);
  runtimeSettings.saveRuntimeSettings(runtimeHome, settings);

  fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
  const hookPlan = sessionHooks.buildSessionHookInstallPlan(
    path.join(runtimeHome, '.claude', 'settings.json'),
  );
  sessionHooks.applySessionHookInstallPlan(hookPlan);

  return {
    runtimeHome,
    settings,
    cleanup: () => {
      if (previousAgentRoot === undefined) {
        delete process.env.AGENT_ROOT;
      } else {
        process.env.AGENT_ROOT = previousAgentRoot;
      }
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    },
  };
}
