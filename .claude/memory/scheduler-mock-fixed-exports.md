---
name: scheduler-mock-fixed-exports
description: Control-server tests mock @core/jobs/scheduler.js with fixed export factories — new re-exports through scheduler.ts break those suites at import time
metadata: 
  node_type: memory
  type: project
  originSessionId: 4a2212f2-c77e-4277-afef-230436a7b908
---

Control-server unit tests (`apps/core/test/unit/control/server-auth.test.ts`, `job-trigger.test.ts`) mock `@core/jobs/scheduler.js` with vi.mock factories listing a fixed set of exports. Any new export added to `scheduler.ts` and imported by `routes/jobs.ts` is missing on the mock, so the routes module fails to load and every route test returns 500 — but only in those suites, so local runs of config/jobs/application dirs stay green and it surfaces first in CI (broke PR #206 CI on 2026-07-09).

**Why:** vi.mock factories don't pass through new module exports; the route module import throws.

**How to apply:** import new helpers into control routes from their source module (e.g. `jobs/system-registration-cache.js`) instead of re-exporting through `scheduler.ts`; and when touching control routes, run `apps/core/test/unit/control` locally before pushing. Also note: the repo has no required GitHub status checks, so `gh pr merge --auto` merges immediately even with CI in flight.
