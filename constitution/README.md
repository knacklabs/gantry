# KnackLabs Engineering Constitution

This directory is the **single source of truth** for KnackLabs engineering standards.
The former Notion pages are deprecated; changes land only as PRs to this repo.
Deviations must be deliberate and stated ("Context is King" — prefer the
standard, deviate with a written reason).

Precedence when guidance conflicts (see also `harness.yaml`):
1. This constitution wins over any skill's guidance.
2. Factory gates (`.agents/scripts/`, `.factory/` artifacts) win over workflow skills.
3. gstack skills win over other third-party skills.

In generated repos this directory is vendored and pinned (`VENDORED_FROM`);
update by re-vendoring from the harness, never by editing in place.

## Index — read the matching reference before acting

### Repo setup & architecture
| Topic | Read when… | Reference |
|---|---|---|
| Agentic development workflow | Setting up / following the AI-assisted dev workflow | `00-agentic-development-workflow.md` |
| Agent conduct | ALWAYS — how agents think, scope, diff, and recommend | `09-agent-conduct.md` |
| Monorepo standard | Creating or structuring a repo | `01-monorepo-standard.md` |
| Shared library best practices | Adding reusable code to `/shared` or `/libs` | `02-shared-library-best-practices.md` |
| Modular monolith structure | Designing modules / domain boundaries | `03-modular-monolith-structure.md` |

### Backend
| Topic | Read when… | Reference |
|---|---|---|
| Coding standards (modular monolith) | Writing NestJS/FastAPI code; code review | `pnp-coding-standards-modular-monolith.md` |
| Event & Service Bus | Designing events, pub/sub, idempotency, retries | `04-event-and-service-bus.md` |
| Logging & observability | Adding logs, metrics, tracing, alerting | `05-logging-and-observability.md` |
| Logger & log transports | Choosing a logger / transports per environment | `06-logger-and-log-transports.md` |
| Exception handling | Catching, classifying, returning errors | `07-exception-handling.md` |
| Notification module | Building outbound notifications (email/SMS/push) | `08-notification-module.md` |
| Provider pattern | Integrating an external service (SMS, payments, KYC…) | `pnp-provider-pattern-for-integration.md` |

### API & data
| Topic | Read when… | Reference |
|---|---|---|
| API standards | Designing or reviewing REST endpoints | `pnp-api-standards.md` |
| Swagger / OpenAPI docs | Documenting APIs | `pnp-swagger-api-documentation-standards.md` |
| Database standards | Naming/modeling tables, schemas, migrations | `pnp-database-standards.md` |

### Conventions
| Topic | Read when… | Reference |
|---|---|---|
| Branch naming (Git Flow) | Naming branches / managing releases | `pnp-branch-naming-standards.md` |
| Environment naming | Naming environments | `pnp-environment-naming-standards.md` |

### DevOps / AWS
| Topic | Read when… | Reference |
|---|---|---|
| AWS tagging & naming | Naming/tagging AWS resources | `aws-tagging-naming-conventions.md` |
| AWS root credentials | Handling AWS account root credentials | `aws-root-credentials-best-practices.md` |
| AWS OUs & sub-accounts | Creating AWS accounts / OU hierarchy / SCPs | `aws-organization-unit-sub-accounts.md` |
| Terraform / IaC | Writing or reviewing Terraform | `terraform-iac.md` |
