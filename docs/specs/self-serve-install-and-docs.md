---
slug: self-serve-install-and-docs
title: Self-serve install and lifecycle documentation
status: confirmed
saved: 2026-08-26T11:07:54+00:00
---

# Self-serve install and lifecycle documentation

## Capability

A platform engineer at an organisation KnackLabs has never met installs Gantry from
npm and has a governed agent answering in Teams or Slack within an afternoon, using
only the documentation. The documentation is organised the way IT thinks: onboard,
access, audit, offboard — plus one security page a CISO can sign off on.

## Why

With no sales motion, the install and the docs are the product for every org after the first KnackLabs engagements. Today the package is unpublished and not runnable from npm, and docs are fragmented.

## Behaviour

### Packaging

- `@gantry/runtime` is published to npm from `main` on a release tag by CI with
  provenance; the first publish is part of this capability. `prepack` builds the
  artifact; `npm pack` → fresh install → `gantry` works without workspace builds.
- `gantry setup` on a workstation owns a local Compose Postgres lifecycle when no
  database URL is given; fleet deployments use the existing Terraform. Linux
  prerequisites (bubblewrap, socat) are documented and present in the fresh-machine
  test image.
- Time-to-first-agent is measured on a fresh machine and recorded with the release.

### Documentation spine

- Markdown in-repo (a hosted docs site is a separate, explicit decision). Lifecycle
  landing page → Slack quickstart, Teams quickstart → access (presets, tool rules,
  connector accounts) → audit (event and audit schema reference) → offboard (agent and
  person).
- SECURITY page consolidates threat model, locked posture (decision 0024), audit
  schema, and egress configuration; it states plainly what is enforced today versus
  what lands with sovereign mode.
- Broken links in the current docs entry are repaired as part of the spine.

## Acceptance criteria

- **PKG-1** — npm packaging and self-serve install
  - One documented npm install path produces a running runtime with Postgres and one agent
  - Time-to-first-agent measured on a fresh machine and recorded
  - CI publishes @gantry/runtime on release tag from main with provenance; first publish is part of this story
  - prepack builds the packaged artifact; npm pack -> fresh install -> gantry runs without workspace builds
  - Postgres: setup owns a local Compose lifecycle OR docs state user-started Postgres; one is chosen
  - Linux prerequisites (bubblewrap, socat) documented and present in the fresh-machine test image
- **DOCS-1** — Onboard/access/audit/offboard documentation spine
  - Docs are organised as onboard -> access -> audit -> offboard with Teams and Slack quickstarts
  - A SECURITY page states threat model, locked posture, audit schema, and egress list

## Source

Grill 2026-08-26 (Q1, Q9/Q17) and gap sweep (packaging, docs). Stories: PKG-1, DOCS-1.
