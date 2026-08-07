---
slug: manipal-deep-analysis-runtime-recovery
title: Manipal deep-analysis runtime recovery boundary
status: confirmed
saved: 2026-08-06T14:30:00+00:00
---

# Manipal deep-analysis runtime recovery boundary

## Capability

Gantry keeps scheduled structured jobs fail-closed when a caller-owned
completion gate requests another turn. If the provider fails during that
continuation, Gantry reports a stable, provider-neutral failure code and keeps
the job failed; it never publishes completion without both gate acceptance and
validated structured output. The caller may use its own durable checkpoints to
start a separate recovery job.

The public SDK also exposes the existing model-credential administration routes
under `client.models.credentials`, allowing an application facade to reconcile
provider credentials without depending on an unpublished client shape.

## Behaviour

1. A scheduled response-schema job asks its completion gate before validating
   an intermediate provider result. A `continue` decision steers the same live
   provider session with the caller's exact bounded instruction.
2. A provider or SDK failure after that continuation begins is reported with
   `failure.code = completion_continuation_failed`. The original redacted
   diagnostic remains available as the human-readable summary.
3. The stable code propagates through runner output, job finalization, delegated
   task projection, and `job.run.failed` JSON without text matching or a schema
   migration.
4. An interrupted streaming model call is classified as `provider`,
   `model_client`, or `gantry_timeout`. Gantry records the source and phase on
   the existing model OTel span, emits the same bounded metadata on
   `credential.model.used`, and reports `failure.code = model_transport_failed`
   when the interrupted stream makes the runner fail.
5. A run completes only when the completion gate accepted and AJV validated the
   configured response schema. A single existing schema-only repair remains the
   maximum structured-output retry.
6. Cancellations, provider authentication, unrelated execution, child
   task, and structured-output validation failures retain their own existing
   classification and do not receive the continuation code.
7. `@gantry/sdk` exposes list, put, patch, and disable model-credential methods
   at `client.models.credentials`; reads remain redacted and writes use the
   existing authenticated control routes.

## Non-goals

- Gantry does not understand Manipal research, draft, reviewer, or report stages.
- Gantry does not restart a failed application workflow or choose a fallback
  model.
- No new database table, callback, webhook, polling loop, or retry queue is
  introduced.
- This capability does not change evidence coverage, prompt content, or the
  caller's recovery policy.

## Required falsifiers

- A continuation that later succeeds still completes with validated output.
- A malformed provider result during continuation fails with the stable code and
  never emits `job.run.completed`.
- An invalid final schema still uses only the existing one repair and the
  existing `structured_output_validation_failed` code.
- Unrelated failures never receive `completion_continuation_failed`.
- SDK tests prove the model-credential methods use the existing routes and do
  not expose credential values through reads.
