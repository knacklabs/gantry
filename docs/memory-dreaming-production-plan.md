# Memory + Dreaming Production Plan

Status: implemented baseline in runtime and docs on 2026-04-21.

## 1) Objective

Make continuity deterministic and production-safe:

- memory + dream context is injected by host on every run
- agent tools are optional depth, not required for baseline recall
- scope policy is explicit across Slack/Telegram/thread topics
- docs and admin skill match real runtime behavior

## 2) Runtime Injection Contract

1. For every message turn and scheduler run, host builds a continuity block.
2. Host passes the block through the runner input as `memoryContextBlock`.
3. Runner appends that block to the first prompt stream item.
4. No temp memory-context file is created on the hot path.

## 3) Continuity Block Contents

- runtime envelope (`source`, `group_folder`, `chat_jid`, `thread_id`, `user_id`)
- scope guidance:
  - `user` personal memory
  - `group` active chat/channel memory
  - `global` explicit cross-chat sharing only
  - `thread_id` enforced as a topic boundary for injected group/global memory
- memory brief:
  - session recap + open loops (latest archived session summary)
  - dream lifecycle (enabled/schedule/last run/outcome)
  - active decisions
  - facts
  - procedures

## 4) Slack + Telegram Policy

- Slack channel: default `group`; promote to `global` only for explicit org-wide intent.
- Slack DM: prefer `user` + `group`.
- Telegram group: default `group`; `global` only explicit.
- Telegram personal chat: prefer `user` + `group`; avoid `global` unless explicit.
- Telegram/Slack thread topics: save topic-specific memory with `topic_id`/`thread_id`; injected recall is filtered to that exact topic boundary.

## 5) Dreaming Lifecycle

- Dreaming remains optional via `settings.yaml memory.dreaming.enabled`.
- If enabled, scheduler runs dream sweeps on configured cron.
- Brief always shows latest lifecycle status, so agent can weight memory quality.

## 6) Memory Root Structure (runtime home)

`~/myclaw/memory/`:

- `.cache/memory.db`
- `.journal/`
- `items/`
- `procedures/`
- `sessions/`
- `dreams/`
- `daily/`
- `knowledge/`
- `.raw/`

## 7) Prompt + Skill Updates

- Shared prompt template explicitly states continuity injection is host-provided every run.
- Continuity rules now reference dream lifecycle signals.
- `myclaw-admin` skill updated with:
  - injection contract
  - scope policy
  - runtime memory folder map

## 8) Release Gates

Must pass before ship:

1. `npm run build`
2. `npm test`
3. `python3 .codex/scripts/verify.py`
4. `python3 .codex/scripts/validate_artifacts.py --allow-missing-run`
5. `python3 .codex/scripts/validate_work.py`