# Web UI foundation boundary

`apps/web` builds as a Vite/React application and is served by its small Node
server at `/ui`. The server returns the application shell for client-side deep
routes and exposes only two browser-facing reads: `/ui/api/connection` and
`/ui/api/agents`.

The UI server uses `@gantry/sdk` with `GANTRY_CONTROL_API_KEY` and the existing
`GANTRY_CONTROL_BASE_URL` or `GANTRY_CONTROL_SOCKET_PATH`. These values stay in
the server process. Browser responses project only the approved connection and
agent fields; Control API transport details, authorization scopes, credentials,
and raw failures are never forwarded.

Run `npm run build:contracts && npm run build:sdk && npm run build:web`, then
`npm run serve --workspace @gantry/web`. The server listens on loopback port
4173 by default; `GANTRY_UI_PORT` may override the port. Standard runtime builds
and containers still do not include `apps/web/dist`, and this private/local
boundary does not add OIDC, roles, mutations, or a database connection.
