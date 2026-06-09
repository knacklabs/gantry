import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveGroupFolderPath } from '../../platform/group-folder.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  isAgentCommandModule,
  type AgentCommandModule,
} from './agent-command-types.js';

/**
 * Built-in command names owned by core (see session-commands.ts). An agent
 * command may not shadow one of these; the settings parser rejects collisions.
 */
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'commands',
  'compact',
  'new',
  'stop',
  'dream',
  'memory-status',
  'digest-session',
  'extract-memory-facts',
  'models',
  'status',
  'model',
  'save-procedure',
  'thinking',
]);

const pluginCache = new Map<string, AgentCommandModule | null>();

/**
 * Dynamically load an agent's NAMED command module from
 * `<agentFolder>/commands/<name>.{ts,js}`, preferring `.ts` (dev/tsx) then
 * `.js` (prod). Structurally validated; containment-guarded; cached per
 * folder+name. Returns null (and logs) when no valid module is found.
 */
export async function loadAgentCommand(
  folder: string,
  name: string,
): Promise<AgentCommandModule | null> {
  const cacheKey = `${folder}::${name}`;
  const cached = pluginCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let commandsDir: string;
  try {
    commandsDir = path.resolve(resolveGroupFolderPath(folder), 'commands');
    // eslint-disable-next-line no-catch-all/no-catch-all -- An invalid/unsafe folder means no command.
  } catch {
    pluginCache.set(cacheKey, null);
    return null;
  }

  let loaded: AgentCommandModule | null = null;
  for (const ext of ['ts', 'js'] as const) {
    const candidate = path.resolve(commandsDir, `${name}.${ext}`);
    // Containment: never load a file resolved outside the commands folder.
    // (policy-registry also guards `candidate !== dir`; unnecessary here — a
    // candidate always has a .ts/.js suffix, so it can never equal commandsDir.)
    if (!candidate.startsWith(commandsDir + path.sep)) continue;
    if (!fs.existsSync(candidate)) continue;
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as Record<
        string,
        unknown
      >;
      const exported = mod.command ?? mod.default;
      if (isAgentCommandModule(exported)) {
        loaded = exported;
        break;
      }
      logger.warn(
        { folder, candidate },
        'Agent command export is not a valid AgentCommandModule; trying next candidate',
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- A bad command must degrade to "unavailable", not crash.
    } catch (err) {
      logger.warn(
        {
          folder,
          candidate,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to load agent command module; trying next candidate',
      );
    }
  }

  pluginCache.set(cacheKey, loaded);
  return loaded;
}
