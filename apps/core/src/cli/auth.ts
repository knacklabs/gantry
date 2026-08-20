import * as p from '@clack/prompts';

import { acquireRuntimeStorageForRuntimeHome } from '../adapters/storage/postgres/runtime-store.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { createLocalAuthorizationUrl } from '../control/server/routes/browser-auth.js';

function usage(): string {
  return ['Usage:', '  gantry ui', '  gantry ui authorize'].join('\n');
}

export async function runUiCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command] = args;
  if (args.length > 1 || (command && command !== 'authorize')) {
    console.log(usage());
    return 1;
  }
  const settings = ensureRuntimeSettings(runtimeHome);
  if (settings.authentication.mode !== 'local') {
    if (!command) {
      console.log(
        new URL('/ui', settings.authentication.canonicalOrigin).toString(),
      );
      return 0;
    }
    p.log.error(
      'Browser authorization links are available only in local authentication mode.',
    );
    return 1;
  }
  let release: (() => Promise<void>) | undefined;
  try {
    ({ release } = await acquireRuntimeStorageForRuntimeHome(
      runtimeHome,
      settings,
    ));
    const url = await createLocalAuthorizationUrl({
      canonicalOrigin: settings.authentication.canonicalOrigin,
    });
    console.log(url);
    return 0;
  } catch {
    p.log.error(
      'The authorization link could not be created. Check Gantry storage and try again.',
    );
    return 1;
  } finally {
    await release?.().catch(() => undefined);
  }
}
