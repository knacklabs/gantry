# PnP — Coding Standards for Modular Monolith

_Source: KnackLabs — Engineering @ KnackLabs (Notion). Synced 2026-06-22._

---
*For NestJS (TypeScript/JavaScript) and FastAPI (Python)*

---

### 1. Purpose & Scope
This playbook defines **coding standards** for all V1 projects built using our **Modular Monolith** architecture, specifically for:
- **NestJS** (TypeScript/JavaScript)
- **FastAPI** (Python)
Core goals:
- Enforce **consistent naming and file structure**
- Make it obvious **what a file/class does** from its name
- Maintain **strict module boundaries** and **clean interfaces**
- Make future migration to **microservices** straightforward

---

### 2. Global Naming & File Suffix Standards

#### 2.1 General Rules
- **Always include a suffix** that describes the role of the file/class.
- Name files using:
  - **NestJS / TS**: `kebab-case` + `.suffix.ts`
    - Example: `user.controller.ts`, `payment-provider.service.ts`
  - **FastAPI / Python**: `snake_case` + `_suffix.py`
    - Example: `user_controller.py`, `payment_provider.py`
- Class names are **PascalCase**, functions are **camelCase**, constants are **UPPER_SNAKE_CASE** (TS) or `snake_case` (Python).

---

#### 2.2 Suffix Reference Table (Authoritative)
> 📌 This table is the single source of truth for qualifiers.

| Concern / Role | Suffix | When to Use | NestJS Example | FastAPI Example |
| --- | --- | --- | --- | --- |
| Module definition | `module` | Root module for a domain or feature | `user.module.ts` | `user_module.py` (optional, if needed) |
| HTTP / API controller | `controller` | Exposes HTTP endpoints or transport-specific handlers (REST, GraphQL, WebSocket, etc.) | `user.controller.ts` | `user_controller.py` |
| Service / business logic | `service` | Application or domain logic, orchestration, use-cases. No HTTP or DB logic directly. | `user.service.ts` | `user_service.py` |
| Data transfer object | `dto` | Input/output schemas, request/response objects | `create-user.dto.ts` | `user_dto.py` or `user_schemas.py` |
| Domain entity | `entity` | Domain model mapped to DB, aggregates, core business entities | `user.entity.ts` | `user_entity.py` or `user_entities.py` |
| Model (view / projection) | `model` | Non-DB models: view models, read models, projections, external-response models | `user-profile.model.ts` | `user_profile_model.py` |
| Repository | `repository` | Persistence abstraction; all DB access for a domain | `user.repository.ts` | `user_repository.py` |
| Provider (3rd-party / integration) | `provider` | Class that **integrates with external service** (payment, SMS, email, etc.) | `sms.provider.ts`, `stripe.provider.ts` | `sms_provider.py`, `stripe_provider.py` |
| Helper (utility only) | `helper` | **Pure utility** functions/classes, stateless, no external IO or heavy integration | `currency.helper.ts` | `currency_helper.py` |
| Interface | `interface` | Contract definition for services, repositories, providers, etc. | `user-repository.interface.ts` | `user_repository_interface.py` |
| Event / Domain event | `event` | Domain events emitted inside the system | `user-created.event.ts` | `user_created_event.py` |
| Command (CQRS) | `command` | Command objects in CQRS flows | `create-user.command.ts` | `create_user_command.py` |
| Config / settings | `config` | Configuration objects, environment mapping | `app.config.ts` | `settings_config.py` |
| Middleware | `middleware` | Request/response middleware | `logging.middleware.ts` | `logging_middleware.py` |
| Exception / error | `exception` | Custom domain or application exceptions | `user-not-found.exception.ts` | `user_not_found_exception.py` |

---

### 3. Providers vs Helpers (Very Important Distinction)

#### 3.1 When to Use **Provider**
A **Provider**:
- Encapsulates interaction with a **third-party or external system**.
- Typically involves **IO operations**:
  - Payment gateway (Stripe, Razorpay, etc.)
  - SMS service (Twilio, MSG91, etc.)
  - Email service (SES, SendGrid, etc.)
  - External APIs (maps, KYC, credit bureau, etc.)
- Has **side effects** and potential **retries**, **timeouts**, **failures**.
**Rules:**
- File suffix: `provider`
- Class name: `<Name>Provider`
  - Example (NestJS): `PaymentProvider` in `payment.provider.ts`
  - Example (FastAPI): `PaymentProvider` in `payment_provider.py`
**Examples:**
- `sms.provider.ts` / `sms_provider.py`
- `payment.provider.ts` / `payment_provider.py`
- `email.provider.ts` / `email_provider.py`

---

#### 3.2 When to Use **Helper**
A **Helper**:
- Contains **pure utility** logic.
- Stateless; ideally **no IO** and no external dependencies.
- Used to manipulate strings, numbers, dates, formatting, etc.
- Safe to be called anywhere without side effects.
**Rules:**
- File suffix: `helper`
- Class or function group name: `<Name>Helper` or a module of functions.
**Examples:**
- `email.helper.ts` – email validation, masking, formatting
- `timezone.helper.ts` – timezone conversions
- `currency.helper.ts` – rounding, formatting, currency symbol mapping
**DO NOT** call a class a provider if it’s just formatting or computing things.
If no external service is involved → **it’s a helper**.

---

### 4. Interfaces (We Strongly Follow Interface Design)
We treat **interfaces as first-class citizens**.

#### 4.1 File Naming
- TypeScript: `.interface.ts`
  - `user-repository.interface.ts`
  - `sms-provider.interface.ts`
- Python: `_interface.py`
  - `user_repository_interface.py`
  - `sms_provider_interface.py`

#### 4.2 Interface Naming (Inside the File)
For TypeScript, pick **one** convention and stick to it:
- Prefer: `UserRepository` (no `I` prefix) **or** `IUserRepository` (with `I`)
  Choose one per codebase and enforce via linting.
In this playbook, we’ll assume:
- **TS Interfaces**: `IUserRepository`, `ISmsProvider`
- **Python Protocols / ABCs**: `UserRepository`, `SmsProvider`

#### 4.3 Rules
- Every **Repository, Service, Provider** should have:
  - An interface file: `.interface.ts` / `_interface.py`
  - An implementation file: `.service.ts`, `.repository.ts`, `.provider.ts`
- Controllers depend on **interfaces**, not implementations.
- Service Bus contracts should also have interfaces.

---

### 5. Module Files

#### 5.1 When to Use `module`
Use `module` suffix when:
- Defining a **NestJS module**.
- Grouping related routers/services in Python for clarity (optional but recommended in complex domains).
**Examples:**
- NestJS:
  - `user.module.ts`
  - `billing.module.ts`
- FastAPI (optional):
  - `user_module.py` (wires router, services, dependencies)
  - `billing_module.py`

---

### 6. NestJS-Specific Standards

#### 6.1 Controllers
- File: `.controller.ts`
- Class name: `<Domain>Controller`
  - `UserController`, `OrderController`
- Responsibilities:
  - Request validation (basic)
  - HTTP concerns (params, query, status codes)
  - Delegation to services
- Must **not** contain business logic.

#### 6.2 Services
- File: `.service.ts`
- Class name: `<Domain>Service`
- Responsibilities:
  - Orchestrate business logic
  - Call repositories, providers, service-bus
- No HTTP-related references (no `Request`, `Response` objects).

#### 6.3 Repositories
- File: `.repository.ts`
- Impl: `<Domain>Repository`
- Interface: `<domain>-repository.interface.ts`
- Only place where DB schema/ORM is directly used.

#### 6.4 DTOs
- File: `.dto.ts`
- Naming: `CreateUserDto`, `UpdateUserDto`, `UserResponseDto`
- Used exclusively for:
  - Controller input/output
  - External contracts (API boundaries)

#### 6.5 Providers
- File: `.provider.ts`
- Class: `<Integration>Provider`
- Must:
  - Handle errors from external systems
  - Map external errors to internal exceptions

#### 6.6 Common Technical Standards
- Use **async/await** consistently.
- Centralized error handling via **filters/interceptors**.
- Logging via a common `Logger` from the `common` module.
- Use **dependency injection** everywhere (no manual `new` in controllers).

---

### 7. FastAPI-Specific Standards

#### 7.1 Routers (Controllers Equivalent)
- File: `_controller.py` or `_router.py`
  (Pick one; we’ll assume `*_controller.py`.)
- Define an `APIRouter` per domain:
  - `user_controller.py` → `user_router`
- Responsibilities:
  - Define routes, deps, responses
  - Delegate to services

#### 7.2 Services
- File: `_service.py`
- Class: `<Domain>Service`
- Responsibilities identical to NestJS services:
  - Business logic
  - Call repositories, providers, service-bus

#### 7.3 Repositories
- File: `_repository.py`
- Class: `<Domain>Repository`
- Interface: `_repository_interface.py` (optional in Python, but recommended via `Protocol` or ABC)
- Use SQLAlchemy/ORM or direct DB drivers only here.

#### 7.4 Schemas / DTOs
- File: `_schemas.py` or `_dto.py`
  (Pick one pattern and stick to it. I’d recommend `*_schemas.py`.)
- Pydantic models:
  - `UserCreate`, `UserUpdate`, `UserRead`
- Used for:
  - Request bodies
  - Responses
  - FastAPI dependency outputs

#### 7.5 Providers & Helpers
- Same logic as above:
  - Integrations → `_provider.py`
  - Pure utilities → `_helper.py`

#### 7.6 Technical Standards
- Prefer **async** endpoints and **async** DB calls.
- Use FastAPI’s **dependency injection** (`Depends`) instead of global singletons.
- Centralize error handling via custom exception handlers.
- Avoid business logic in routers.

---

### 8. Modular Monolith–Specific Rules
These apply across both frameworks:
1. **No domain module imports another domain module directly.**
  - Use **Service Bus** for cross-domain communication.
1. Put **shared code** only under:
  - `/common`
  - `/service-bus`
1. Every module should be able to be extracted into its own microservice by:
  - Copying its folder
  - Copying shared `common` and `service-bus` as packages
1. Enforce naming rules in **code reviews**:
  - Wrong suffix? → reject PR.
  - Missing interface? → reject PR (where applicable).

---

### 9. Optional: Linting & Formatting (Recommended Defaults)
You can standardize per-stack:
- **NestJS / TypeScript**
  - ESLint + Prettier
  - Enforce:
    - File naming patterns
    - Import ordering
    - No unused imports / variables
- **FastAPI / Python**
  - Black (formatting)
  - Ruff or Flake8 (linting)
  - isort (import ordering)

---
