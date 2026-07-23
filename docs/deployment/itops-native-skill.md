# Native IT Ops Skill

## Resulting Architecture

The IT Ops Slack conversation is bound to `agent:itops`. That agent selects the
reviewed `itops` skill and receives Gantry's 39 native `itops_*` tools. The tools
call the IT Ops API directly; there is no IT Ops MCP bridge, MCP URL, or MCP
bearer token in the execution path.

```text
Slack conversation -> agent:itops -> itops skill -> native itops_* tools
                  -> IT Ops API -> IT Ops database and connectors
```

The IT Ops API remains the owner of onboarding, offboarding, approvals,
idempotency, connector execution, and business audit records. Gantry owns agent
routing, tool projection, permissions, and the native tool-call audit.

## Isolation

The native tool surface is enabled only when the selected skill display is
exactly `itops`. Gantry checks this at both tool allowlist construction and tool
registration. `ITOPS_API_BASE_URL` by itself grants no authority.

The expected access document for `agent:itops` has:

- one skill source named `itops`;
- no IT Ops MCP source;
- the canonical `browser.use` selection when Gantry Browser is required.

ATS and other agents do not receive the IT Ops tools or IT Ops API environment.

Verify the live projection:

```bash
GANTRY_HOME=/var/lib/gantry gantry agent access show itops --json
GANTRY_HOME=/var/lib/gantry gantry mcp list
```

The former IT Ops MCP catalog record may remain disabled for audit history. It
must not appear in `agent:itops` sources. Do not remove or disable the ATS MCP.

## Local Fleet Rehearsal

The fleet Compose file builds the vendored IT Ops API, starts its separate
Postgres database, waits for API health, and gives Gantry workers the internal
URL `http://itops-api:4000`.

```bash
docker compose -f ops/docker/docker-compose.fleet.yml up -d --build \
  itops-postgres itops-api
curl --fail http://127.0.0.1:4000/health
docker compose -f ops/docker/docker-compose.fleet.yml up -d --build
```

Connector defaults are safe: Google Workspace is disabled, Slack channel
operations use mock mode, and Slack workspace invites use manual mode unless
deployment secrets explicitly enable them.

## Required Configuration

Gantry runtime containers need:

```text
ITOPS_API_BASE_URL=http://itops-api:4000
ITOPS_API_TIMEOUT_MS=15000
ITOPS_API_RETRY_ATTEMPTS=2
ITOPS_API_RETRY_DELAY_MS=3000
ITOPS_API_KEY=<same optional key configured on the API>
```

The IT Ops API needs its own `ITOPS_DATABASE_URL` and
`ITOPS_MIGRATION_DATABASE_URL`. Inject connector credentials through the
deployment secret manager. Never commit Google private keys, Slack tokens,
passwords, database URLs, or API keys.

The native path does not use `ITOPS_TOOL_BRIDGE_HOST`,
`ITOPS_TOOL_BRIDGE_PORT`, `MCP_SERVER_TOKEN`, or an IT Ops MCP authorization
header.

## ECS Deployment Shape

Build and publish two immutable images from the same Gantry release:

1. the normal Gantry runtime image;
2. the IT Ops API image from `ops/docker/itops-api.Dockerfile`.

Run the IT Ops API as a private service or same-task sidecar reachable only
inside the VPC/task network. Use a separate IT Ops RDS database/schema and a
private security group. Add the API URL and optional API key to Gantry worker
containers. Health-gate rollout on `/health` and run the IT Ops migrator before
the API starts.

Deploy in this order:

1. publish the IT Ops API image and provision its database/secrets;
2. deploy and verify the API health endpoint;
3. publish Gantry with the native tools and install the `itops` skill;
4. bind the skill only to `agent:itops` and bind that agent to the IT Ops Slack
   conversation;
5. verify native reads and one approved mutation;
6. detach and disable the legacy IT Ops MCP definition.

Rollback reverses only step 6 and the Gantry image. Both transports call the
same idempotent IT Ops API, so no business-data migration is required.

## Browser Boundary

`agent:itops` may receive Gantry's canonical Browser capability. That does not
make free-form browser actions a safe replacement for the existing Slack
workspace connector. The current connector records deterministic task state,
retries, idempotency, and audit evidence inside the IT Ops API.

Retire the Playwright connector only after a Gantry Browser adapter can execute
the same invite, activate, revoke, login/MFA, retry, and completion contract and
can commit the result transactionally to the originating IT Ops task. Until
that parity exists, normal onboarding/offboarding must continue through the
native `itops_*` tools and the API-owned connector.

## Verification

Before production cutover, require all of the following:

- the native inventory contains the same 39 tool names and schemas;
- the copied client/formatter parity suites pass;
- a run with the `itops` skill can call a representative read tool;
- a run without the `itops` skill exposes zero `itops_*` tools;
- `agent:itops` has no MCP source and the legacy IT Ops MCP is disabled;
- ATS still has its original ATS skill/MCP access;
- the IT Ops API and database health checks pass;
- one approval-gated onboarding or offboarding smoke test completes against a
  non-production employee.

