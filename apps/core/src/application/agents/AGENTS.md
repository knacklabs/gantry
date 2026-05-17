# Agent Application Services

- Prompt profile defaults must keep shared behavioral guidance in generated
  runtime sections, not in `agents/shared` host-path files.
- `SOUL.md` and `CLAUDE.md` prompt profiles are protected FileArtifacts scoped
  to the agent. Seed them only when an agent is created or registered.
- Keep `CLAUDE.md` stable and agent-specific. Memory rules, continuity rules,
  capability-change rules, privacy defaults, and channel communication defaults
  belong in generated prompt guidance so every agent receives them.
