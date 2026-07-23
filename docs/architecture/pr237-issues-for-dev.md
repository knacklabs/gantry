# PR #237 — review issues (handoff)

Full analysis: `pr237-arch-review.md` (file:line evidence for every claim).
Verdict: **selective** — keep 4 groups, simplify 2, reimplement 10. The three
recurring problems: (1) creating a SECOND authority for state that already has
one, (2) transition/compat shims (we are pre-user: no legacy support, fail
loud instead), (3) fixing symptoms at readers instead of the writer/root.

## Keep as-is (good work)

1. **CAS settings writes** (`13f199676`, `29863909a`) — latest-revision +
   expectedRevision CAS on grant add/remove and import. Exactly right; just
   parse only the canonical revision shape (see issue 2).
2. **Provider account in runner send_message IPC** (one hunk of `55d9adcf5`) —
   canonical identity at the producer. Keep the hunk, drop that commit's
   reader-side fallbacks (issue 9).
3. **Slack approval delivery-failure notices** — keep.
4. **Remote HTTP/SSE MCP CLI registration** — keep.

## Simplify (right idea, trim the shim)

5. **Slack question action IDs** (`dfcb2c245`) — unique indexed action_ids are
   correct. Remove the optional-suffix regex that ALSO accepts the old
   unindexed id: match `/^gantry_userq_select_\d+$/` only, delete old-id tests.
   No transition support needed.
6. **Slack mention normalization** — escaping the bot id before regex-building
   is right. But the helper strips EVERY mention anywhere and collapses all
   whitespace, mutating legitimate message content. Strip only the LEADING
   invocation mention; leave the rest of the message untouched.

## Reimplement (blocking issues)

7. **MCP capability sync service + route + CLI** (the core of the PR) — it
   copies live MCP inventory into exact `implementationBindings` on the
   selected capability: the same permission now stored TWICE (reviewed pattern
   + inventory-time exact list) with different lifecycles, and a diagnosis
   path mutates global capability state. This is the same-fact-twice family.
   INSTEAD: the selected semantic capability's reviewed PATTERN is the only
   action authority — enforce the pattern at projection/call time
   (`agent-tool-runtime-rules.ts`, `mcp-tool-proxy-capabilities.ts`); inventory
   stays inventory and may drift freely without touching authority. Delete the
   sync service/route/CLI/contracts/audit-event + their ~700 test lines.
8. **Raw third-party tool approvals via request_access** (`59ad050b2`,
   `5683461be`, `cc9a59e5a`, `3b51c8fb6`, `beccdabea`, `4a7d88c12`) — creates a
   second authorization model to bypass drift in the first; violates the
   inventory-only + reviewed-capability model. Making grants transient
   shortens the fork, it doesn't remove it. INSTEAD: with issue 7 fixed
   (pattern enforced live), newly discovered matching tools just work; a
   denial outside the pattern must name the missing reviewed capability —
   never offer raw-tool approval.
9. **14 scheduler tools as durable exact grants** (`3c92d3f50`) — the
   management surface says selection controls access, but the runner still
   mounts scheduler tools from the DEFAULT set regardless (and locked mode
   strips them even if selected): a type-system lie + two authorities.
   INSTEAD: revert; scheduler stays preset-owned. If product wants gated
   scheduling, make ONE reviewed Scheduling capability authoritative and
   derive the mounted set from it in one place — not 14 selectable rows.
10. **Recursive stored-revision key aliases** — a global recursive key-rename
    over every nesting level, silently discarding aliases when both spellings
    exist, deleting/moving fields. A transition shim + consolidation-fidelity
    loss. INSTEAD: parse EXACTLY the canonical revision schema; fail with the
    precise unsupported path. The one preserved machine gets one canonical
    revision at the planned restamp; other environments reset.
11. **Provider secret-ref repair on read** — the reader fabricates
    Slack/Discord/Teams/Telegram env refs from a hardcoded table when the
    durable revision omits them, then ordinary writes can persist the invented
    values. INSTEAD: delete the repair; fix desired state through the
    revision-first service with explicit CAS, or in the restamp. Invalid
    provider accounts fail validation loudly.
12. **Deploy workflow rewrites the ECS task definition**
    (reimplement `7a1aeeaa8`) — hardcodes an account-specific SSM ARN and
    force-edits privileged/init/security options that Terraform already owns
    (`ecs_service_set` composes secrets + those flags; the tfvars example
    already supports the extra secret). INSTEAD: configure
    `CAW_ATS_MCP_AUTHORIZATION` via the Terraform inputs; the workflow changes
    only the image.
13. **IPC route/field compatibility** (`55d9adcf5`, `0ec4dda44` minus the keep
    hunk) — three-stage preference among "stale duplicate aliases" (its own
    comment) + accepting both `targetJid` and `chatJid` at three parser sites.
    Reader-side symptom repair over data the canonical-routing cut removes.
    INSTEAD: rebase on the canonical provider-account-qualified route lookup
    (already on main + the routing branch), fail closed on ambiguity, pick ONE
    signed destination field and update writers+readers together.
14. **15-minute recovery-cursor age cap** — env-only default that advances the
    recovered cursor to now-15m, silently declaring older durable inbound
    messages processed. Data loss disguised as liveness. INSTEAD: recover from
    the durable cursor; if a retention boundary is wanted, design it as an
    explicit documented runtime setting applied at persistence/retention.
15. **Orphan Slack route seed** (`d73d978fe`) — 80-line route derivation with
    no caller, reading a settings shape the same PR's reader rejects. Delete;
    Slack setup goes through the desired-state/provider-conversation use case.
16. **Scheduled-job summary cleanup** — see full review §15; rework per the
    single-authority note there.

## Ground rules going forward (why these verdicts)

- One authority per fact. If state already has an owner (settings revisions,
  reviewed capabilities, Terraform, the canonical route projection), fix the
  owner — never add a parallel copy, repair-on-read, or reader fallback.
- No transition shims or legacy acceptance: pre-user product; fail loudly with
  a precise error; the single preserved machine is handled by the planned
  restamp.
- Fix writers/roots, not readers/symptoms.
- MCP model: install/connect = inventory only; ACTION requires a reviewed
  capability pattern enforced at call time. Nothing may grant blanket tool
  access on install.
