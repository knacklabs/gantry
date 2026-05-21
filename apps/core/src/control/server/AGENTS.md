# Control Server

## Swagger And OpenAPI

- Keep OpenAPI documentation adapter-owned in this folder; do not make domain or application layers import documentation types.
- `/openapi.json` and `/docs` are read-only documentation surfaces. They must not expose secrets or runtime state.
- When adding, renaming, or removing control routes, update `openapi.ts` with the path, method, auth scopes, and a short behavior description in the same change.
- Document required control API scopes with the `x-gantry-required-scopes` extension so Swagger users can see which token grants are needed before trying a request.
- External customer or partner notification integrations must stay generic in
  Gantry code, routes, tables, environment variables, tests, and docs. Keep
  customer-specific names and business operation names in the caller-owned repo
  or deployment payload/config.
