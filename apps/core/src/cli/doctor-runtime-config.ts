import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import { hasRuntimeCredentialConfigured } from './runtime-credential-check.js';

type RuntimeConfigSettings = NonNullable<
  Parameters<typeof hasRuntimeCredentialConfigured>[0]['settings']
> & {
  providers: Record<string, { enabled?: boolean } | undefined>;
};

export function hasConfiguredChannelProvider(
  settings: RuntimeConfigSettings,
): boolean {
  return listConnectableChannelProviders().some(
    (provider) => settings.providers[provider.id]?.enabled,
  );
}

export async function hasProcessableGroupForConfiguredChannelSettings(input: {
  runtimeHome: string;
  settings: RuntimeConfigSettings;
  env: Record<string, string>;
  openRuntimeGroupDb: (runtimeHome: string) => Promise<{
    countConversationRoutesByJidPrefix: (prefix: string) => Promise<number>;
    close: () => Promise<void>;
  }>;
}): Promise<boolean> {
  for (const provider of listConnectableChannelProviders()) {
    if (!input.settings.providers[provider.id]?.enabled) continue;
    const hasRequiredCredentials = provider.setup.envKeys.every((envKey) =>
      hasRuntimeCredentialConfigured({
        settings: input.settings,
        env: input.env,
        providerId: provider.id,
        envKey,
      }),
    );
    if (!hasRequiredCredentials) continue;

    let db: Awaited<ReturnType<typeof input.openRuntimeGroupDb>> | undefined;
    try {
      db = await input.openRuntimeGroupDb(input.runtimeHome);
      const count = await db.countConversationRoutesByJidPrefix(
        provider.jidPrefix,
      );
      if (count > 0) return true;
    } catch {
      continue;
    } finally {
      await db?.close();
    }
  }
  return false;
}
