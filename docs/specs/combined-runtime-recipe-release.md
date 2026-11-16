---
status: confirmed
confirmed_by: user approval in chat 2026-11-16
---

# Combine hardened Gantry with recipe capability repairs

## Problem
The approved release must contain both security/integration PR634 and recipe metadata/CAPTCHA PR607/633. Neither existing image contains both.

## Scope / Non-goals
Combine the exact published commits on a new branch. Preserve originals. No real sites, paid providers, deployment, merges on GitHub or weakened sandbox controls.

## Acceptance Criteria
Both source histories remain ancestors. Metadata-bearing and ordinary calls preserve their exact inputs. Tool receipts, caller evidence and billing metadata survive. Fresh CAPTCHA answers succeed and stale answers fail. Runtime and SDK build. A new AMD64 image identifies the combined source. All limitations are disclosed in a new PR targeting test-recipe.

## Technical Approach
Merge dc97dc92 (contains dbf62773) into d6e95954. Resolve behavior together, never select a whole file blindly. Run focused local fixtures, runtime/SDK compilation, deterministic verification and one autoreview pass. Record actual artifacts through recorders.

## Decisions
User approved this cross-repository plan in chat on 2026-11-16. Keep existing configuration, credential, authority, caller-tool, provider-neutral, event and sandbox boundaries. Existing architecture failures must be measured against baseline and never waived silently. No product policy is changed by the integration.

## Surface Impact
MCP invocation metadata, caller results and CAPTCHA session version fields: preserved and combined. Browser/frontend product UI: unchanged. Live provider and native production-host acceptance: excluded by user request and disclosed, not represented as passed.

## Task Decomposition
One bounded integration task combines the published runtime changes and adds focused regression proof, then builds SDK/runtime/image and records review evidence.

## Risks
A text-clean merge may drop metadata or alter receipts. Build artifacts must come from the new combined source. Baseline architecture findings may block readiness and must not be hidden.

## Verify Plan
Use verify.py with architecture command, runtime typecheck and focused unit fixtures for proxy, invocation metadata, caller coordinator, browser/job checkpoint, billing and caller evidence. Build runtime/SDK and AMD64 image. Verify source ancestry, package/image hashes and whitespace before a new PR. Do not run full suite or hooks.
