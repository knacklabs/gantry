import { createContext, use, type ReactNode } from 'react';
import { z } from 'zod';

import {
  LocalOwnerTransport,
  type RuntimeApiTransport,
} from './runtime-transport';

const runtimeConfigSchema = z.object({
  connectionMode: z.enum(['disabled', 'local-owner']),
  apiBase: z.literal('/ui-api/v1'),
  appId: z.string().min(1),
});

type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export type RuntimeConnection = {
  mode: RuntimeConfig['connectionMode'];
  appId: string;
  transport: RuntimeApiTransport | null;
  discoveryError?: string;
};

const disabledConnection: RuntimeConnection = {
  mode: 'disabled',
  appId: 'default',
  transport: null,
};

const RuntimeConnectionContext = createContext<RuntimeConnection | null>(null);

export async function discoverRuntimeConnection(): Promise<RuntimeConnection> {
  try {
    const response = await fetch(
      `${import.meta.env.BASE_URL}runtime-config.json`,
      {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Runtime discovery failed with status ${response.status}.`,
      );
    }
    const config = runtimeConfigSchema.parse(await response.json());
    if (config.connectionMode === 'disabled') {
      return { ...disabledConnection, appId: config.appId };
    }
    return {
      mode: 'local-owner',
      appId: config.appId,
      transport: new LocalOwnerTransport(config.apiBase),
    };
  } catch (error) {
    return {
      ...disabledConnection,
      discoveryError:
        error instanceof Error ? error.message : 'Runtime discovery failed.',
    };
  }
}

export function RuntimeConnectionProvider({
  connection,
  children,
}: {
  connection: RuntimeConnection;
  children: ReactNode;
}) {
  return (
    <RuntimeConnectionContext value={connection}>
      {children}
    </RuntimeConnectionContext>
  );
}

export function useRuntimeConnection(): RuntimeConnection {
  const connection = use(RuntimeConnectionContext);
  if (!connection) {
    throw new Error(
      'useRuntimeConnection must be used inside RuntimeConnectionProvider.',
    );
  }
  return connection;
}

export function requireRuntimeTransport(
  connection: RuntimeConnection,
): RuntimeApiTransport {
  if (!connection.transport) {
    throw new Error('The Gantry runtime is not connected.');
  }
  return connection.transport;
}
