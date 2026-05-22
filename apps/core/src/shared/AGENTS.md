## Shared Runtime Safety

- Bash parsing must treat common non-destructive file-descriptor duplication,
  such as `2>&1`, as redirect metadata instead of malformed shell syntax.
  Keep destructive output writes fail-closed, and require every pipeline leaf to
  match its own scoped rule.
- Semantic `capability:skill.*` permission rules require trusted host-projected
  selected-skill action definitions. Do not treat agent-authored tool input,
  request labels, or embedded semantic definitions as authority for skill
  actions.
- The model catalog is the only shared selectable-model source. User/API/job/MCP
  inputs must resolve friendly aliases through it; raw provider slugs are
  display/source metadata only unless explicitly registered as aliases.
