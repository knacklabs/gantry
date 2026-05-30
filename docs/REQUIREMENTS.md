# Gantry Requirements

## Why This Exists

Gantry exists to provide a dependable agent runtime for personal and enterprise deployment modes without turning the project into an unclear control plane.

The default experience should stay:

- small enough to understand
- secure by default
- easy to customize in code
- practical to run from everyday messaging and application channels

## Product Principles

### Small Enough to Understand

The core runtime should stay compact. Prefer one clear implementation over multiple abstraction layers.

### Security Through Explicit Host Boundaries

Agents currently run through host execution. Security relies on explicit trust boundaries, scoped runtime paths, and least-privilege operational defaults.

### Built Around Clear Deployment Boundaries

Gantry supports personal and enterprise deployment modes, but the runtime should optimize for clear app, agent, conversation, and permission boundaries instead of broad SaaS tenancy features.

### Customization Through Code

If a behavior matters, it should be easy to change in code. Avoid building large configuration systems to cover every edge case.

### AI-Native Operations

Setup, debugging, and maintenance should work well through local developer tools without requiring a heavyweight admin UI.

### Skills Over Core Bloat

Optional capabilities should land as skills or narrow extensions whenever possible so the default runtime stays lean.

## Core Outcomes

- secure per-group execution
- isolated memory and file context per group
- predictable routing and scheduling
- straightforward operational debugging
- easy extension through skills and focused code changes

## Core Scope

### Orchestrator

- single Node.js process
- Postgres-backed persistence
- queue-driven message execution
- deterministic session and runtime behavior

### Runtime

- host runtime as the single supported execution path
- clear runtime health and remediation signals

### Channels

- add exactly the channels the user needs
- self-register at startup
- skip cleanly when credentials are missing

### Memory and Files

- per-group working directories
- per-group memory files
- optional shared/global memory with controlled write access

### Scheduling

- one-time and recurring jobs
- job execution in group context
- auditable run history

## Non-Goals

- multi-tenant administration
- plugin sprawl in core
- hidden magic that makes debugging harder
- architecture decisions that trade clarity for extensibility theater

## Naming and Documentation Rules

- User-facing docs should refer to the project as `Gantry`.
- Historical references should be rare and clearly marked when they are needed.
- Active guidance should describe this repo directly rather than talking about forks or upstreams as the default model.
