import http from 'node:http';

/** Bind to 127.0.0.1 on an ephemeral port; resolve the base URL. */
export async function listenLoopback(server: http.Server): Promise<string> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture server did not bind a TCP port.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

export async function closeServer(
  server: http.Server | undefined,
): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
