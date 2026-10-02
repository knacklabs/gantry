# Gantry by area

One document per area of the app. Each has a plain-English overview, an architecture diagram, the key flows as sequence diagrams with step-by-step walkthroughs, the data it owns, how it scales and fails, a short video script outline, and duplication and simplification notes. They were written on 2026-10-02 by tracing the code, alongside the [area audit](../audits/2026-10-02-area-audit/README.md).

| Area                                                | Document                                            |
| --------------------------------------------------- | --------------------------------------------------- |
| Channel and provider adapters                       | [01-channels](./01-channels.md)                       |
| Runtime turn engine and sessions                    | [02-runtime](./02-runtime.md)                         |
| Scheduled jobs and the scheduler                    | [03-jobs](./03-jobs.md)                               |
| Agents, runner and model engines                    | [04-agents-engines](./04-agents-engines.md)           |
| Memory and company brain                            | [05-memory-brain](./05-memory-brain.md)               |
| Storage adapters and repositories                   | [06-storage](./06-storage.md)                         |
| Control plane, CLI, config and bootstrap            | [07-control-cli-config](./07-control-cli-config.md)   |
| Web console, SDK and contracts                      | [08-web-sdk](./08-web-sdk.md)                         |
| Identity, credentials, capabilities, MCP and skills | [09-identity-access](./09-identity-access.md)         |
| Shared utilities and domain types                   | [10-shared-domain](./10-shared-domain.md)             |
| Deployment, run modes and scaling                   | [11-deploy-scaling](./11-deploy-scaling.md)           |
| Observability and operations                        | [12-observability-ops](./12-observability-ops.md)     |
| Security boundaries                                 | [13-security-boundaries](./13-security-boundaries.md) |
| Tests and test harnesses                            | [14-tests-harness](./14-tests-harness.md)             |
