import net from 'node:net';

import { startControlServer } from '@core/control/server/index.js';

export async function reserveControlPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve test port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export async function startTestControlServer(input: {
  token: string;
  appId: string;
  scopes: string[];
  runtimeApp?: unknown;
  routeProfile?: 'full' | 'ops';
  processRole?: 'all' | 'control' | 'live-worker' | 'job-worker';
  liveExecution?: boolean;
  liveTurnsEnabled?: boolean;
}) {
  const port = await reserveControlPort();
  process.env.GANTRY_CONTROL_PORT = String(port);
  process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
    {
      kid: 'test',
      token: input.token,
      scopes: input.scopes,
      appId: input.appId,
    },
  ]);
  const handle = startControlServer({
    app:
      input.runtimeApp ??
      ({ queue: { enqueueMessageCheck: async () => undefined } } as never),
    routeProfile: input.routeProfile,
    ...(input.processRole ? { processRole: input.processRole } : {}),
    ...(input.liveExecution !== undefined
      ? { liveExecution: input.liveExecution }
      : {}),
    ...(input.liveTurnsEnabled !== undefined
      ? { liveTurnsEnabled: input.liveTurnsEnabled }
      : {}),
  });
  await waitForControlPort(port);
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    token: input.token,
    async close() {
      await handle.close();
      delete process.env.GANTRY_CONTROL_PORT;
      delete process.env.GANTRY_CONTROL_API_KEYS_JSON;
    },
  };
}

async function waitForControlPort(port: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Control server did not start on port ${port}`);
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
