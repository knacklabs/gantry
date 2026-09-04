# ASKFLOOR-1 — live runtime evidence (2026-09-02, ~/gantry/logs/gantry.log + gantry.permission_* tables, read-only)

## Headline
In `permission_mode: auto`, ordinary read-only work is routed to a HUMAN tap by the deterministic gate before any classifier runs, and the taps are never learned. The judge exists (104 `classifier_verdict` rows in `gantry.permission_decision_memory`) but is bypassed for the common case and is arg-blind for gantry-native tools.

## Numbers (last 48h, log "Permission decided")
- 975 / 976 decisions were `allow_once`; 1 `allow_persistent_rule`. Human taps teach nothing.
- 14 `RunCommand` allowed by HUMAN; 13 by reviewed_rule; **1** by `deterministic_read_only` in 48h.
- `mcp__gantry__file` (attachment read): 2 × HUMAN — classifier reason "Gantry file can mutate protected state depending on arguments; ask the user."
- Bulk auto-allows are rule-based (Browser 542, WebSearch 290, WebRead 48, todo_update 42) — not judged.

## One live run (tg:-1003986348737, 05:13–05:16Z, agent-run:dbb3a560): 10 human taps in 3 minutes, all pure reads
| command (preview) | gate reason |
|---|---|
| `ls ~/gantry/ ; echo ---; ls ~/ \| head -40` | Command target is outside the owner-declared trusted roots: /Users/ravikiranvemula |
| `ls ~/Workdir 2>/dev/null \| head -30; …` | Command target is outside the owner-declared trusted roots: **/dev/null** |
| `cd ~/Workdir/Gantry-fork 2>/dev/null && ls && git log --oneline -3` | … trusted roots: /dev/null |
| `cd … && wc -l README.md && head -120 README.md` | … trusted roots: /Users/ravikiranvemula/Workdir |
| `cd … && ls packages apps && find …` | Shell input is unsupported: Bash meta-executor find is not supported for persistent approval |
| `cd … && head -80 …/permissions/README.md` | … trusted roots |
| `cd … && grep -rn "self-approve" …` | … trusted roots |
| `cd … && ls docs && sed -n '120,300p' README.md` | … trusted roots |
No classifier/judge log line exists in that window: the refusal goes straight to ask.

## Attachment read (2026-09-01 13:10–13:16): 3 taps to read a file the owner sent
1. `mcp__gantry__file` → classifier `ask` (arg-blind) → HUMAN
2. `mcp__gantry__file` → classifier `ask` → HUMAN
3. `ls -la ~/gantry/agents/main_agent/media/attachments/ 2>/dev/null …` → parser refusal → HUMAN

## Code seams (for the fix, not fixed here)
- `apps/core/src/shared/permission-trusted-paths.ts` `outOfTrustedRootReason`: any path outside `permissions.trusted_roots` (LEARNED roots, rendered by `runtime-settings-renderer.ts:196`; parsed at `runtime-settings-permissions-parser.ts:118`) → ask. `~/Workdir` is not a learned root because every tap was allow_once.
- `apps/core/src/shared/bash-command-parser.ts`: `find` in the meta-executor list (:35) → "not supported for persistent approval" (:572) even when read-only; `2>/dev/null` special-case at :583 does not cover the observed shape (reason cites `/dev/null` as a target).
- Gantry-native tools (`mcp__gantry__file`) classified by identity, not by argument ("depending on arguments").
- Decision memory stores only `classifier_verdict` rows — human decisions are not learned (G2); allow_once is the default tap.

## What "resemble Claude Code auto mode" means concretely (maps to ASKFLOOR-1)
1. Reads are never a tap: `ls/cat/head/grep/sed -n/wc/git log/find (no -exec)` anywhere the agent can read → deterministic read-only allow, roots irrelevant (AC4 arg-aware risk before coarse buckets; fix the two parser bugs).
2. When the deterministic gate cannot decide, the CLASSIFIER decides (never "refusal ⇒ ask"); only genuine risk asks (G1).
3. Arg-aware judgment for gantry-native tools: `file(read)` is a read; `file(write)` is judged (AC4).
4. Every human decision is learned by exact effect-hash and consulted before the LLM (AC3); the default tap should be the learning one, not allow_once.
5. Classifier unavailable ⇒ fail closed with a clear reason (AC5), not silent ask.
