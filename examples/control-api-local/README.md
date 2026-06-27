# Local Control API Example

This example checks the health of a local Gantry runtime through the Node SDK.
It assumes Gantry is already running on loopback TCP.

```bash
npm ci
npm run build --workspace @gantry/sdk

export GANTRY_CONTROL_API_KEY=replace-with-a-local-dev-token
export GANTRY_CONTROL_BASE_URL=http://127.0.0.1:3939
node examples/control-api-local/index.mjs
```

Use a scoped local token from `GANTRY_CONTROL_API_KEYS_JSON`. Do not put real
Control API keys in browser code or public examples.
