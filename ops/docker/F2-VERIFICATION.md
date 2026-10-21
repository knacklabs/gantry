# F2 minimum-host-access checks

Gantry stays in Docker. Do not start a scraping stack or change production
configuration to run these checks. A passing primitive or first comparison is
not F2 acceptance.

## First comparison

Run `node ops/docker/verify-non-root-sandbox.mjs --compare`.
When Docker is offline, this records `blocked / docker_unavailable` and exits
nonzero. It never starts Docker Desktop, Compose, or existing containers.

When Docker is available, provide:

- `F2_CREATE_SPEC_FILE`: private Docker Engine create JSON for a disposable
  baseline using the current image ID and application settings. Retarget only
  fixture infrastructure before freezing this baseline: a newly labelled
  `gantry-f2-*` network and volumes, a fresh `gantry_f2_*` database at a
  `gantry-f2-*` hostname, synthetic application/session state, no notifications,
  and loopback-only test ports. Use `RestartPolicy.Name=no`.
- `F2_ACCEPTANCE_PROBE`: a Node script using supported Gantry job/session/event
  APIs against that fixture. It receives `F2_CONTAINER_ID` and
  `F2_EVIDENCE_DIR`. Do not substitute the hermetic fake-runner lifecycle test
  for real agent execution.

The first stage changes **only `HostConfig.Privileged=false`**. A unit test pins
the entire remaining specification, including image, user, environment,
mounts, command, seccomp and process-path protections. The harness verifies
actual network/volume ownership labels before creating a new candidate. It
retains private creation, effective-policy, probe and log evidence, and stops
only its own new candidate afterward. It does not delete retained state.

The real-job probe must output one JSON object with actual `jobId`, `runId` and
boolean `checks`: `startup`, `settingsImport`, `workspace`, `httpsProxy`,
`cdp`, `discovery`, and `streamedCompletion`. Each check needs independent
execution evidence saved in `F2_EVIDENCE_DIR`; a model claiming success is not
execution evidence. Exit 2 for unavailable prerequisites, 1 for a failed check,
and 0 only after collecting the results. Missing checks stay partial.

## Later stages

After recording and reviewing the first real-job result, set `F2_STAGE` to one
of `non-root`, `drop-capabilities`, `default-seccomp`, `filtered-seccomp`,
`readonly-root`, or `proc-paths`. Supply the last passing isolated create
specification as the next baseline; do not combine untested changes.

`F2_STAGE_OPTIONS_FILE` supplies either the reviewed deny-by-default `profile`
for filtered seccomp or explicit `removeMasked`/`removeReadonly` arrays for a
process-path experiment. Only existing `/proc/` entries can be removed. The
harness rejects blanket `systempaths=unconfined`, host namespaces, host devices,
administrator capability additions, host bind mounts and application volumes.

Docker Engine supports explicit `MaskedPaths`/`ReadonlyPaths`; that does not
prove the deployed Compose tooling can express them. Resolve that deployment
gate before changing Tender Compose. Do not replace it with a blanket option.

Final acceptance additionally requires cancellation, restart/recovery,
parent/sibling isolation, denied application and host-marker access, dependency
and kernel provenance, effective capabilities/seccomp, and the target-host
checks in the approved F2 plan. `f2Accepted` remains false in this first-stage
harness; do not use its exit code to claim security closure.

## Focused checks

`node --test ops/docker/f2-container-policy.test.mjs ops/docker/f2-comparison.test.mjs`

Evidence includes private environment-bearing configuration: retain it locally
with restrictive permissions; publish only the redacted result summary.

## Compose process-path preparation

Compose has no fields for Engine `MaskedPaths`/`ReadonlyPaths`; do not add
unsupported YAML keys or use `systempaths=unconfined`. The host-side
`scoped-proc-policy.mjs` prepares an explicitly opted-in, **stopped** Gantry
container through the local Engine API. The Docker socket is never mounted in
Gantry. It preserves Compose labels, command, environment, mounts, healthcheck
and network aliases, and pins the inspected image ID. It verifies the candidate
before replacing the stopped container, never removes volumes and never starts
any service. Running containers and missing security prerequisites are refused.

This is a deployment candidate, not yet production integration. Once the final
configuration passes acceptance, set the label
`gantry.security.proc-policy: scoped-v1` on Gantry only. Create that service
without starting it or its dependencies
(`docker compose up --no-start --no-deps gantry-runtime`), then run:

```
node ops/docker/scoped-proc-policy.mjs <stopped-container-id> <reviewed-policy.json> <private-evidence-directory>
```

Start only the prepared service using `docker compose start gantry-runtime`.
Repeat preparation after **every recreate**. Plain `compose up --force-recreate`
does not carry these extra Engine fields and is not an accepted deployment path.
The original private inspection is saved before replacement; if a rename fails,
the verified replacement remains stopped for explicit recovery. There is no
automatic fallback to a broader security policy.
