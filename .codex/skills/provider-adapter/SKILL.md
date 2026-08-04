---
name: provider-adapter
description: Use for LLM, channel, browser, sandbox, credential, and external provider adapter changes in Gantry.
---

# Provider Adapter

Use this skill when a task changes LLM providers, channel providers, browser providers, sandbox providers, credential brokers, provider sessions, or provider-specific SDK integration.

## Required Workflow

1. Read `docs/decisions/0001-agent-runtime-platform.md`, `docs/architecture/codebase-refactor-principles.md`, and relevant provider or credential decision records.
2. Implement provider behavior behind ports or adapter-owned APIs. Do not leak provider SDK types, callback shapes, model IDs, or channel payloads into domain/application logic.
3. Normalize inbound channel payloads into canonical app, conversation, thread, message, session, and run concepts before application behavior runs.
4. For model selection, use catalog-backed aliases and the public vocabulary `modelAlias`, `responseFamily`, diagnostic `modelRoute`, resolver-owned `executionProviderId`, and `credentialProfileRef`; do not accept raw provider model IDs at public boundaries unless registered as aliases.
5. Native Agent subagent model overrides must resolve through the same catalog and stay on the parent provider backend; use a separate session or job for cross-provider delegation.
6. Translate provider failures into stable application errors or decisions at the adapter boundary.
7. Add or update provider-session, resume, channel wiring, or message persistence tests for changed behavior.
8. Run `python3 scripts/check_architecture.py` before final handoff when possible.

## Evidence To Provide

- Port or adapter boundary used.
- Provider leakage checked.
- Resume/session or message persistence tests updated when relevant.
