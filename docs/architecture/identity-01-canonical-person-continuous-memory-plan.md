# IDENTITY-01 — Canonical Person and Continuous Memory

> **Status:** Approved for implementation
> **PR:** #217
> **Verified comparison:** `2cdfefb5f4eb32f09f7458d09c93896c5e3d7983..3276bd953f460859653380d973a1494890c4857b` (126 files)
> **Execution branch:** `feature/pr-217-identity-fixes`
> **Publication target:** existing fork PR head `feature/phase-2-3-identity-management-final`

<proposed_plan>

## Title

Canonical Person and continuous app-scoped, agent-scoped memory.

## Summary

Gantry owns one small provider-neutral identity core:

- A `Person` belongs to exactly one `appId`.
- An alias is exactly `(appId, kind, authorityId, subject)`.
- V1 alias kinds are only `provider_user` and `application_user`.
- Personal memory is keyed only by `(appId, agentId, personId)`.
- Linked aliases share memory only in the same app and for the same agent.
- Provider DMs and authenticated SDK private sessions may resolve or create a
  Person.
- Groups, channels, anonymous sessions, and system sessions never create a
  Person and never hydrate personal memory.
- Customer applications keep their own authentication. Gantry authenticates
  the customer backend with an app-scoped service credential.
- Cross-provider linking is explicit through `people:admin`. Gantry never
  guesses from names, email, or phone.

This is not a separate authentication service. OIDC, verified email/phone
aliases, an external memory MCP server, and Person deletion are separate
future slices and receive no V1 scaffolding.

## Exact UX Contract

### Backend SDK session

```ts
type AppUserAssertion = {
  authorityId: string;
  subject: string;
  displayName?: string;
};

type EnsureSessionInput =
  | {
      conversationKind: "private";
      conversationId: string;
      appUser?: AppUserAssertion;
    }
  | {
      conversationKind: "channel";
      conversationId: string;
      appUser?: never;
    };
```

Rules:

1. `conversationKind` is required; there is no default.
2. Private with `appUser` resolves or creates an `application_user` alias.
3. Private without `appUser` is anonymous and conversation-scoped.
4. Channel with `appUser` is rejected before persistence.
5. The normalized assertion is immutable after session creation.
6. Re-ensuring with the same assertion is idempotent.
7. Re-ensuring with a different assertion returns `409 CONFLICT`:
   `Session is already bound to a different application user. Create a new session.`
8. `senderId`, `senderName`, email, phone, and display name are metadata
   only.
9. Normal session/message requests reject `personId`, legacy `userId`, and
   message-level `appUser`.
10. Gantry may return the resolved `personId` as read-only metadata.

External `private` maps to Gantry's internal private/DM kind. The public SDK
does not expose provider-specific `dm` vocabulary.

### Provider conversations

- Trusted DM:
  `kind=provider_user`,
  `authorityId=<provider connection id>`,
  `subject=<stable provider user id>`.
- Group/channel senders may be stored as metadata with a nullable Person
  reference, but identity is never resolved or created.
- Anonymous, bot, system, and untrusted senders never receive personal
  identity or memory.

### Authority lanes

| Operation | Required scope |
| --- | --- |
| Ensure/send SDK session | `sessions:write` |
| List/get People | `people:read` |
| Resolve existing alias | `identity:resolve` |
| Repair-time resolve/create | `identity:resolve` + `people:admin` |
| Link/retire alias | `people:admin` |
| Preview/apply merge | `people:admin` |
| Read/search by `personId` | `memory:read` |
| Save/patch/delete/repair memory | `memory:admin` |

All operations are restricted to the authenticated credential's `appId`.
Public memory contracts use `personId` only.

### Merge

1. Preview returns a deterministic fingerprint over merge-affecting state.
2. Apply requires `sourcePersonId`, `fingerprint`, and `idempotencyKey`.
3. Changed source, target, aliases, or memory returns `409 CONFLICT`:
   `Merge preview is stale. Run preview again.`
4. Alias collisions always block.
5. Memory conflicts fail by default.
6. `keep_target` is the only V1 override.
7. Conflicting source memory becomes superseded and unreadable, not deleted.
8. Replaying the idempotency key creates no duplicate state, audit, event, or
   outbox row.

## Architecture Ownership

- **Domain:** Person, alias, exact alias key, merge policy/fingerprint, and
  repository ports.
- **Application:** create, resolve-only, and conversation-only policy;
  session assertion immutability; People/memory use cases.
- **Adapters:** provider/SDK evidence normalization and Postgres persistence.
- **Runtime:** trusted app, agent, conversation kind, and resolved Person
  context; never identity inference.

Use one identity-owned append-only audit model for create, link, retire, and
merge. Because these migrations are unmerged, replace the merge-only audit
shape rather than creating compatibility tables. Identity state, identity
audit, runtime event, and event-bus outbox commit in one transaction. Runtime
events are observable delivery evidence, not the sole audit source.

## Implementation Sequence

### 1. Quarantine PR scope

- Use only the verified base/head above; never fork `origin/main`.
- Remove verified unrelated model-gateway audit extraction, generic startup
  diagnostics, remote-MCP error wrapping, redundant memory-IPC authority
  filtering, unrelated Slack diagnostics/docs, dreaming verification notes,
  and MWORKER-adjacent expectation edits.
- Keep Slack sender/route normalization that gates identity ingress.
- Fix the runner fixture by copying `apps/core/src/shared/runtime-env-command.ts` beside
  `neutral-ca-trust-env.ts`.
- Preserve unrelated dirt in the main checkout and leave MWORKER untouched.

### 2. Replace identity domain and persistence

- Move Person, alias, merge policy, and repository types into domain ownership.
- Replace provider-shaped alias fields with `kind`, `authorityId`,
  `subject`.
- Remove V1 `email`, `phone`, and `web_user` evidence kinds.
- Enforce active uniqueness on `(appId, kind, authorityId, subject)`.
- Use transaction/advisory locking for concurrent resolve/create.
- Make retired aliases fail closed.
- Add same-app composite keys/FKs for People, aliases, participants, merge
  source/target, and personal memory.
- Replace lossy participant ids with an exact tuple or collision-resistant
  digest.
- Message persistence accepts an optional already-resolved `personId`; it
  never derives identity from sender metadata.
- Fail migration on duplicate active aliases and ambiguous/cross-app data.
- Fold the unmerged identity migrations into the smallest clean sequence and
  remove obsolete patch migrations.

### 3. Finish merge semantics

- Fingerprint canonical sorted source/target status, active alias keys and
  versions, and personal-memory ids/agentIds/kind/key/status/version.
- Recompute under Person locks before writes.
- Rekey source conversation participants to the target.
- Move aliases and non-conflicting memory.
- With `keep_target`, supersede conflicting source memory.
- Archive the source.
- Write identity audit, runtime event, and outbox atomically.

### 4. Add immutable SDK session identity

- Update shared contracts, strict route validation, OpenAPI, generated SDK,
  SDK client, session record, and tests together.
- Persist conversation kind, normalized assertion, and optional resolved
  Person binding.
- Resolve/create only for private sessions with `appUser`.
- Reject channel assertions and caller-selected Person authority.
- Do not infer legacy session users from historical message senders.

### 5. Enforce private-only runtime identity

- Gate every `createIfMissing` call before identity resolution.
- Pass real `appId`, provider connection authority, subject, and explicit
  conversation kind into persistence.
- Provider DMs use create policy.
- Group/channel/anonymous/system paths use conversation-only policy.
- Hydrate personal memory only for trusted private sessions with a Person.

### 6. Carry app-agent-person through memory IPC

- Require and sign trusted `appId` and `agentId`.
- Bind both into HMAC input, validation, parsing, replay key, and host context.
- Reject missing or mismatched values.
- Remove `DEFAULT_MEMORY_APP_ID` and in-process default-app fallbacks.
- Remove public/admin/SDK legacy `userId` memory authority.

### 7. Finish contracts and docs

- Keep list/get under `people:read`.
- Require `people:admin` for link, retire, preview, and merge.
- Require app-bound memory scopes for direct `personId` operations.
- Update SDK examples, identity architecture, threat model, and nearest
  relevant `AGENTS.md`.
- Document only shipped behavior and mark roadmap slices deferred.

### 8. Verify and publish

- Keep one PR with bounded commits:
  1. scope quarantine and fixture,
  2. identity domain/persistence,
  3. SDK/runtime/memory,
  4. public contracts/docs,
  5. verification fixes.
- Run `autoreview`, fix all blocking in-scope findings, and rerun.
- Push final HEAD to the existing fork PR head
  `feature/phase-2-3-identity-management-final`.

## Parallel Agent Decomposition

| Wave | Agent | Exclusive ownership |
| --- | --- | --- |
| 1A | Scope quarantine | Verified unrelated hunks only |
| 1B | Fixture | `agent-runner-ipc.test.ts` only |
| 2 | Identity domain | Domain identity types/ports, application identity service, People contracts |
| 3 | Identity persistence | Identity repositories, canonical participant/message persistence, schema/migrations, atomic event append |
| 4 | SDK session | Session contracts/service/persistence/routes/OpenAPI/generated SDK |
| 5A | Private runtime | Provider normalization and group-processing identity gates |
| 5B | Memory boundary | Memory IPC auth/parse/trust and public `personId` memory contracts |
| 6A | Docs | Architecture, threat model, SDK docs, nearest `AGENTS.md` |
| 6B | Security review | Spoofing, cross-app access, collisions, stale merge, replay, rollback |
| 6C | Surface review | No-legacy cleanup and Surface Impact Matrix verification |
| 7 | Closeout | Full gates, autoreview, bounded commits, push |

Workers run in parallel only when write sets are disjoint. Contract-owning
waves are serialized.

## Acceptance Criteria

- Unknown group/channel identity creates no Person/alias and loads no personal
  memory.
- First authenticated provider DM or private SDK user creates exactly one
  Person in the correct app.
- Private SDK without `appUser` remains conversation-scoped.
- Linked Slack, Telegram, and SDK aliases share memory only for the same agent.
- Different apps and different agents cannot read each other's memory.
- Retired aliases fail closed.
- Forged `personId`, public `userId`, email, phone, display name, or
  message-level assertion cannot become authority.
- Changed session assertion conflicts without mutation.
- Cross-app FKs, concurrent alias linking, collisions, stale previews,
  idempotent retry, and rollback are covered in disposable Postgres.
- Audit/event failure leaves no successful identity mutation.
- Clean-cut searches find no default memory app, channel-side creation, public
  legacy memory authority, or normal SDK Person selector.

## Test Plan

Focused checks cover domain policy, DM versus channel behavior, strict SDK
validation, assertion immutability, memory IPC signing, API scopes, OpenAPI,
generated SDK, runtime events, and the runner fixture.

Disposable Postgres checks cover exact alias uniqueness, concurrency,
same-app FKs, session persistence/conflict, stale merge, alias/memory
conflicts, participant rekey, idempotency, rollback, and migration failures.

Final commands:

```bash
npm run format:check
npm run typecheck
npm run build
npm run test:unit
GANTRY_TEST_DATABASE_URL=<disposable-url> npm run test:integration:postgres
npm run check:generated --workspace @gantry/sdk
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/check_task_completion.py
```

Run final stale-reference searches, then `autoreview`; fix blocking findings
and rerun until clean.

## Surface Impact Matrix

| Surface | Classification | Decision |
| --- | --- | --- |
| Runtime behavior | Changed | Private authenticated identity may use personal memory; channel/group/anonymous/system may not. |
| `settings.yaml` | Unchanged by design | Identity is authenticated ingress/session state, not desired state. |
| Postgres/runtime projection | Changed | App-scoped People, exact aliases, immutable session identity, app-agent-person memory, merge state, audit, event, outbox. |
| Control API | Changed | Normal session and People/memory admin are separate authority lanes. |
| SDK/contracts | Changed | Required kind, optional private assertion, no trusted `personId`/`userId`. |
| CLI | Unchanged by design | No V1 CLI identity mutation authority. |
| Gantry MCP tools/admin skill | Deferred | External memory MCP is a later slice; only internal trusted memory scope changes now. |
| Channel/provider adapters | Changed | Trusted DM create versus conversation-only group/channel behavior. |
| Docs/prompts | Changed | Auth boundary, authority lanes, memory, merge, and roadmap. |
| Audit/events | Changed | Atomic identity audit plus runtime event/outbox. |
| Tests/verification | Changed | Unit, contract, Postgres, runtime, security, cleanup, generated-code, autoreview. |

## Locked Decisions

1. One app owns each Person.
2. Personal memory is app + agent + Person scoped.
3. V1 aliases are only provider user and application user.
4. Display data is never identity authority.
5. Only trusted private ingress may create a Person.
6. Customer SDK authentication stays customer-owned.
7. Session identity is immutable.
8. Normal SDK callers never select a Person.
9. Linking is explicit; Gantry never guesses.
10. Retired/ambiguous legacy identity fails closed.
11. Merge requires a current fingerprint and idempotency key.
12. `keep_target` is the only V1 conflict override.
13. Identity state, audit, event, and outbox are atomic.
14. No compatibility, dual-read, inferred backfill, or default-app path.
15. OIDC, email/phone proof, external MCP, and deletion remain deferred.
16. Keep one PR with bounded commits and push the existing fork PR head.

## Deferred Roadmap

- Management UI: bring-your-own OIDC plus Gantry app membership/roles.
- Email/phone: verified claim or possession OTP; no admin proof bypass.
- External memory MCP: read/search/write only, OAuth client credentials,
  audience-bound tokens, provenance, idempotency; no static keys or
  link/merge/delete/list-all.
- Person deletion: remove memory and aliases while retaining irreversibly
  redacted minimal audit.

</proposed_plan>

---

# IDENTITY-02 — Canonical Agent Identity (extension)

> **Reconciled 2026-08-26 (decision 0138):** the confirmed spec
> `person-identity-aliases` already makes agents `kind: service` Persons. Read
> every "Agent principal" below as *the service-kind Person bound to `agentId`*,
> `PrincipalRef.kind` as `human | service | system`, and `principalId` as
> `personId`. There is no separate agent principal table. The binding contract
> is `docs/specs/agent-identity-and-offboarding.md`; where this section and the
> spec differ, the spec wins.

> **Status:** Proposed — extends IDENTITY-01; does not reopen its locked decisions.
> **Positioning it serves:** "Onboard AI employees like real ones" — one directory
> shape for people and agents, so onboarding, access, audit, and offboarding
> read the same for both.
> **Prerequisite:** IDENTITY-01 merged (PR #373). **Note (2026-08-26 gap
> sweep):** what shipped is `users` + `user_aliases(provider,
> providerAccountId, externalUserId)`, not the `(appId, kind, authorityId,
> subject)` alias documented above; IDENT-2 therefore starts with a schema
> migration. See `docs/architecture/ai-employee-v1-gap-analysis.md`.

## Summary

Agents become principals in the same identity core as People. Nothing new is
invented; existing pieces are given the identity shape People already have.

- A `Principal` is `Person | Agent`. Both belong to exactly one `appId`.
- An agent's canonical identity **is** the existing Agent record (`agentId`).
  There is no second agent table.
- An agent alias is the existing Provider Account, projected into the exact
  alias key: `(appId, kind, authorityId, subject)` with
  `kind = provider_account` (`subject = external_identity_ref` stable id, e.g.
  Slack `bot_user_id`) or `kind = application_agent` (the `virtual: true`
  app account).
- One alias table, one uniqueness rule across kinds: a `(appId, authorityId,
  subject)` belongs to at most one principal of any kind. A subject can never
  be both a Person and an Agent. Kind is stored, not inferred.
- Audit actors become principals: `{ kind: 'person' | 'agent' | 'system',
  principalId?, aliasId? }`. The bare `actor: 'agent'` string is removed.
- Permissions do not move. Capability grants, `tool_rules`, and access presets
  stay keyed by `agentId` — which is now also the principal id.
- Agent memory stays keyed by `agentId`; personal memory stays
  `(appId, agentId, personId)`. No memory model change.
- Offboarding is one command and one atomic transaction.

Directory federation (SCIM / Entra Agent ID / Okta), agent-to-agent
conversation, and per-agent OIDC are deferred and receive no V1 scaffolding.

Grill outcomes (2026-08-26) folded in below: one app per org for chat
channels; approvers are principals; person offboarding is in V1.0; offboarding
is administrator-only; in-runtime delegation is not agent-to-agent.

## Exact Contract

### Principal

```ts
type PrincipalRef =
  | { kind: 'person'; principalId: string }   // personId
  | { kind: 'agent';  principalId: string }   // agentId
  | { kind: 'system' };

type AliasKind =
  | 'provider_user'      // IDENTITY-01, person
  | 'application_user'   // IDENTITY-01, person
  | 'provider_account'   // agent: native bot/app identity on a provider
  | 'application_agent'; // agent: virtual app-channel identity
```

Rules:

1. `provider_account` and `application_agent` aliases resolve only to agents;
   `provider_user` and `application_user` only to People. Cross-kind
   resolution fails closed.
2. Connecting a Provider Account creates or updates its alias in the same
   transaction as the account. Disconnecting retires the alias. Retired
   aliases fail closed (IDENTITY-01 rule reused).
3. An inbound sender whose `(authorityId, subject)` matches an agent alias is
   an **agent sender**: metadata-only, never creates a Person, never hydrates
   personal memory, and in V1 never triggers a run (see Locked Decisions).
4. Public contracts expose `PrincipalRef`, never raw provider ids, as actor.
5. **App = org.** In a central install every chat-channel Person and Agent
   lives in one org `appId`, so one human has one identity across Teams,
   Slack, and WhatsApp. SDK-embedded customer products are separate apps
   with their own People. Departments are never separate apps.
6. **Approvers are principals.** `conversations.<id>.control_approvers`
   migrate from raw provider sender ids to `PrincipalRef`; migration fails on
   an unresolvable id. The per-conversation model is unchanged: channel
   approvers approve in channels; in a DM the Person self-approves.
7. **Delegation is not agent-to-agent.** An agent spawning worker runs inside
   the host runtime is one principal's run tree and is audited under that
   agent's `PrincipalRef`. Only one principal addressing another over a
   channel counts as agent-to-agent, which stays off in V1.

### Audit actor

Every identity, permission, session, job, and tool-call audit row carries
`actor: PrincipalRef` and, when the action came through a channel,
`aliasId`. A human row and an agent row have the same shape:

```
person  p_9f3…  via alias slack:T01/U7A…   approved tool jira.create   conv C4…
agent   ops     via alias slack:T01/UOPS…  invoked  tool jira.create   conv C4…
```

### Offboard

```
gantry agent offboard <agentId> [--keep-secrets]
```

One transaction, in order:

1. Retire every alias of the agent (fail closed from now on).
2. Remove every Conversation Install of the agent's Provider Accounts.
3. Mark Provider Accounts `disabled`; secrets are **not** deleted (they are
   references to the secret provider); `--keep-secrets` is the default and the
   only V1 behavior — the flag exists to make the choice visible.
4. Cancel the agent's scheduled jobs; in-flight runs are allowed to finish but
   may not start new tool calls.
5. Set agent status `offboarded`. Config, memory, and audit stay readable
   under `people:admin`-equivalent authority (`agents:admin`).
6. Write one identity audit row, runtime event, and outbox entry atomically
   (IDENTITY-01 atomicity rule).

`gantry agent remove` is unchanged: it deletes config and is only permitted
on an already-offboarded agent. The `main_agent` cannot be offboarded
(existing constraint). Re-onboarding is a new agent id; retired aliases are
never revived. Offboarding requires the administrator role; an agent's owner
(RBAC-1) may pause and resume but not offboard.

### Person offboard (V1.0)

```
gantry person offboard <personId>
```

Mirrors agent offboarding so the symmetry claim holds both ways. One
transaction: retire every alias (fail closed), redact personal memory and DM
content irreversibly, keep alias keys and audit rows in redacted form, write
one identity audit row, runtime event, and outbox entry. Manual trigger from
CLI or the directory; IdP/SCIM-driven deprovisioning is deferred. This
replaces the IDENTITY-01 "Person deletion" roadmap item for V1.0.

### Authority lanes (additions)

| Operation | Required scope |
| --- | --- |
| List/get agents as principals | `agents:read` |
| Connect/disconnect Provider Account (alias create/retire) | `agents:admin` |
| Offboard agent | `agents:admin` |
| Read offboarded agent memory/audit | `agents:admin` + `memory:read` |

No new scope grants tool authority. `people:admin` never touches agent
aliases and vice versa.

## Architecture Ownership

- **Domain:** `PrincipalRef`, alias kinds, cross-kind uniqueness, offboard
  policy.
- **Application:** Provider Account ⇄ alias projection, offboard use case,
  agent-sender classification.
- **Adapters:** provider `external_identity_ref` normalization to alias
  subject; Postgres persistence.
- **Runtime:** inbound sender → `PrincipalRef` resolution before any run;
  audit actor stamping.

## Implementation Sequence

1. **Alias kinds + uniqueness.** Add `provider_account` / `application_agent`
   kinds and `principalKind` to the alias table; enforce one-principal-per-
   subject across kinds; migration fails on collisions.
2. **Provider Account projection.** Create/retire alias inside the account
   connect/disconnect transaction; backfill is a fail-on-ambiguity migration,
   not a runtime fallback.
3. **Agent-sender gate.** Classify inbound senders against agent aliases
   before Person resolution; agent senders are metadata-only and dropped from
   run triggering.
4. **Audit actor.** Replace every bare `actor: 'agent'` / `actorId: 'agent'`
   with `PrincipalRef`; update contracts, OpenAPI, generated SDK together.
5. **Offboard command + API.** CLI and control-API endpoint, atomic per the
   contract; `agent remove` gated on `offboarded`.
6. **Docs.** This doc, threat model (agent impersonation, cross-kind
   collision), `multi-agent-provider-configuration.md`, nearest `AGENTS.md`.

## Acceptance Criteria

- Connecting a Slack Provider Account for agent `ops` yields exactly one
  active `provider_account` alias; disconnecting retires it.
- A Slack user id that is already an agent alias cannot become a
  `provider_user` alias, and vice versa; both attempts fail with a collision
  error and no mutation.
- A message from an agent alias in a channel creates no Person, loads no
  personal memory, and starts no run.
- Every audit row written during a channel-triggered tool call carries
  `actor.kind = 'agent'`, `actor.principalId = <agentId>`, and the alias id.
  Searching audit for the bare string `'agent'` as actor finds nothing.
- `gantry agent offboard ops` leaves zero active aliases, zero installs, all
  Provider Accounts disabled, jobs cancelled, status `offboarded`, secrets
  untouched, one audit row — or nothing at all on any failure.
- `gantry agent remove ops` is refused until offboarded.
- Offboarded agent memory and audit remain readable under `agents:admin`.

## Surface Impact Matrix (additions)

| Surface | Classification | Decision |
| --- | --- | --- |
| Runtime behavior | Changed | Agent senders classified before Person resolution; never trigger runs in V1. |
| `settings.yaml` | Unchanged by design | Provider Accounts already live there; alias is a derived projection. |
| Postgres | Changed | Alias kinds, `principalKind`, cross-kind uniqueness, agent status. |
| Control API / SDK | Changed | `PrincipalRef` actor in audit/events; offboard endpoint; `agents:*` scopes. |
| CLI | Changed | `gantry agent offboard`; `agent remove` gated. |
| Audit/events | Changed | Uniform actor shape for people and agents. |

## Locked Decisions

1. Agents are principals in the same core as People; no parallel identity
   system, no second RBAC.
2. Agent canonical id is the existing `agentId`; Provider Accounts are its
   aliases.
3. A subject belongs to at most one principal of any kind; kind is stored and
   unforgeable.
4. Authority stays on `agentId`; identity adds no tool permissions.
5. Agent-to-agent conversation is **off** in V1. Agent senders never trigger
   runs. Enabling it is a separate decision with its own loop/abuse controls.
6. Offboarding is atomic, retires rather than deletes, and never touches the
   secret provider.
7. Retired agent aliases are never revived; re-onboarding is a new agent.
8. `main_agent` cannot be offboarded.
9. One app per org for chat channels; SDK products are separate apps.
10. Approvers are `PrincipalRef`s; the per-conversation approval model stays.
11. Person offboarding ships in V1.0 with irreversible redaction.
12. Offboarding (agent or person) is administrator-only.

## Deferred

- **Directory federation:** map agent principals to Entra Agent ID / SCIM /
  Okta (alias kind `directory_agent`). Shape only; no scaffolding.
- **Agent-to-agent addressing** with explicit allow-lists and loop budgets.
- **Per-agent OIDC** for agents calling external systems as themselves.
- **Agent deletion with redacted audit**, mirroring Person deletion.
