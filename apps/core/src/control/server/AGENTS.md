# Control Server

## Swagger And OpenAPI

- Keep OpenAPI documentation adapter-owned in this folder; do not make domain or application layers import documentation types.
- `/openapi.json` and `/docs` are read-only documentation surfaces. They must not expose secrets or runtime state.
- When adding, renaming, or removing control routes, update `openapi.ts` with the path, method, auth scopes, and a short behavior description in the same change.
- Document required control API scopes with the `x-gantry-required-scopes` extension so Swagger users can see which token grants are needed before trying a request.
- Model/default routes must stay provider-neutral. Inject provider credential
  preflight through `ControlRouteContext` instead of importing provider adapters
  or raw settings loaders directly from route modules.
- Model responses expose `responseFamily`, `modelRoute`, readiness, and
  capability descriptors. Keep raw provider model IDs under diagnostic
  `modelRoute.metadata`; do not reintroduce top-level provider slug fields.
- Production or non-loopback TCP control startup must require strong keyed
  `GANTRY_CONTROL_API_KEYS_JSON` records. Do not add a remote auto-accept path;
  approval shortcuts are local-development-only and must fail closed remotely.
