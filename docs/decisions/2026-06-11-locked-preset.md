# 2026-06-11 — Locked Agent Preset

## Context

Internet-facing support agents must **physically not be able to escalate** their
own capabilities. They must not enumerate or invoke any `request_*`, `admin_*`,
or `settings_*` tool; they work only with capabilities pre-provisioned by an
operator. This is the third deployment shape in
[2026-06-11-deployment-modes.md](./2026-06-11-deployment-modes.md): a locked
support agent, typically run as an isolated fleet stack.

Gantry already has an Agent Access model and an authority-tool exclusion
mechanism (`excludeAuthorityTools` / `GANTRY_NO_PERMISSION_TOOLS`, see
`apps/core/src/runner/gantry-mcp-tool-surface.ts:121,157`,
`apps/core/src/runtime/agent-spawn.ts:224,542`). The decision (CEO plan adopted
revision 3, user premise P3) is to make "locked" a **reviewed preset inside that
existing model**, not a parallel authority system.

## Decision

1. **Locked is an Agent Access preset.** A new per-agent setting
   `agents.<id>.access.preset: full | locked` resolves once at config load into a
   policy object (`{ mountedToolFamilies, permissionMode, installMode }`). It
   extends the existing per-agent authority-tool exclusion; it does **not**
   introduce a separate authority store.

2. **The parent side is the security boundary.** Enforcement is **parent-side IPC
   denial**: a locked agent's runner can forge an IPC request from its workspace,
   and the parent **denies it and audits `denied_by_profile`** in the
   skill-install, admin, and settings IPC handlers. **Child-side tool unmounting
   is UX, not security** — it keeps the tools out of the agent's view, but the
   trust boundary is the parent refusing the call regardless of what the child
   sends. (Both Eng voices, CEO plan; decision #18.)

3. **Fail closed.** For a locked agent, a **corrupt or unset** authority
   environment resolves to the **empty authority set** — never a default-set
   fallback. A locked agent with a broken env can do nothing, not everything.

4. **Precedence.**
   - The **locked preset wins** over per-agent selected capabilities. A
     capability selected on a locked agent does not re-grant an authority tool the
     preset removed.
   - The **admin-tool re-add path must respect the resolved policy**
     (`apps/core/src/runner/mcp/server.ts` re-add path): an admin tool cannot
     re-mount an authority tool onto a locked agent.

5. **Isolation tiers (with cost).** A locked support deployment chooses one:
   - **Isolated stack per support deployment (default):** its own fleet stack via
     `terraform apply -var-file=support.tfvars` (ADR-5). Strongest blast-radius
     isolation; one infrastructure footprint per support deployment.
   - **Co-tenant in an existing fleet (documented, cheaper):** the locked agent
     runs inside an existing fleet stack. Lower cost, **weaker blast-radius
     isolation** — a compromise of shared infrastructure is shared. Documented as
     a deliberate tradeoff, not the default.

## Alternatives Considered

- **Parallel authority system for support agents** (a second grant model that
  locked agents use): rejected (user/CEO revision 3). It doubles the security
  surface and the audit surface; the existing Agent Access model already has the
  exclusion primitive.
- **Child-side unmounting as the security boundary**: rejected. A compromised or
  adversarial runner controls its own process; only the parent can be the trust
  boundary. Unmounting remains, but as UX.
- **Default-set fallback when locked env is missing**: rejected — that is
  fail-open. Locked must fail closed to the empty set.
- **Always isolate (no co-tenant option)**: not chosen as the only option;
  co-tenant is documented for cost-sensitive deployments that accept weaker
  isolation, with the isolated stack remaining the default.

## Consequences

- A locked agent cannot enumerate or invoke any `request_*`/`admin_*`/`settings_*`
  tool; pre-provisioned skills/MCP/capabilities still work.
- Forged IPC from a locked runner is denied **and** audited (`denied_by_profile`),
  giving operators a visible signal of attempted escalation.
- The preset composes with deployment mode: a locked support agent is normally a
  `fleet` stack with production security posture
  ([2026-06-11-deployment-modes.md](./2026-06-11-deployment-modes.md)).
- Operators choose the isolation/cost tradeoff per support deployment; the
  default `support.tfvars` path gives the strong-isolation stack (ADR-5).

## Rollback Or Migration Notes

- `access.preset` defaults to `full`, so existing agents are unaffected; locking
  is opt-in per agent.
- Unlocking is setting `preset: full`; there is no destructive state to migrate.
- Co-tenant vs isolated is an infrastructure choice (ADR-5), reversible by
  re-applying Terraform against the chosen var-file.

## Operator-Authored Profile Content

- Host-authored instruction blocks (runtime rules, persona, capability and
  operating guidance, runner tool descriptions, and the seeded default
  `AGENTS.md`) are projections of the resolved access policy and follow the
  preset automatically.
- `SOUL.md` and `AGENTS.md` are operator-owned content. The runtime never
  rewrites or string-strips them; a `full` to `locked` flip keeps them
  verbatim. The `gantry agent access preset <agent> locked` verb prints the
  profile file paths and instructs the operator to review them for
  capability/approval-flow guidance at flip time, with
  `gantry agent profile set <agent> agents` as the replacement path.

## See Also

- [2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md)
- [2026-06-11 — Delivery Vehicle](./2026-06-11-delivery-vehicle.md)
- [deployment-profiles.md](../architecture/deployment-profiles.md)
