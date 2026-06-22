# Production Readiness Scale-Up Plan

## Problem

Gantry has the core runtime shape for bounded parallel execution: one worker
machine can run multiple sandboxed child runners, and role-split deployments can
separate API, live chat, and jobs. The remaining work is to make the production
shape testable end-to-end: ECS deployment types, AWS Secrets Manager-backed
runtime env injection, provider-wide model onboarding, Bedrock AP South model
support, and measured sandbox/load gates.

## Current Evidence

- Runtime roles already exist as deployment-owned `GANTRY_PROCESS_ROLE` values:
  `all`, `control`, `live-worker`, and `job-worker`.
- AWS ECS services can run and maintain a desired number of task-definition
  instances; a load balancer is optional. This supports separate API/control,
  live-worker, and job-worker services from the same image.
- AWS ECS task definitions support plaintext `environment` entries for
  non-secret values and `secrets` entries backed by AWS Secrets Manager for
  sensitive env values.
- AWS ECS capacity-provider docs support Fargate, Fargate Spot, EC2 Auto
  Scaling group capacity providers, and ECS Managed Instances. Start execution
  workers on EC2 capacity providers until the sandbox runtime is proven on
  Fargate.
- AWS ECS Service Auto Scaling can adjust each service's desired task count
  from CloudWatch metrics such as service CPU, memory, or a custom queue/load
  metric.
- AWS ECS cluster auto scaling can manage EC2 Auto Scaling group capacity
  providers using `CapacityProviderReservation`, so worker service scaling and
  EC2 instance scaling are separate controls.
- AWS Fargate does not support `privileged`, `ipcMode`, `dockerSecurityOptions`,
  host devices, `tmpfs`, or most added Linux capabilities. This confirms that
  sandbox execution workers should start on EC2 capacity providers.
- Current sandbox behavior is one sandboxed child runner per active chat turn,
  job, delegated agent, or async bash task. Running sandboxes are not reused
  across users.
- Gantry now has 38 Bedrock OpenAI-compatible chat/job catalog entries routed
  through the existing `bedrock_api_key` credential lane and regional
  `bedrock-runtime.<region>.amazonaws.com/v1` Chat Completions endpoint.
- AWS CLI discovery confirms `ap-south-1` currently returns 42 ON_DEMAND
  text-output foundation models for this account. The catalog includes the 38
  general chat/job aliases and intentionally excludes the 2 Claude-on-Bedrock
  entries and 2 GPT-OSS safeguard entries because those need separate
  API-family or workload-specific lanes.
- AWS CLI discovery for `ap-south-2` with the same ON_DEMAND text-output filter
  returns no models for this account; no AP South 2 chat alias should be
  claimed.
- OpenRouter's official provider-routing docs confirm provider restriction is a
  Chat Completions request-body policy under the `provider` object, not a
  region/location availability concept.
- The model catalog now supports `providerAvailability` evidence metadata for
  provider-wide, region-scoped, and location-scoped model availability.
- OpenRouter provider routing is now modeled as optional catalog
  `providerRouting.openrouter` metadata and is projected to the DeepAgents
  OpenRouter runner only when a catalog entry opts into it.
- `ops/terraform/envs/ecs` now composes the concrete ECS/EC2 path: network,
  storage, optional IP-target ALB for control/API deployment types, ECS
  container-instance capacity, ECS services, and RDS/RDS Proxy.
- `ops/terraform/modules/ecs_service_set` maps `api-only`, `chat-only`,
  `jobs-only`, and `all` to the expected Gantry process roles, injects runtime
  secrets with ECS task-definition `secrets`, uses per-role task roles, and
  attaches the control/API target group to `control` and webhook ingress to
  `live-worker`.
- `ops/terraform/modules/ecs_capacity` creates an ECS-optimized EC2 Auto
  Scaling group that the ECS capacity provider can manage for pending task
  capacity.

Commands attempted on 2026-06-22:

```bash
aws bedrock list-foundation-models --region ap-south-1 --by-output-modality TEXT --query 'modelSummaries[?contains(inferenceTypesSupported, `ON_DEMAND`)].{modelId:modelId,provider:providerName,name:modelName,input:inputModalities,output:outputModalities}' --output json
aws bedrock list-foundation-models --region ap-south-2 --by-output-modality TEXT --query 'modelSummaries[?contains(inferenceTypesSupported, `ON_DEMAND`)].{modelId:modelId,provider:providerName,name:modelName,input:inputModalities,output:outputModalities}' --output json
```

Observed result:

```text
ap-south-1: 42 ON_DEMAND text-output models listed.
ap-south-2: [] for the same ON_DEMAND text-output filter.
Catalog scope: 38 general chat/job entries; Claude-on-Bedrock and GPT-OSS safeguard entries deferred.
```

AWS ECS docs checked on 2026-06-22:

- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/taskdef-envfiles.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/capacity-launch-type-comparison.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/asg-capacity-providers.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cluster-auto-scaling.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html`
- `https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html`

## Scope / Non-goals

- Keep the active model: one active sandboxed child runner per active chat turn,
  job, delegated agent, or async bash task.
- Add ECS deployment types by reusing existing `GANTRY_PROCESS_ROLE` values.
- Add Bedrock AP South model aliases only after AWS CLI confirms model
  availability in `ap-south-1` or `ap-south-2`.
- Make the onboarding path generic across providers: OpenAI, Anthropic,
  OpenRouter, Bedrock, Vertex, Groq, DeepSeek, xAI, Together, Fireworks,
  Cerebras, Perplexity, and Gemini should all use the same catalog metadata
  contract.
- Region/location availability is required only for providers whose credential
  mode selects a region or location, currently Bedrock and Vertex. Non-regional
  providers must not carry fake region data.
- OpenRouter provider restriction is in scope only as optional OpenRouter
  request routing metadata. It must not be modeled as a Gantry region, Vertex
  location, or Bedrock-style credential region.
- Benchmark current sandbox startup before adding reusable warm sandbox pools.
- Do not reuse running sandboxes across users.
- Do not add SigV4, default AWS credential-chain support, Bedrock Converse, or
  Claude-on-Bedrock in this production-readiness pass.

## Acceptance Criteria

- ECS supports `api-only`, `chat-only`, `jobs-only`, and `all` deployment types.
- AWS Secrets Manager values are injected through ECS task-definition secrets,
  not plaintext Terraform env vars.
- Only API/control and live webhook services attach public ALB target groups.
  Job-only services run without public load balancers.
- ECS service auto scaling is configured per service. `control`, `live-worker`,
  and `job-worker` can scale independently.
- EC2 capacity-provider managed scaling is configured for execution-worker
  capacity so pending worker tasks can trigger instance scale-out, with ECS
  managed termination protection and ASG instance scale-in protection enabled.
- New models can be onboarded by adding catalog data plus provider evidence,
  without changing runtime code for each model.
- The provider onboarding contract supports OpenAI, Anthropic, OpenRouter, and
  other non-regional providers with provider-level evidence only; Bedrock and
  Vertex additionally declare verified regions or locations.
- Bedrock AP South support is backed by successful AWS CLI evidence and catalog
  tests; only the 38 confirmed `ap-south-1` general chat/job entries are
  claimed.
- On an 8 CPU / 8 GB worker, the first tested default is:

  ```yaml
  runtime:
    queue:
      max_message_runs: 6
      max_job_runs: 2
    sandbox:
      resource_limits:
        memory_mb: 512
        max_processes: 64
  ```

- Sandbox startup gates:
  - `sandboxStartCallMs p95 <= 1.5s`
  - `sandboxStartCallMs p99 <= 3s`
  - `firstVisibleOutputMs p95 <= 10s`
  - sandbox startup failures: `0`
- Mixed-load gate covers chat, jobs, delegated agents, and async bash without
  live chat starvation, duplicate active turns, or orphan child processes.
- Locked public mode denial flood stays bounded and does not move live-chat p95
  by more than 10%.

## Technical Approach

1. ECS deployment types
   - Add an ECS deployment root that reuses the existing runtime roles.
   - Use one ECS service per role so services can scale independently:
     `control`, `live-worker`, and `job-worker`.
   - Map `api-only` to one `control` service with the ALB route.
   - Map `chat-only` to `control + live-worker`; `control` gets the
     control/API target group and `live-worker` gets the webhook ingress target
     group.
   - Map `jobs-only` to `job-worker` with no public ALB route.
   - Map `all` to `control + live-worker + job-worker`.
   - Put non-secret deployment knobs in task-definition `environment`, such as
     `GANTRY_PROCESS_ROLE`.
   - Put runtime secrets in task-definition `secrets` with Secrets Manager ARNs.
   - After secret rotation, force a new ECS deployment or launch fresh tasks;
     ECS injects secret env values when the container starts.
   - Use an EC2 Auto Scaling group capacity provider for execution workers first.
     Evaluate Fargate only after sandbox and child-process behavior is proven
     with the production benchmark gates.
   - Add ECS Service Auto Scaling separately per service:
     - `control`: scale on CPU/memory and request pressure.
     - `live-worker`: scale on active live runs, queue wait, CPU, and memory.
     - `job-worker`: scale on runnable jobs, queue wait, CPU, and memory.
   - Add EC2 capacity-provider managed scaling for worker capacity. Service
     scaling increases desired tasks; capacity-provider scaling adds instances
     when the cluster lacks room for those tasks.
   - Do not use Fargate for execution workers until a benchmark proves the
     sandbox works without unsupported Fargate features such as privileged mode,
     custom IPC, host devices, `tmpfs`, or broad Linux capabilities.

2. Bedrock AP South model support
   - Record model IDs and inference support for `ap-south-1` and `ap-south-2`.
   - Filter to models usable through the current Bedrock OpenAI-compatible
     route:
     `https://bedrock-runtime.<region>.amazonaws.com/v1/chat/completions`.
   - Add only confirmed OpenAI-compatible Bedrock model aliases in
     `apps/core/src/shared/model-catalog-bedrock.ts`, wired into the
     OpenAI-compatible catalog.
   - Keep unsupported or region-unavailable models out of the catalog.

3. Provider-wide model onboarding
   - Add a generic model availability contract to catalog entries. Name it
     `providerAvailability`, not `regionAvailability`, because not every
     provider is region-scoped.
   - Contract shape:

     ```ts
     providerAvailability?: {
       verifiedAt: string;
       evidence: {
         source: 'official_docs' | 'provider_cli' | 'provider_api';
         commandOrUrl: string;
       };
       scope:
         | { kind: 'provider' }
         | { kind: 'regions'; values: readonly string[] }
         | { kind: 'locations'; values: readonly string[] };
     };
     ```

   - For normal non-regional providers, use `scope: { kind: 'provider' }`:
     OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, xAI, Together, Fireworks,
     Cerebras, Perplexity, and Gemini.
   - For region/location-scoped providers, store verified regions or locations:
     - Bedrock: AWS regions such as `ap-south-1`.
     - Vertex: Google Cloud locations such as `global` or a verified regional
       location once supported.
   - Add small provider-family helpers only where they remove repeated catalog
     boilerplate, such as `anthropicModel`, `openRouterModel`,
     `openAiCompatibleChatModel`, `bedrockChatModel`, and `vertexChatModel`.
   - Add preflight validation only for providers whose active credential payload
     contains a region/location field. For OpenAI, Anthropic, OpenRouter, and
     other non-regional providers, the preflight checks credential availability
     but skips region/location matching.
   - Add a separate optional routing contract for providers that expose
     per-request provider routing. Do not overload `providerAvailability`.

     ```ts
     providerRouting?: {
       openrouter?: {
         only?: readonly string[];
         ignore?: readonly string[];
         order?: readonly string[];
         allowFallbacks?: boolean;
         requireParameters?: boolean;
         dataCollection?: 'allow' | 'deny';
         zdr?: boolean;
         enforceDistillableText?: boolean;
         quantizations?: readonly string[];
         sort?: 'price' | 'throughput' | 'latency';
       };
     };
     ```

   - For OpenRouter, map `providerRouting.openrouter` to the OpenRouter
     Chat Completions request body's `provider` object only when
     `modelRoute.id === "openrouter"`.
   - Support the OpenRouter docs-backed controls: `provider.only`,
     `provider.ignore`, `provider.order`, `provider.allow_fallbacks`,
     `provider.require_parameters`, `provider.data_collection`,
     `provider.zdr`, `provider.enforce_distillable_text`,
     `provider.quantizations`, and `provider.sort`.
   - Keep the naming clear: OpenRouter's `provider` object is upstream routing
     policy. Gantry's `modelRoute.providerId` remains the internal credential
     route. They are related only inside the OpenRouter adapter/gateway path.
   - Validate OpenRouter routing metadata with simple shape checks: no empty
     provider slug strings, no `only` and `ignore` overlap, no empty `order`
     entry, and no route hints on non-OpenRouter model routes.
   - Keep runtime discovery out of the hot path. Use discovery scripts or CLI
     commands to generate evidence and catalog candidates.

4. Sandbox and worker capacity
   - Keep spawning one sandboxed child process per active run/task.
   - Measure current startup and first-visible-output timings.
   - Defer reusable warm sandbox pools until measurement proves sandbox spawn is
     a top p95 bottleneck.

5. Production load proof
   - Run disposable-Postgres mixed-load tests with role-split workers.
   - Include worker kill/restart and async task cancellation.
   - Report active sandboxes, CPU, RSS, process count, queue wait, startup
     timing, first visible output, and terminal task state.

## Surface Impact Matrix

| Surface                      | Status               | Reason                                                                                                                                         |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | ECS deployment, provider availability preflight, and confirmed aliases affect runtime execution choices.                                       |
| `settings.yaml`              | Unchanged by design  | Deployment roles stay environment-owned; model selection still uses existing alias fields.                                                     |
| Postgres/runtime projection  | Read-only/observable | Existing sessions, leases, async task rows, and events provide load-test evidence; this provider metadata slice adds no rows.                  |
| Control API                  | Read-only/observable | Existing health, model, and metrics surfaces should expose readiness.                                                                          |
| SDK/contracts                | Changed              | DeepAgents runner env accepts optional OpenRouter provider-routing JSON; the base contract remains provider route plus loopback gateway token. |
| CLI                          | Read-only/observable | Existing model/status commands should show the new aliases and readiness state.                                                                |
| Gantry MCP tools/admin skill | Unchanged by design  | No new authority surface is required.                                                                                                          |
| Channel/provider adapters    | Changed              | DeepAgents/OpenRouter adapter projection now forwards optional provider-routing metadata; channel behavior is unchanged.                       |
| Docs/prompts                 | Changed              | Production plan, provider onboarding contract, Bedrock AP South support, ECS Terraform root, and ECS runbook notes are documented.             |
| Audit/events                 | Unchanged by design  | Provider-routing metadata is model request shaping, not a new user authority or audit event.                                                   |
| Tests/verification           | Changed              | Add/extend ECS validation, provider model onboarding, model catalog, mixed-load, locked denial, and sandbox timing checks.                     |

## Task Decomposition

1. Bedrock AP South discovery
   - Status: implemented.
   - Write scope: docs evidence and model catalog tests.
   - Dependency: none; AWS CLI is authenticated.
   - Acceptance: model IDs recorded per region; `ap-south-2` non-support is
     explicit.
   - Verify:
     `aws bedrock list-foundation-models --region ap-south-1` and
     `aws bedrock list-foundation-models --region ap-south-2`.

2. Bedrock catalog aliases
   - Status: implemented.
   - Write scope: Bedrock model catalog, OpenAI-compatible catalog wiring,
     focused model tests, docs.
   - Dependency: successful CLI evidence.
   - Acceptance: the 38 AP South 1 general chat/job entries resolve through
     `modelRoute.id === "bedrock"` and existing `bedrock_api_key` mode;
     representative aliases include `bedrock-kimi`, `bedrock-kimi-thinking`,
     `bedrock-qwen-coder`, `bedrock-minimax`, `bedrock-glm`,
     `bedrock-mistral-large-3`, `bedrock-nemotron-super-120b`, `bedrock-oss`,
     and `bedrock-oss-20b`.
   - Verify: `npm run test:unit -- apps/core/test/unit/models/model-catalog.test.ts`.

3. Provider-wide model onboarding contract
   - Status: implemented for catalog metadata and validation; credential
     region/location preflight remains pending until a provider needs it at
     runtime.
   - Write scope: shared model catalog types/helpers, focused catalog tests,
     docs.
   - Dependency: none.
   - Acceptance: model entries can declare provider-level availability for
     OpenAI/Anthropic/OpenRouter-style providers, region-level availability for
     Bedrock, and location-level availability for Vertex without per-model
     runtime branches.
   - Verify:
     `npm run test:unit -- apps/core/test/unit/models/model-catalog.test.ts`.

4. OpenRouter provider routing metadata
   - Status: implemented for catalog validation, host env projection, and
     runner request-body forwarding.
   - Write scope: model catalog/provider route metadata, OpenRouter adapter or
     gateway request shaping, focused tests, docs.
   - Dependency: provider-wide onboarding contract.
   - Acceptance: OpenRouter models can optionally restrict or order upstream
     providers through the request-body `provider` object without adding fake
     region/location data or leaking raw provider-routing details into public
     model alias selection.
   - Verify: focused OpenRouter gateway/adapter request-body test proving the
     `provider` object is present only for OpenRouter routes.

5. ECS deployment types
   - Status: implemented in Terraform; local `terraform validate` is still
     blocked because Terraform/OpenTofu is not installed in this environment.
   - Write scope: Terraform ECS root/modules and deployment docs.
   - Acceptance: each deployment type creates only the expected services and
     task definitions use ECS secrets.
   - Verify: Terraform fmt/init/validate for ECS plus existing fleet/support
     regression validation.

6. ECS scaling policy
   - Status: implemented for ECS Service Auto Scaling and EC2 capacity-provider
     managed scaling; staged AWS scale proof remains pending.
   - Write scope: Terraform ECS autoscaling resources and deployment docs.
   - Dependency: ECS deployment types.
   - Acceptance: each service has independent min/max desired counts and target
     tracking policies; the EC2 worker capacity provider has managed scaling
     enabled; API/control scale-out cannot force job-worker scale-out unless
     shared EC2 capacity is actually needed.
   - Verify: Terraform validate plus a staged scale test that creates pending
     live-worker and job-worker tasks and confirms desired task count and EC2
     capacity move independently.

7. Production benchmark gates
   - Status: gate harness added; full production run evidence still pending.
   - Write scope: benchmark harness or documented commands only after ECS/model
     surfaces are ready.
   - Acceptance: 8 CPU / 8 GB baseline passes the gates above.
   - Verify: mixed-load run, cold-vs-warm sandbox timing run, worker recovery
     run, then evaluate the exported evidence with
     `python3 .codex/scripts/production_benchmark_gates.py --input <evidence.jsonl>`.

## Risks

- AWS account access can differ from public region availability.
- `list-foundation-models` can include models that do not work through the
  current Bedrock OpenAI-compatible route.
- Provider APIs expose availability differently; keep the catalog contract small
  and store provider-specific proof as evidence, not as runtime branching.
- OpenRouter `provider.only` or `allow_fallbacks: false` can deliberately
  remove fallback capacity. The product should fail clearly when the selected
  upstream provider cannot serve the model instead of silently widening the
  request.
- Warm sandbox pools add state-bleed and permission-bleed risk; they are deferred
  until timing evidence justifies the complexity.
- ECS on Fargate may not match the current sandbox runtime assumptions; start
  with ECS on EC2 capacity providers for execution workers.
- ECS Service Auto Scaling changes desired task count; it does not create EC2
  capacity by itself. The EC2 capacity provider must also have managed scaling
  enabled.
- Fargate's unsupported privileged/kernel/runtime controls make it a later
  validation target, not the first execution-worker deployment target.
- Secrets injected as env vars are visible to the application process and can
  require fresh tasks after rotation; do not use plaintext task-definition
  environment entries for credentials.

## Verify Plan

```bash
aws bedrock list-foundation-models --region ap-south-1 --by-output-modality TEXT --query 'modelSummaries[?contains(inferenceTypesSupported, `ON_DEMAND`)].modelId'
aws bedrock list-foundation-models --region ap-south-2 --by-output-modality TEXT --query 'modelSummaries[?contains(inferenceTypesSupported, `ON_DEMAND`)].modelId'
npm run test:unit -- apps/core/test/unit/models/model-catalog.test.ts
npm run test:unit -- apps/core/test/unit/adapters/deepagents-execution-adapter.test.ts apps/core/test/unit/adapters/deepagents-model-factory.test.ts
python3 .codex/scripts/production_benchmark_gates.py --input <evidence.jsonl>
terraform fmt -check -recursive ops/terraform
terraform -chdir=ops/terraform/envs/ecs init -backend=false
terraform -chdir=ops/terraform/envs/ecs validate
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
```

The production benchmark evidence file is JSONL. It must include real
`run.startup_diagnostic` runtime-event rows whose payload contains
`startupTiming.sandboxStartCallMs` and `startupTiming.firstVisibleOutputMs`,
plus one `production_benchmark_summary` record with the observed worker shape,
queue defaults, sandbox limits, mixed-load coverage, terminal task state, and
locked public denial-flood p95 comparison. The gate script does not generate
load; it only fails or passes the exported evidence against the acceptance
criteria in this plan.
