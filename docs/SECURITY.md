# MyClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Runtime agents | Host-executed | Agent processes run on host, so host controls are the boundary |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Host Runtime Boundary (Primary)

MyClaw currently supports host runtime execution only. The primary boundary is host-level control plus runtime scoping:
- per-group working directories
- per-group session storage
- explicit runtime-home ownership and permissions
- strict message routing and command authorization checks

There is no active container isolation boundary in the current runtime.

### 2. Mount and Path Security

**External Allowlist** - Mount permissions are stored at `~/.config/myclaw/mount-allowlist.json`, which is:
- outside project root
- not writable by runtime agents by default

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

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- groups cannot read other groups' conversation history
- session data includes prior messages and file reads
- cross-group data leakage is blocked by path separation and authorization checks

### 4. IPC Authorization

Messages and scheduler operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule job for self | ✓ | ✓ |
| Schedule job for others | ✓ | ✗ |
| View all jobs | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (OneCLI Agent Vault)

Credentials should be provided through OneCLI and runtime environment controls.

**How it works:**
1. Credentials are registered once with `onecli secrets create`
2. MyClaw routes outbound calls through configured credential paths
3. The gateway matches requests by host/path and injects credentials
4. Agents do not need raw credentials embedded in project docs or source

### Legacy naming debt (not runtime support)

The following names still exist in code/schema and are tracked for cleanup:
- `container_config`
- `containerName`
- `containerInput`
- `AdditionalMount.containerPath`

These are naming artifacts, not evidence of active container runtime support.
