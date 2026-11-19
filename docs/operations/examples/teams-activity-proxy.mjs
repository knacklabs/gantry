import http from 'node:http';

// Development helper: expose one authenticated bot endpoint, keeping the UI private.
const [activityPath, gantryPortText, listenPortText = '3942'] =
  process.argv.slice(2);
const gantryPort = Number(gantryPortText);
const listenPort = Number(listenPortText);
const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;
if (
  !/^\/v1\/providers\/teams\/[A-Za-z0-9._~%:-]+\/activities$/.test(
    activityPath ?? '',
  ) ||
  !validPort(gantryPort) ||
  !validPort(listenPort) ||
  gantryPort === listenPort
) {
  console.error(
    'Usage: node teams-activity-proxy.mjs /v1/providers/teams/ACCOUNT/activities GANTRY_PORT [PROXY_PORT]',
  );
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== activityPath) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    if (response.writableEnded) return;
    bytes += chunk.length;
    if (bytes > 256 * 1024) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('error', () => {
    if (!response.writableEnded) response.destroy();
  });
  request.on('end', () => {
    if (response.writableEnded) return;
    const body = Buffer.concat(chunks);
    const headers = {
      ...request.headers,
      host: `127.0.0.1:${gantryPort}`,
      'content-length': String(body.length),
    };
    delete headers['transfer-encoding'];
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: gantryPort,
        path: activityPath,
        method: 'POST',
        headers,
        timeout: 30000,
      },
      (reply) => {
        console.log(`Bot endpoint returned ${reply.statusCode ?? 502}.`);
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    upstream.on('timeout', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    upstream.end(body);
  });
});
server.listen(listenPort, '127.0.0.1', () => {
  console.log(`Bot-only proxy ready at http://127.0.0.1:${listenPort}.`);
  console.log(
    'Only the configured POST activity endpoint is forwarded; other paths return 404.',
  );
});
