# MyClaw Security Model

## Trust Model

| Entity            | Trust Level   | Rationale                                                      |
| ----------------- | ------------- | -------------------------------------------------------------- |
| Main group        | Trusted       | Private self-chat, admin control                               |
| Non-main groups   | Untrusted     | Other users may be malicious                                   |
| Runtime agents    | Host-executed | Agent processes run on host, so host controls are the boundary |
| Incoming messages | User input    | Potential prompt injection                                     |

## Security Boundaries

### 1. Host Runtime Boundary (Primary)

MyClaw currently supports host runtime execution only. The primary boundary is host-level control plus runtime scoping:

- per-group working directories
- per-group session storage
- explicit runtime-home ownership and permissions
- strict message routing and command authorization checks

### 2. Mount and Path Security

**External Allowlist** - Mount permissions are stored at `~/.config/myclaw/mount-allowlist.json`, which is:

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
- `nonMainReadOnly` option to keep non-main mounts read-only

### 3. Session Isolation

Each group has isolated canonical session state in Postgres:

- groups cannot read other groups' conversation history
- provider transcript exports are debugging artifacts, not continuation state
- cross-group data leakage is blocked by canonical session scoping, path
  validation, and authorization checks

### 4. IPC Authorization

Messages and scheduler operations are verified against group identity:

| Operation                   | Main Group | Non-Main Group |
| --------------------------- | ---------- | -------------- |
| Send message to own chat    | ✓          | ✓              |
| Send message to other chats | ✓          | ✗              |
| Schedule job for self       | ✓          | ✓              |
| Schedule job for others     | ✓          | ✗              |
| View all jobs               | ✓          | Own only       |
| Manage other groups         | ✓          | ✗              |

## Privilege Comparison (Host Runtime)

| Capability                          | Main Group                   | Non-Main Group                       |
| ----------------------------------- | ---------------------------- | ------------------------------------ |
| Project root access                 | Allowed by configured mounts | Not granted by default               |
| Group folder                        | Own group (rw)               | Own group (rw)                       |
| Common app memory access            | Admin/service write          | Read-only by host policy             |
| Additional mounts                   | Configurable by admin policy | Read-only unless policy allows write |
| Scheduler control scope             | All groups                   | Own group only                       |
| Session commands (`/new`, `/model`) | Allowed                      | Admin/trusted sender only            |

### 5. Credential Isolation (OneCLI Agent Vault)

Credentials should be provided through OneCLI and runtime environment controls.

**How it works:**

1. Credentials are registered once with `onecli secrets create`
2. MyClaw routes outbound calls through configured credential paths
3. The gateway matches requests by host/path and injects credentials
4. Agents do not need raw credentials embedded in project docs or source

MyClaw and OneCLI may share one Postgres database, but they must not share
tables or database roles. MyClaw owns the `myclaw` schema, OneCLI owns the
`onecli` schema, and pg-boss owns the `pgboss` schema.
`ONECLI_DATABASE_URL` must use a different Postgres user than
`MYCLAW_DATABASE_URL` and must include `schema=onecli`.
`SECRET_ENCRYPTION_KEY` must be a stable generated base64-encoded 32-byte deployment
secret so broker state survives stateless restarts. Agent runners do not receive
`MYCLAW_DATABASE_URL`, `ONECLI_DATABASE_URL`, raw provider keys, broker-provided
proxy variables, or broker-provided CA certificate variables.

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
│  • outbound credentials via OneCLI/environment policy            │
└──────────────────────────────────────────────────────────────────┘
```
