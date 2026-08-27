---
slug: channel-adapters-one-folder-per-provider
title: Channel adapters live in one folder per provider
status: confirmed
saved: 2026-08-27T08:51:46+00:00
---

# Channel adapters live in one folder per provider

## Why

`apps/core/src/channels/` has two layouts. Slack and Telegram live in `channels/slack/` and `channels/telegram/`; Discord (34 files) and Teams (22 files) were added later as flat, prefix-named files at the channels root and never moved. Nothing prescribes the layout — it is drift — and it makes every provider-side review harder than it needs to be. The owner asked on 2026-08-27 for one folder per provider "to keep sanity".

## Behaviour

Every provider adapter lives under `apps/core/src/channels/<provider>/`. Discord files move from `channels/discord-<x>.ts` to `channels/discord/<x>.ts` and Teams files from `channels/teams-<x>.ts` to `channels/teams/<x>.ts`, with the provider prefix dropped; the provider entry modules `discord.ts` and `teams.ts` become `discord/index.ts` and `teams/index.ts`. Every import is rewritten; the provider-named unit tests move under `apps/core/test/unit/channels/<provider>/`. Nothing else changes: no exported symbol is renamed, no module is split or merged, and the runtime behaves identically.

## Acceptance criteria

- `apps/core/src/channels/discord-*.ts` moved to `apps/core/src/channels/discord/*.ts` (prefix dropped); `apps/core/src/channels/teams-*.ts` moved to `apps/core/src/channels/teams/*.ts`.
- All imports rewritten; no file left at the channels root for Discord or Teams; unit tests for both providers moved under their provider folder or updated in place.
- No behaviour change: tsc, architecture budgets (paths updated), unit + Postgres integration lanes green; diff consists of renames and import-path edits only.
- Lands after PR #444 (JOBPERM-1) merges; branch rebased on main at that point.
