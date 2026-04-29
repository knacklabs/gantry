import http from 'http';

export interface BrowserToolResponse {
  ok?: boolean;
  error?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractBrowserPort(data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  const port = data.port;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return undefined;
  }
  return port;
}

async function isCdpEndpointReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/json/version',
        timeout: 1_000,
      },
      (response) => {
        response.resume();
        resolve(
          typeof response.statusCode === 'number' &&
            response.statusCode >= 200 &&
            response.statusCode < 300,
        );
      },
    );
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => {
      resolve(false);
    });
  });
}

export async function validateBrowserCdpResponse(
  response: BrowserToolResponse,
): Promise<BrowserToolResponse> {
  if (!response.ok || !isRecord(response.data)) return response;
  if (response.data.running !== true) return response;

  const port = extractBrowserPort(response.data);
  if (!port) {
    return {
      ok: false,
      error: 'Browser reported a running session without a valid CDP port',
    };
  }

  if (await isCdpEndpointReachable(port)) return response;

  return {
    ok: false,
    error: `Browser CDP endpoint 127.0.0.1:${port} is not reachable; the browser session is stale. Retry browser_launch.`,
  };
}
