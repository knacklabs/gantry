# Session Resume

MyClaw has two resume paths.

## Provider-Native Resume

Provider-native resume uses `ProviderSession` metadata plus the latest matching
`ProviderSessionArtifact`.

For Claude:

1. Resolve canonical `AgentSession`.
2. Resolve active `ProviderSession` with a latest artifact id.
3. Load latest `claude-jsonl` artifact through `ProviderArtifactStore`.
4. Verify artifact hash and size.
5. Materialize the artifact into a temporary Claude config directory.
6. Run Claude with `resume`.
7. Capture updated JSONL/session index artifacts and remove the temporary
   directory.

The JSONL artifact is provider continuation state only.

## DB Replay Fallback

When provider-native resume is unavailable, MyClaw hydrates context from
canonical Postgres data such as recent messages and recent runs. Runtime memory
is retrieved separately using the current prompt as the query. Replay and memory
context are untrusted evidence only and do not grant instruction authority or
tool permission.

Missing artifact metadata uses DB replay without attempting Claude native
resume. Corrupt artifacts expire provider-native resume metadata and then use
DB replay. Artifact store infrastructure failures fail loudly because silently
losing continuation state would hide data-loss conditions.

`/new` clears provider/native session state and DB session resume state for the
chat/thread. It does not clear durable memory, approved skills, MCP bindings,
model choices, or agent configuration. The next user message starts a fresh
provider conversation and drives query-scoped memory retrieval.
