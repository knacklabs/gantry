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
  process.env.AGENT_ROOT = runtimeHome;
  delete process.env.OPENAI_API_KEY;

  const runtimeSettings = await import('@core/cli/runtime-settings.js');
  const settings = runtimeSettings.createDefaultRuntimeSettingsForTest();
  settings.memory.enabled = true;
  settings.memory.provider = 'sqlite';
  settings.memory.sqlitePath = 'store/memory.db';
  settings.memory.embeddings.enabled = false;
  settings.memory.embeddings.provider = 'disabled';
  settings.memory.dreaming.enabled = false;
  options.configureSettings?.(settings);
  runtimeSettings.saveRuntimeSettings(runtimeHome, settings);

  fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });

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
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    },
  };
}
