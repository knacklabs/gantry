## Shared Runtime Safety

- Shared timeout helpers must preserve cancellation semantics, not just return
  early with `Promise.race`. If a helper enforces a deadline for mutating
  runtime work, it must expose an `AbortSignal` and a disposable timer so the
  owning service can stop provider calls and finalize durable state.
- Bash parsing must treat common non-destructive file-descriptor duplication,
  such as `2>&1`, as redirect metadata instead of malformed shell syntax.
  Keep destructive output writes fail-closed, and require every pipeline leaf to
  match its own scoped rule.
- Semantic `capability:skill.*` permission rules require trusted host-projected
  selected-skill action definitions. Do not treat agent-authored tool input,
  request labels, or embedded semantic definitions as authority for skill
  actions.
- Generated `.llm-runtime/claude/skills/...` paths are runner projections, not
  durable command authority. Permission UX and persistent suggestions must
  canonicalize them to selected skill action capabilities or stable
  `skills/<skill>/...` reviewed command wrappers, and persistent validation must
  reject raw generated runtime paths.
- Semantic `local_cli` protected paths are credential-read boundaries: they
  should be readable by the reviewed executable and write-protected from the
  agent/runtime sandbox. Do not model them as deny-read secrets.
- `CapabilityRuntimeAccess` is the typed internal projection contract. Add new
  capability access types there instead of passing untyped host/path/tool
  authority across runtime boundaries.
- The model catalog is the only shared selectable-model source. User/API/job/MCP
  inputs must resolve friendly aliases through it; raw provider slugs are
  display/source metadata only unless explicitly registered as aliases.
- Catalog response families are simple API-shape labels, currently `anthropic`
  and schema-only `openai`. OpenRouter belongs in `modelRoute` metadata and
  preset UX, not in `responseFamily` or raw user-facing model selectors.
- Provider-side cache support belongs in provider registry metadata and
  route-aware model helpers. Do not add local semantic response caches,
  decrypted credential caches, or response-family-derived cache assumptions.
- Shared parsers used by both config and adapters belong in `shared/`, with
  config modules re-exporting them when needed. Adapters must not import from
  `config/` just to reuse parsing behavior.
