---
slug: web-runtime-console-phase-2
title: Web Runtime Console — Phase 2: Read-only Operations
status: draft
saved: 2026-08-12T14:25:37+00:00
---

# Web Runtime Console — Phase 2: Read-only Operations

## Why

The private Gantry console now proves its connection and renders the agent
directory, but an operator still cannot see the deployment's participating
processes, whether a worker is stale or degraded, or the safe configuration
that explains what an agent can do. This phase completes the operational
inventory before metrics history or live execution hierarchy are added.

## Behaviour

- The private UI continues to call only same-origin `/ui/api/*` routes. Its
  server keeps the Control API credential and targets the Gantry `all` or
  `control` process; it never points at a worker-only Control API profile.
- The Control API adds structured, authenticated runtime summary and instance
  projections. They combine the current serving process with registered
  workers, deduplicate the current worker when it is registered, calculate
  health from existing readiness and heartbeat rules, and expose only safe
  identifiers, role, status, timing, capacity, and capability names.
- Overview shows connection state, a deployment summary, safe health/capacity
  signals, instance counts, and linked attention items. It preserves the
  existing loading, stale, retry, partial, and disconnected behaviour.
- Instances lists the current serving process and known workers. Instance
  details use read-only Overview, Health, Capacity, and Capabilities tabs.
- Agents links to a read-only agent detail. Its Summary is eager; configured
  delegation, skills, capabilities, access, and recent bounded job activity
  load only when their tab opens. Configured delegation is never represented
  as live execution hierarchy.
- The console omits credentials, transport addresses, leases, raw event or
  provider payloads, correlation data, conversation data, action command
  templates, and secret/preflight information.

## Acceptance criteria

1. A single workstation `all` process, a request-serving `control` process,
   and registered live/job workers render as one deduplicated instance
   inventory with their distinct role and safe health state.
2. A stale heartbeat and a degraded readiness state are separately labelled
   and understandable without relying on colour alone.
3. Overview, Instances, and read-only Agent detail use browser-safe UI API
   resources and retain explicit loading, empty, stale, partial, retry, and
   disconnected states without fixture fallback.
4. Agent detail relation tabs are lazy and independent; delegation, skills,
   capabilities, access, and bounded recent activity expose no sensitive
   operational fields.
5. No mutation, restart, login, role, direct database, browser credential,
   Prometheus parsing, metrics history, or live execution stream is added.
6. Backend/API tests protect the new structured projections and safe UI
   facade shape. No frontend unit, component, browser automation, snapshot,
   or visual-regression test suite is added; the user-facing flow receives a
   manual browser acceptance pass.
