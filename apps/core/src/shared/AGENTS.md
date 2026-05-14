## Shared Runtime Safety

- Bash parsing must treat common non-destructive file-descriptor duplication,
  such as `2>&1`, as redirect metadata instead of malformed shell syntax.
  Keep destructive output writes fail-closed, and require every pipeline leaf to
  match its own scoped rule.
