import { readEnvFile } from '../config/env/file.js';
import {
  inspectMemoryHealth,
  type MemoryHealthInspection,
} from './memory-health.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';

export type MemoryMode =
  'keyword-mode' | 'continuity-mode' | 'semantic-mode' | 'full-mode';

export interface MemoryStatusSnapshot {
  runtimeHome: string;
  health: MemoryHealthInspection;
  mode: MemoryMode;
  modeNote: string | null;
}

export function deriveMemoryMode(health: MemoryHealthInspection): {
  mode: MemoryMode;
  note: string | null;
} {
  const embeddingsOn =
    health.embeddingsEnabled && health.embeddingProvider !== 'disabled';
  const dreamingOn = health.dreamingEnabled;
  const hybridLiveNote =
    'hybrid lexical + semantic recall is live for indexed memories. Run `gantry memory embeddings backfill` to index existing memories; check `/memory-status` for live ready/pending counts';
  if (embeddingsOn && dreamingOn) {
    return {
      mode: 'full-mode',
      note: `dreaming and embeddings are on; ${hybridLiveNote}`,
    };
  }
  if (embeddingsOn) {
    return {
      mode: 'semantic-mode',
      note: `embeddings are on; ${hybridLiveNote}`,
    };
  }
  if (dreamingOn) {
    return {
      mode: 'continuity-mode',
      note: 'dreaming is on and embeddings are off - this is the default local setup; enable embeddings later for semantic consolidation',
    };
  }
  return {
    mode: 'keyword-mode',
    note: null,
  };
}

export function collectMemoryStatus(runtimeHome: string): MemoryStatusSnapshot {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const { mode, note } = deriveMemoryMode(health);

  return {
    runtimeHome,
    health,
    mode,
    modeNote: note,
  };
}

export function formatMemoryStatusExtras(
  snapshot: MemoryStatusSnapshot,
): string {
  const lines: string[] = [];
  lines.push(`Mode: ${snapshot.mode}`);
  if (snapshot.modeNote) {
    lines.push(`  note: ${snapshot.modeNote}`);
  }
  lines.push('');
  lines.push('Live Store');
  lines.push('  backend: Postgres runtime storage');
  lines.push(
    '  counts: available through runtime control events and DB observability',
  );
  lines.push('');
  lines.push('Dreaming');
  lines.push(
    '  audit: persisted in Postgres memory_dream_runs and memory_dream_decisions',
  );
  return lines.join('\n');
}
