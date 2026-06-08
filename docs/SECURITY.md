# Gantry Security Model

## Trust Model

| Entity            | Trust Level   | Rationale                                                      |
| ----------------- | ------------- | -------------------------------------------------------------- |
| Conversations     | Policy-scoped | Sender policy and control approvers govern each conversation   |
| Group channels    | Shared input  | Other users may be malicious                                   |
| Runtime agents    | Host-executed | Agent processes run on host, so host controls are the boundary |
| Incoming messages | User input    | Potential prompt injection                                     |

## Security Boundaries

### 1. Host Runtime Boundary (Primary)

Gantry currently supports host runtime execution only. The primary boundary is host-level control plus runtime scoping:

- per-group working directories
- per-group session storage
- explicit runtime-home ownership and permissions
- strict message routing and command authorization checks

### 2. Mount and Path Security

**External Allowlist** - Mount permissions are stored at `~/.config/gantry/mount-allowlist.json`, which is:

- outside project root
- not writable by runtime agents by default

In host runtime, this allowlist controls what paths are exposed to the agent runner. It is a policy boundary, not a kernel isolation boundary.

**Default Blocked Patterns:**

```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**

- symlink resolution before validation (prevents traversal attacks)
- path validation (rejects `..` and unsafe absolute rewrites)
- read-only mount defaults for conversations without explicit write capability

### 3. Session Isolation

Each group has isolated canonical session state in Postgres:

- groups cannot read other groups' conversation history
- provider transcript exports are debugging artifacts, not continuation state
- cross-group data leakage is blocked by canonical session scoping, path
  validation, and authorization checks

### 4. IPC Authorization

Messages and scheduler operations are verified against the originating agent
folder, bound conversation, selected capabilities, and that conversation's
approval policy:

| Operation                   | Authorization source                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| Send message to own chat    | Bound conversation route                                                    |
| Send message to other chats | Selected send capability plus target conversation policy                    |
| Schedule job for self       | Originating bound conversation                                              |
| Schedule job for others     | Selected scheduler capability plus target conversation approval             |
| View jobs                   | Originating agent/conversation scope unless an admin capability is approved |
| Manage conversations        | Selected admin capability plus same-conversation approver                   |

### 5. Tool And Capability Authority

Durable authority is stored as reviewed Gantry capability state, not as raw
provider harness settings. Persistent grants are limited to semantic
capabilities, canonical `Browser`, exact Gantry file/web facades, exact
selected Gantry admin MCP tools, and scoped `RunCommand(...)` rules. Provider
native names such as `Read`, `Write`, `Edit`, `WebFetch`, `Bash`, `Agent`, and
Claude SDK `allowedTools` entries are adapter projections for one run; they are
not accepted as durable Gantry authority.

The baseline Gantry MCP surface includes safe interaction, memory, continuity,
FileArtifact, capability, and MCP proxy tools. Browser access persists only as
`Browser` and projects to `browser_status`, `browser_open`,
`browser_inspect`, `browser_act`, and `browser_close`; `browser_act`
`file_attach` stages uploads through Gantry-owned policy before Playwright
sees a path. The `file` tool operates on virtual FileArtifact scopes and keeps
host filesystem paths and storage refs out of model-facing responses.

Admin tools require exact selected tool grants. `admin_permission_list` can
inventory only the current agent's persistent Gantry MCP grants, and
`admin_permission_revoke` can revoke only a current-agent grant. They do not
create new authority or expose cross-agent grant state.

`SandboxNetworkAccess` is a transient SDK defense-in-depth prompt, not a
settings capability. Local CLI capabilities must pin executable identity,
command templates, auth preflight, protected paths, denied environment
overrides, and account label before runtime projection can create scoped
command authority.

## Privilege Comparison (Host Runtime)

| Capability                          | Authorization source                                        |
| ----------------------------------- | ----------------------------------------------------------- |
| Project root access                 | Configured mounts and selected host-tool capability         |
| Group folder                        | Originating agent folder                                    |
| Common app memory access            | Capability-specific memory policy and conversation approval |
| Additional mounts                   | Mount allowlist plus selected capability                    |
| Scheduler control scope             | Job capability and originating conversation policy          |
| Session commands (`/new`, `/model`) | Sender policy and conversation control approvers            |

### 6. Credential Isolation (Gantry Model Gateway)

Credentials should be provided through Gantry credential stores and runtime
environment controls.

**How it works:**

1. Model credentials are registered once with `gantry credentials model set <provider>`
2. Gantry stores provider keys in encrypted Postgres rows
3. The gateway projects only loopback URLs and run-local `gtw_*` tokens to model SDK runs
4. Agents do not need raw credentials embedded in project docs or source

`SECRET_ENCRYPTION_KEY` must be a stable generated base64-encoded 32-byte
deployment secret so Gantry credentials survive stateless
restarts. General agent tool, script, browser, and MCP environments do not
receive `GANTRY_DATABASE_URL` or raw provider keys. Selected MCP servers and
selected reviewed skill actions receive only their named Gantry capability
credentials. Model gateway projection is limited to the model SDK credential
lane.

## Security Architecture (Host Runtime)

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED INPUT                           │
│  Incoming channel messages (prompt-injection risk)               │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                     HOST ORCHESTRATOR                            │
│  • message routing and authorization checks                      │
│  • scheduler and IPC policy enforcement                          │
│  • mount/path allowlist validation                               │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                  HOST AGENT RUNTIME PROCESS                      │
│  • per-group working dirs and session state                      │
│  • tools and file operations scoped by runtime policy            │
│  • outbound credentials via Gantry credential policy             │
└──────────────────────────────────────────────────────────────────┘
```
