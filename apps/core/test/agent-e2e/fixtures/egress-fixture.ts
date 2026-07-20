// Egress-scenario helpers: a hostname tests denylist, plus a loopback
// "allowed host" for the attribution side (networkHosts is attribution, not an
// allowlist — goal doc "Egress correction").
import http from 'node:http';

import { closeServer, listenLoopback } from './loopback-http.js';

/** Reserved .invalid TLD: guaranteed unresolvable if a denylist check fails open. */
export const DENYLISTED_EGRESS_HOST = 'denylisted.agent-e2e.invalid';

export interface AllowedHostServer {
  url: string;
  /** Request paths, in order. */
  requests: string[];
  stop(): Promise<void>;
}

export async function startAllowedHostServer(): Promise<AllowedHostServer> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '/');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  const url = await listenLoopback(server);
  return { url, requests, stop: () => closeServer(server) };
}
